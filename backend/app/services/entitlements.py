"""Entitlement service: the single source of truth for desktop access.

The desktop authenticates as a user, then calls ``/entitlement/check`` on
every launch (and every 6h) to confirm they have an active license and
that the device they're on counts toward their seat.  This module owns:

  * Looking up the user's active ``Entitlement`` row
  * Pruning devices that haven't checked in for 30 days (frees seats)
  * Registering / refreshing the current ``DeviceActivation`` row
  * Enforcing the per-license ``max_devices`` cap
  * Building the HMAC-signed ``signed_blob`` the desktop caches for
    offline use
  * The cloud **credit wallet** (separate from the desktop license):
    ``credit_ledger`` (income) + ``credit_spend`` (spend), reconciled
    in the same transaction as the ``User.credits`` cache column.

The function ``resolve_entitlement`` is the single entry point used by
both the ``/entitlement/check`` endpoint and the dev-mode
``/_test/seed-license`` helper, so the smoke script exercises exactly
the same code path the production endpoint does.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import secrets
import uuid
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..database import session_scope
from ..models import (
    CREDIT_SOURCE_LICENSE_BUNDLE,
    CreditLedger,
    CreditSpend,
    DeviceActivation,
    Entitlement,
    License,
    User,
)


# Stale-device cutoff: a device not seen for 30 days is auto-revoked
# so the user's seat count reflects what they actually use.
STALE_DEVICE_DAYS = 30
# Default device cap if a pack doesn't set one on the entitlement row.
DEFAULT_MAX_DEVICES = 3
# Default offline cache lifetime (server-side fallback).
DEFAULT_CACHE_MAX_AGE_DAYS = 7


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _signing_secret() -> str:
    """Return the HMAC secret for the offline entitlement blob.  If unset,
    the blob is unsigned and the desktop will refuse to use the cache."""
    return os.environ.get("ENTITLEMENT_SIGN_SECRET", "").strip()


def _sign_blob(payload: dict) -> str:
    """Return ``HMAC-SHA256(secret, canonical_json(payload))`` as hex.

    Canonical JSON: sorted keys, no whitespace, UTF-8.  This is what the
    desktop reproduces locally before trusting the cache.
    """
    secret = _signing_secret()
    if not secret:
        return ""
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), body, "sha256").hexdigest()


def _credits_for(user_id: str) -> int:
    """Look up the user's current credit balance.  We pull this from the
    same place the billing module does (``core.billing``); for the smoke
    test we degrade gracefully when the column is missing or the module
    isn't available."""
    try:
        from ..core import billing as _billing

        status = _billing.billing_status(user_id)
        if isinstance(status, dict):
            return int(status.get("credits") or 0)
    except Exception:
        pass
    return 0


def _prune_stale_devices(session, user_id: str) -> int:
    """Auto-revoke devices that haven't checked in for STALE_DEVICE_DAYS.

    Returns the number of devices that were pruned.
    """
    cutoff = _now() - dt.timedelta(days=STALE_DEVICE_DAYS)
    rows = session.execute(
        select(DeviceActivation)
        .where(
            DeviceActivation.user_id == user_id,
            DeviceActivation.is_revoked == False,  # noqa: E712
            DeviceActivation.last_seen_at < cutoff,
        )
    ).scalars().all()
    for r in rows:
        r.is_revoked = True
    return len(rows)


def _active_device_count(session, user_id: str) -> int:
    rows = session.execute(
        select(DeviceActivation)
        .where(DeviceActivation.user_id == user_id, DeviceActivation.is_revoked == False)  # noqa: E712
    ).scalars().all()
    return len(rows)


def _find_active_entitlement(session, user_id: str) -> Optional[Entitlement]:
    rows = session.execute(
        select(Entitlement)
        .where(Entitlement.user_id == user_id, Entitlement.is_active == True)  # noqa: E712
        .order_by(Entitlement.created_at.desc())
        .limit(1)
    ).scalars().all()
    return rows[0] if rows else None


def _upsert_device(session, ent: Entitlement, device_id: str, device_name: str, os: str) -> tuple[DeviceActivation, bool]:
    """Create or refresh the DeviceActivation row for this user+device.

    Returns ``(row, created)``.  Existing rows keep their ``id`` and
    ``created_at`` — only ``last_seen_at`` (and possibly ``device_name``
    / ``os``) gets refreshed.
    """
    row = session.execute(
        select(DeviceActivation).where(
            DeviceActivation.user_id == ent.user_id,
            DeviceActivation.device_id == device_id,
        )
    ).scalars().first()
    if row is None:
        row = DeviceActivation(
            id=uuid.uuid4().hex,
            user_id=ent.user_id,
            device_id=device_id,
            device_name=device_name[:120],
            os=os[:16],
            last_seen_at=_now(),
            is_revoked=False,
        )
        session.add(row)
        return row, True
    row.last_seen_at = _now()
    row.is_revoked = False  # re-auth on a previously-revoked device un-revokes
    row.device_name = device_name[:120]
    row.os = os[:16]
    return row, False


