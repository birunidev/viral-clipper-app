"""Dev-only test endpoints.

Gated on ``DEBUG=1`` so they're never reachable in production.  The
smoke-test script uses these to:

  * seed a license for an arbitrary email (bypasses the real Paddle/
    Midtrans webhook)
  * pull a raw password-reset token out of the DB (bypasses the SMTP
    inbox)
  * simulate a Paddle/Midtrans settlement: grant credits, spend
    credits, inspect the wallet ledger

All flows are 404 in production; the gates make them harmless when
``DEBUG`` is unset / 0.
"""
from __future__ import annotations

import datetime as dt
import os
import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from ..database import session_scope
from ..models import (
    PasswordResetToken,
    User,
)
from ..security import hash_password
from ..services.entitlements import (
    credits_balance_minutes,
    grant_credits,
    grant_license_bundle_if_first_license,
    grant_license_for_user,
    list_credit_ledger,
    spend_credits,
)

router = APIRouter(prefix="/dev/_test", tags=["dev"])


def _enabled() -> bool:
    return os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


def _gate() -> None:
    if not _enabled():
        raise HTTPException(status_code=404, detail="not found")


def _ensure_user(session, email: str) -> User:
    """Look up the user by email; auto-provision if missing.

    Auto-provisioning exists so the smoke test can run end-to-end
    without a real ``/auth/register`` (and without the email
    verification gate).  The hashed password is fixed and only
    intended for local smoke runs.
    """
    u = session.execute(
        select(User).where(User.email == email)
    ).scalars().first()
    if u is not None:
        return u
    u = User(
        id=uuid.uuid4().hex,
        email=email,
        password_hash=hash_password("dev-password-12345"),
        terms_accepted_at=dt.datetime.now(dt.timezone.utc),
    )
    session.add(u)
    session.flush()
    return u


@router.get("/seed-license")
def seed_license(email: str, plan: str = "unlimited") -> dict:
    """Create (or fetch) an active License + Entitlement for ``email``.

    Returns ``{ ok, user_id, license_id, entitlement_id, already_existed }``.
    Idempotent: re-running with the same email is a no-op.
    """
    _gate()
    email = email.strip().lower()
    with session_scope() as session:
        u = _ensure_user(session, email)
        user_id = u.id
    license_id, entitlement_id = grant_license_for_user(user_id, tier=plan)
    return {
        "ok": True,
        "user_id": user_id,
        "license_id": license_id,
        "entitlement_id": entitlement_id,
    }


@router.post("/grant-license")
def grant_license(email: str, plan: str = "unlimited") -> dict:
    """Simulate the Paddle/Midtrans webhook settlement that grants a
    desktop license.  Returns ``{ ok, user_id, license_id, entitlement_id,
    bundle_id_or_null }``.

    Idempotent on the license path; the one-time 60-min cloud credit
    bundle is only granted the first time the user gets a license.
    """
    _gate()
    email = email.strip().lower()
    with session_scope() as session:
        u = _ensure_user(session, email)
        user_id = u.id
    license_id, entitlement_id = grant_license_for_user(user_id, tier=plan)
    bundle_id = grant_license_bundle_if_first_license(user_id)
    return {
        "ok": True,
        "user_id": user_id,
        "license_id": license_id,
        "entitlement_id": entitlement_id,
        "bundle_id": bundle_id,
    }


@router.post("/purchase-credits")
def purchase_credits(
    email: str,
    amount_minutes: int,
    source: str = "dev_seed",
    order_id: str | None = None,
) -> dict:
    """Simulate a Paddle/Midtrans credit topup.  ``amount_minutes`` is
    the user-facing credit count; we store it as ``minutes * 10``
    deciminutes.  Idempotent on ``(source, order_id)`` when
    ``order_id`` is provided.
    """
    _gate()
    if amount_minutes <= 0:
        raise HTTPException(status_code=400, detail="amount_minutes must be > 0")
    email = email.strip().lower()
    with session_scope() as session:
        u = _ensure_user(session, email)
        user_id = u.id
    row_id = grant_credits(
        user_id=user_id,
        amount_dm=int(amount_minutes) * 10,
        source=source,
        order_id=order_id,
        plan_key=f"dev:{source}:{order_id or amount_minutes}",
        note=f"Dev test purchase {amount_minutes} min ({source})",
    )
    return {
        "ok": True,
        "user_id": user_id,
        "ledger_id": row_id,
        "balance_minutes": credits_balance_minutes(user_id),
    }


@router.post("/spend-credits")
def spend_credits_endpoint(
    email: str,
    amount_minutes: int,
    purpose: str = "transcribe",
    job_id: str | None = None,
) -> dict:
    """Simulate a cloud API spend (transcription, LLM).  Returns
    ``{ ok, user_id, balance_minutes }`` or 402 when the balance is
    too low.
    """
    _gate()
    if amount_minutes <= 0:
        raise HTTPException(status_code=400, detail="amount_minutes must be > 0")
    email = email.strip().lower()
    with session_scope() as session:
        u = _ensure_user(session, email)
        user_id = u.id
    ok = spend_credits(
        user_id=user_id,
        amount_dm=int(amount_minutes) * 10,
        purpose=purpose,
        job_id=job_id,
        note=f"Dev test spend {amount_minutes} min ({purpose})",
    )
    if not ok:
        raise HTTPException(status_code=402, detail="Insufficient credits")
    return {
        "ok": True,
        "user_id": user_id,
        "balance_minutes": credits_balance_minutes(user_id),
    }


@router.get("/wallet")
def wallet(email: str) -> dict:
    """Inspect the credit wallet: balance + the most recent income /
    spend rows.
    """
    _gate()
    email = email.strip().lower()
    with session_scope() as session:
        u = _ensure_user(session, email)
        user_id = u.id
    return {"ok": True, "user_id": user_id, **list_credit_ledger(user_id)}


@router.get("/reset-link")
def reset_link(email: str) -> dict:
    """Return the most recent unused + unexpired password-reset token for
    ``email``.  Used by the smoke script to complete the magic-link flow
    without an SMTP server.
    """
    _gate()
    email = email.strip().lower()
    with session_scope() as session:
        u = session.execute(
            select(User).where(User.email == email)
        ).scalars().first()
        if u is None:
            raise HTTPException(status_code=404, detail="user not found")
        row = session.execute(
            select(PasswordResetToken)
            .where(
                PasswordResetToken.user_id == u.id,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.expires_at > dt.datetime.now(dt.timezone.utc),
            )
            .order_by(PasswordResetToken.created_at.desc())
            .limit(1)
        ).scalars().first()
        if row is None:
            raise HTTPException(status_code=404, detail="no active reset token")
        # We only stored the SHA-256; the raw value isn't recoverable.
        # In dev mode the SMTP fallback already printed it to stdout —
        # the smoke script reads it from there.  This endpoint just
        # confirms the token exists and returns its metadata.
        return {
            "ok": True,
            "user_id": u.id,
            "token_id": row.id,
            "expires_at": row.expires_at.isoformat(),
        }
