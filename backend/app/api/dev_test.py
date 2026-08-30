"""Dev-only test endpoints.

Gated on ``DEBUG=1`` so they're never reachable in production.  The
smoke-test script uses these to:

  * seed a license for an arbitrary email (bypasses the real Paddle/
    Midtrans webhook)
  * pull a raw password-reset token out of the DB (bypasses the SMTP
    inbox)

Both flows are exposed in production as well-meaning but the gates
make them harmless: when ``DEBUG`` is unset / 0, every endpoint here
returns 404.
"""
from __future__ import annotations

import datetime as dt
import os

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from ..database import session_scope
from ..models import PasswordResetToken, User
from ..services.entitlements import grant_license_for_user

router = APIRouter(prefix="/dev/_test", tags=["dev"])


def _enabled() -> bool:
    return os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


def _gate() -> None:
    if not _enabled():
        raise HTTPException(status_code=404, detail="not found")


@router.get("/seed-license")
def seed_license(email: str, plan: str = "unlimited") -> dict:
    """Create (or fetch) an active License + Entitlement for ``email``.

    Returns ``{ ok, user_id, license_id, entitlement_id, already_existed }``.
    Idempotent: re-running with the same email is a no-op.
    """
    _gate()
    email = email.strip().lower()
    with session_scope() as session:
        u = session.execute(
            select(User).where(User.email == email)
        ).scalars().first()
        if u is None:
            # Auto-provision a user so the smoke test can run end-to-end
            # without a real /auth/register call (and without the email
            # verification gate).
            from ..security import hash_password

            u = User(
                id=__import__("uuid").uuid4().hex,
                email=email,
                password_hash=hash_password("dev-password-12345"),
                terms_accepted_at=dt.datetime.now(dt.timezone.utc),
            )
            session.add(u)
            session.flush()
            user_id = u.id
            existed = False
        else:
            user_id = u.id
            existed = True
    license_id, entitlement_id = grant_license_for_user(user_id, tier=plan)
    return {
        "ok": True,
        "user_id": user_id,
        "license_id": license_id,
        "entitlement_id": entitlement_id,
        "already_existed": existed,
    }


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