def resolve_entitlement(user: User, device_id: str, device_name: str, os: str) -> dict:
    """Main entry point: returns one of two shapes.

    On success::

        {"ok": True, "payload": {entitled, tier, ...}, "signed_blob": "..."}

    On deny::

        {"ok": False, "reason": "no_license" | "device_limit" | "revoked",
         "max_devices": 3, "current_device_count": 4}
    """
    with session_scope() as session:
        _prune_stale_devices(session, user.id)
        ent = _find_active_entitlement(session, user.id)
        if ent is None:
            return {
                "ok": False,
                "reason": "no_license",
                "max_devices": DEFAULT_MAX_DEVICES,
                "current_device_count": 0,
            }
        # Check if the device is already registered (in which case it's
        # not counted toward the cap again).
        existing = session.execute(
            select(DeviceActivation).where(
                DeviceActivation.user_id == user.id,
                DeviceActivation.device_id == device_id,
            )
        ).scalars().first()
        is_new_device = existing is None
        if is_new_device:
            active = _active_device_count(session, user.id)
            if active >= ent.max_devices:
                return {
                    "ok": False,
                    "reason": "device_limit",
                    "max_devices": ent.max_devices,
                    "current_device_count": active,
                }
        # Register / refresh the device.
        _upsert_device(session, ent, device_id, device_name, os)
        session.flush()
        active = _active_device_count(session, user.id)
        credits = _credits_for(user.id)
        server_time = _now()
        payload = {
            "entitled": True,
            "tier": ent.tier,
            "max_devices": int(ent.max_devices),
            "current_device_count": active,
            "expires_at": None,  # one-time purchase, no per-check expiry
            "credits": credits,
            "cloud_enabled": credits > 0,
            "server_time": server_time.isoformat(),
            "cache_max_age_days": int(ent.cache_max_age_days or DEFAULT_CACHE_MAX_AGE_DAYS),
        }
        signed = _sign_blob(payload)
        return {"ok": True, "payload": payload, "signed_blob": signed}


def grant_license_for_user(user_id: str, tier: str = "unlimited", max_devices: int = DEFAULT_MAX_DEVICES) -> tuple[str, str]:
    """Idempotent helper used by both the Paddle/Midtrans webhooks and the
    dev-only ``/_test/seed-license`` endpoint.  Returns ``(license_id, entitlement_id)``,
    creating both rows if they don't exist.  Safe to call repeatedly.
    """
    with session_scope() as session:
        # Try to find an existing license for this user at this tier.
        existing_lic = session.execute(
            select(License).where(License.user_id == user_id, License.tier == tier, License.is_valid == True).order_by(License.created_at.desc()).limit(1)  # noqa: E712
        ).scalars().first()
        if existing_lic is None:
            existing_lic = License(
                id=uuid.uuid4().hex,
                license_key=f"LIC-{secrets.token_urlsafe(16)}",
                email=None,
                user_id=user_id,
                is_valid=True,
                tier=tier,
                expires_at=None,
                meta={"source": "seed-or-webhook"},
            )
            session.add(existing_lic)
            session.flush()
        # Check for an existing active entitlement on this license.
        existing_ent = session.execute(
            select(Entitlement).where(
                Entitlement.license_id == existing_lic.id,
                Entitlement.is_active == True,  # noqa: E712
            )
        ).scalars().first()
        if existing_ent is not None:
            return existing_lic.id, existing_ent.id
        ent = Entitlement(
            id=uuid.uuid4().hex,
            user_id=user_id,
            license_id=existing_lic.id,
            tier=tier,
            max_devices=max_devices,
            is_active=True,
            cache_max_age_days=DEFAULT_CACHE_MAX_AGE_DAYS,
        )
        session.add(ent)
        session.flush()
        return existing_lic.id, ent.id


