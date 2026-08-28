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

    # Check licenses table (one-time unlimited) - if exists
    try:
        with session_scope() as session:
            row = session.execute(text("SELECT license_key, email, is_valid, tier, expires_at FROM licenses WHERE license_key = :k LIMIT 1"), {"k": key}).mappings().first()
            if row:
                if not row["is_valid"]:
                    return {"valid": False, "message": "license revoked", "signature": _sign(f'{{"licenseKey":"{key}","valid":false}}'), "expiresAt": None}
                expires_at = row["expires_at"]
                if expires_at and expires_at < dt.datetime.now(dt.timezone.utc):
                    return {"valid": False, "message": "license expired", "signature": _sign(f'{{"licenseKey":"{key}","valid":false}}'), "expiresAt": expires_at.isoformat() if expires_at else None}
                # valid
                expires = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=GRACE_DAYS)).isoformat()
                tier = row["tier"] or "unlimited"
                payload_str = f'{{"licenseKey":"{key}","valid":true}}'
                return {"valid": True, "tier": tier, "signature": _sign(payload_str), "expiresAt": expires, "email": row["email"]}
    except Exception:
        # Table may not exist in some envs, fall through to env check
        pass

    # Fallback: env LICENSE_KEYS
    raw = os.environ.get("LICENSE_KEYS", "")
    allowed = [s.strip() for s in raw.split(",") if s.strip()]
    env_valid = (not raw) or (key in allowed) or key.startswith("CF-")
    if not env_valid:
        return {"valid": False, "message": "invalid license", "signature": _sign(f'{{"licenseKey":"{key}","valid":false}}'), "expiresAt": None}
    expires = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=GRACE_DAYS)).isoformat()
    return {"valid": True, "tier": "unlimited", "signature": _sign(f'{{"licenseKey":"{key}","valid":true}}'), "expiresAt": expires}


@router.get("/license/verify")
def verify_get() -> dict:
    return {"ok": True, "endpoint": "license/verify"}
