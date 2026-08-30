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

from sqlalchemy import select

from ..database import session_scope
from ..models import (
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