def revoke_license(license_id: str, owner_user_id: str, reason: Optional[str] = None) -> bool:
    """Revoke a license and all of its devices.  Returns False if the
    license doesn't belong to the owner (caller should 404)."""
    with session_scope() as session:
        lic = session.execute(
            select(License).where(License.id == license_id, License.user_id == owner_user_id)
        ).scalars().first()
        if lic is None:
            return False
        ents = session.execute(
            select(Entitlement).where(Entitlement.license_id == license_id, Entitlement.is_active == True)  # noqa: E712
        ).scalars().all()
        now = _now()
        for e in ents:
            e.is_active = False
            e.revoked_at = now
            e.revoked_reason = reason
        # Mark all devices under this user as revoked.
        devs = session.execute(
            select(DeviceActivation).where(
                DeviceActivation.user_id == owner_user_id,
                DeviceActivation.is_revoked == False,  # noqa: E712
            )
        ).scalars().all()
        for d in devs:
            d.is_revoked = True
        return True


def reissue_license(license_id: str, owner_user_id: str) -> Optional[str]:
    """Create a new license + entitlement replacing the old one.  Old
    devices are revoked; old row gets ``reissued_at`` and a backref.
    Returns the new ``license_id`` (or None if the original didn't belong
    to the owner)."""
    with session_scope() as session:
        old = session.execute(
            select(License).where(License.id == license_id, License.user_id == owner_user_id)
        ).scalars().first()
        if old is None:
            return None
        now = _now()
        # Stamp the old row.
        old.reissued_at = now
        old.is_valid = False
        # Revoke the old entitlement and its devices.
        ents = session.execute(
            select(Entitlement).where(Entitlement.license_id == license_id, Entitlement.is_active == True)  # noqa: E712
        ).scalars().all()
        for e in ents:
            e.is_active = False
            e.revoked_at = now
            e.revoked_reason = "reissued"
        devs = session.execute(
            select(DeviceActivation).where(
                DeviceActivation.user_id == owner_user_id,
                DeviceActivation.is_revoked == False,  # noqa: E712
            )
        ).scalars().all()
        for d in devs:
            d.is_revoked = True
        # Create the replacement.
        new_lic = License(
            id=uuid.uuid4().hex,
            license_key=f"LIC-{secrets.token_urlsafe(16)}",
            email=old.email,
            user_id=old.user_id,
            is_valid=True,
            tier=old.tier,
            expires_at=old.expires_at,
            meta={"source": "reissue", "from": license_id},
            reissued_from_id=old.id,
        )
        session.add(new_lic)
        session.flush()
        new_ent = Entitlement(
            id=uuid.uuid4().hex,
            user_id=old.user_id,
            license_id=new_lic.id,
            tier=old.tier,
            max_devices=ents[0].max_devices if ents else DEFAULT_MAX_DEVICES,
            is_active=True,
            cache_max_age_days=ents[0].cache_max_age_days if ents else DEFAULT_CACHE_MAX_AGE_DAYS,
        )
        session.add(new_ent)
        session.flush()
        return new_lic.id


def list_licenses_for_user(user_id: str) -> list[dict]:
    with session_scope() as session:
        rows = session.execute(
            select(License, Entitlement).outerjoin(
                Entitlement, Entitlement.license_id == License.id
            ).where(License.user_id == user_id).order_by(License.created_at.desc())
        ).all()
        out: list[dict] = []
        for lic, ent in rows:
            # Count active devices for this user (a single entitlement
            # across all licenses of this user).
            active = session.execute(
                select(DeviceActivation).where(
                    DeviceActivation.user_id == user_id,
                    DeviceActivation.is_revoked == False,  # noqa: E712
                )
            ).scalars().all()
            out.append({
                "id": lic.id,
                "tier": lic.tier,
                "is_active": bool(ent and ent.is_active),
                "issued_at": lic.created_at,
                "reissued_at": lic.reissued_at,
                "reissued_from_id": lic.reissued_from_id,
                "device_count": len(active),
            })
        return out


def list_devices_for_license(license_id: str, owner_user_id: str) -> list[dict] | None:
    """Return the user's devices if the license belongs to them, else None."""
    with session_scope() as session:
        lic = session.execute(
            select(License).where(License.id == license_id, License.user_id == owner_user_id)
        ).scalars().first()
        if lic is None:
            return None
        rows = session.execute(
            select(DeviceActivation).where(DeviceActivation.user_id == owner_user_id).order_by(DeviceActivation.last_seen_at.desc())
        ).scalars().all()
        return [
            {
                "id": r.id,
                "device_id": r.device_id,
                "device_name": r.device_name,
                "os": r.os,
                "last_seen_at": r.last_seen_at,
                "is_revoked": bool(r.is_revoked),
            }
            for r in rows
        ]


