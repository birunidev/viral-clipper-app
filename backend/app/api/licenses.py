"""Legacy ``/license/verify`` endpoint.

The desktop no longer uses license keys — it authenticates as a real
user via the new ``/auth/login`` flow and the server-side
``/entitlement/check`` gate.  This module is kept for backward
compatibility with older desktop builds (e.g. third parties who
bought before the migration) but is now **strictly DB-backed**:
no env-allowlist, no ``LICENSE_KEYS`` fallback.  Production
deployments must not set ``LICENSE_KEYS`` — there is no code path
that reads it any more.
"""
from __future__ import annotations

import os
import hashlib
import hmac
import datetime as dt

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import session_scope
from sqlalchemy import text

router = APIRouter(tags=["license"])

GRACE_DAYS = 30
SECRET = os.environ.get("LICENSE_SECRET", os.environ.get("APP_SECRET_KEY", "dev-secret-change-me"))


class LicenseVerifyRequest(BaseModel):
    licenseKey: str
    email: str | None = None
    deviceHash: str | None = None


def _sign(payload: str) -> str:
    return hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()


@router.post("/license/verify")
def verify_license(payload: LicenseVerifyRequest) -> dict:
    key = (payload.licenseKey or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="missing licenseKey")

    with session_scope() as session:
        row = session.execute(
            text(
                "SELECT license_key, email, is_valid, tier, expires_at "
                "FROM licenses WHERE license_key = :k LIMIT 1"
            ),
            {"k": key},
        ).mappings().first()
        if not row:
            return {
                "valid": False,
                "message": "unknown license",
                "signature": _sign(f'{{"licenseKey":"{key}","valid":false}}'),
                "expiresAt": None,
            }
        if not row["is_valid"]:
            return {
                "valid": False,
                "message": "license revoked",
                "signature": _sign(f'{{"licenseKey":"{key}","valid":false}}'),
                "expiresAt": None,
            }
        expires_at = row["expires_at"]
        if expires_at and expires_at < dt.datetime.now(dt.timezone.utc):
            return {
                "valid": False,
                "message": "license expired",
                "signature": _sign(f'{{"licenseKey":"{key}","valid":false}}'),
                "expiresAt": expires_at.isoformat() if expires_at else None,
            }
        expires = (
            dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=GRACE_DAYS)
        ).isoformat()
        tier = row["tier"] or "unlimited"
        return {
            "valid": True,
            "tier": tier,
            "signature": _sign(f'{{"licenseKey":"{key}","valid":true}}'),
            "expiresAt": expires,
            "email": row["email"],
        }


@router.get("/license/verify")
def verify_get() -> dict:
    return {"ok": True, "endpoint": "license/verify"}