def revoke_device(device_id_internal: str, owner_user_id: str) -> bool:
    """Revoke a single device.  Returns False if the device doesn't
    belong to the owner (caller should 404)."""
    with session_scope() as session:
        row = session.execute(
            select(DeviceActivation).where(
                DeviceActivation.id == device_id_internal,
                DeviceActivation.user_id == owner_user_id,
            )
        ).scalars().first()
        if row is None:
            return False
        row.is_revoked = True
        return True


# ============================================================================
# Cloud credit wallet (separate from the desktop license).
#
#   balance_dm(user) = SUM(ledger.amount_dm) - SUM(spend.amount_dm)
#
# All amounts are in **deciminutes** (1 minute = 10 units).  Storage
# stays integer so cloud-transcription rounding (ceil to 0.1 min) is
# lossless.  The denormalized ``User.credits`` column (whole minutes) is
# updated inside the same transaction as the ledger/spend insert so
# ``/auth/me`` and ``/billing/status`` reads see a consistent value.
#
# Concurrency: ``spend_credits`` takes a Postgres advisory lock keyed
# on the user_id hash before reading-then-writing the balance, so two
# concurrent transcriber jobs cannot both succeed when only one has
# the balance.
# ============================================================================


# Free cloud minutes granted the first time a user buys a desktop license.
LICENSE_BUNDLE_CREDITS_DM = 600  # 60 minutes


def _user_advisory_lock_key(user_id: str) -> int:
    """Stable 63-bit lock key from a user id (Postgres advisory lock)."""
    import hashlib as _h
    digest = _h.sha1(user_id.encode("utf-8")).digest()[:8]
    # Mask the sign bit to stay in Postgres' bigint range.
    return int.from_bytes(digest, "big", signed=False) & 0x7FFFFFFFFFFFFFFF


def credits_balance_dm(user_id: str) -> int:
    """Current cloud credit balance in deciminutes (may be negative? no — clamp at 0)."""
    if not user_id:
        return 0
    with session_scope() as session:
        income = session.execute(
            select(func.coalesce(func.sum(CreditLedger.amount_dm), 0))
            .where(
                CreditLedger.user_id == user_id,
                # Exclude expired bundles
                (CreditLedger.expires_at.is_(None))
                | (CreditLedger.expires_at > func.now()),
            )
        ).scalar_one()
        spent = session.execute(
            select(func.coalesce(func.sum(CreditSpend.amount_dm), 0))
            .where(CreditSpend.user_id == user_id)
        ).scalar_one()
    bal = int(income) - int(spent)
    return max(0, bal)


def credits_balance_minutes(user_id: str) -> int:
    """Same as :func:`credits_balance_dm` but in whole minutes (floor).
    Matches the existing ``User.credits`` semantics so the API surface
    and the cache column stay in step."""
    return credits_balance_dm(user_id) // 10


def _sync_user_credits_cache(session, user_id: str) -> None:
    """Recompute the denormalized ``User.credits`` cache column (whole
    minutes) and stamp it.  Caller must pass the same session that owns
    the ledger/spend insert so the read-after-write is consistent."""
    income = session.execute(
        select(func.coalesce(func.sum(CreditLedger.amount_dm), 0))
        .where(
            CreditLedger.user_id == user_id,
            (CreditLedger.expires_at.is_(None))
            | (CreditLedger.expires_at > func.now()),
        )
    ).scalar_one()
    spent = session.execute(
        select(func.coalesce(func.sum(CreditSpend.amount_dm), 0))
        .where(CreditSpend.user_id == user_id)
    ).scalar_one()
    new_minutes = max(0, (int(income) - int(spent)) // 10)
    user_row = session.get(User, user_id)
    if user_row is not None:
        user_row.credits = new_minutes


def grant_credits(
    user_id: str,
    amount_dm: int,
    source: str,
    order_id: str | None = None,
    plan_key: str | None = None,
    note: str | None = None,
    expires_at: dt.datetime | None = None,
) -> str:
    """Add ``amount_dm`` deciminutes to the user's wallet.  Idempotent on
    ``(source, order_id)`` so a redelivered webhook is a no-op.

    Returns the ledger row id.  Updates the ``User.credits`` cache
    column inside the same transaction.
    """
    if amount_dm <= 0:
        raise ValueError("amount_dm must be > 0")
    with session_scope() as session:
        existing = None
        if order_id:
            existing = session.execute(
                select(CreditLedger).where(
                    CreditLedger.source == source,
                    CreditLedger.order_id == order_id,
                )
            ).scalars().first()
        if existing is not None:
            # Idempotent re-delivery: do nothing.
            return existing.id
        row_id = uuid.uuid4().hex
        try:
            session.add(CreditLedger(
                id=row_id,
                user_id=user_id,
                amount_dm=int(amount_dm),
                source=source,
                order_id=order_id,
                plan_key=plan_key,
                expires_at=expires_at,
                note=note,
            ))
            session.flush()
        except IntegrityError:
            # Race: another concurrent request inserted the same
            # (source, order_id) pair.  Treat as idempotent.
            session.rollback()
            return row_id
        _sync_user_credits_cache(session, user_id)
        return row_id


def spend_credits(
    user_id: str,
    amount_dm: int,
    purpose: str,
    job_id: str | None = None,
    note: str | None = None,
) -> bool:
    """Subtract ``amount_dm`` deciminutes from the user's wallet.  Returns
    True on success, False if the balance is too low.  Concurrency-safe
    via a Postgres advisory lock keyed on the user id.

    The spend is recorded in ``credit_spend`` and the ``User.credits``
    cache is updated in the same transaction.
    """
    if amount_dm <= 0:
        raise ValueError("amount_dm must be > 0")
    if not user_id:
        return False
    with session_scope() as session:
        # Per-user lock: serialise all credit operations for this user
        # so concurrent transcriber jobs can't both succeed when only
        # one has the balance. Guard for SQLite (Electron) where pg_advisory is absent.
        try:
            # Only on Postgres
            if session.bind and session.bind.url.drivername.startswith("postgresql"):
                session.execute(
                    select(func.pg_advisory_xact_lock(_user_advisory_lock_key(user_id)))
                )
        except Exception:
            pass
        income = session.execute(
            select(func.coalesce(func.sum(CreditLedger.amount_dm), 0))
            .where(
                CreditLedger.user_id == user_id,
                (CreditLedger.expires_at.is_(None))
                | (CreditLedger.expires_at > func.now()),
            )
        ).scalar_one()
        spent = session.execute(
            select(func.coalesce(func.sum(CreditSpend.amount_dm), 0))
            .where(CreditSpend.user_id == user_id)
        ).scalar_one()
        balance = int(income) - int(spent)
        if balance < amount_dm:
            return False
        session.add(CreditSpend(
            id=uuid.uuid4().hex,
            user_id=user_id,
            amount_dm=int(amount_dm),
            purpose=purpose,
            job_id=job_id,
            note=note,
        ))
        session.flush()
        _sync_user_credits_cache(session, user_id)
        return True


def grant_license_bundle_if_first_license(user_id: str) -> str | None:
    """The one-time 60-minute cloud credit bundle the first desktop license
    comes with.  Idempotent: returns the ledger row id on the first
    grant, or ``None`` if the user already has a bundle (or already has
    another active ``license_bundle`` row, which we treat as the
    "received the bundle" signal)."""
    with session_scope() as session:
        already = session.execute(
            select(CreditLedger.id)
            .where(
                CreditLedger.user_id == user_id,
                CreditLedger.source == CREDIT_SOURCE_LICENSE_BUNDLE,
            )
            .limit(1)
        ).scalars().first()
        if already is not None:
            return None
    return grant_credits(
        user_id=user_id,
        amount_dm=LICENSE_BUNDLE_CREDITS_DM,
        source=CREDIT_SOURCE_LICENSE_BUNDLE,
        plan_key="license_bundle",
        note="One-time 60-min cloud credit bundle on first desktop license",
    )


def list_credit_ledger(user_id: str, limit: int = 50) -> list[dict]:
    """Audit view: most-recent income + spend rows for the wallet."""
    with session_scope() as session:
        income = session.execute(
            select(CreditLedger)
            .where(CreditLedger.user_id == user_id)
            .order_by(CreditLedger.created_at.desc())
            .limit(limit)
        ).scalars().all()
        spend = session.execute(
            select(CreditSpend)
            .where(CreditSpend.user_id == user_id)
            .order_by(CreditSpend.created_at.desc())
            .limit(limit)
        ).scalars().all()
    return {
        "balance_minutes": credits_balance_minutes(user_id),
        "ledger": [
            {
                "id": r.id,
                "amount_minutes": r.amount_dm / 10,
                "amount_dm": int(r.amount_dm),
                "source": r.source,
                "order_id": r.order_id,
                "plan_key": r.plan_key,
                "expires_at": r.expires_at.isoformat() if r.expires_at else None,
                "note": r.note,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in income
        ],
        "spend": [
            {
                "id": r.id,
                "amount_minutes": r.amount_dm / 10,
                "amount_dm": int(r.amount_dm),
                "purpose": r.purpose,
                "job_id": r.job_id,
                "note": r.note,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in spend
        ],
    }

