"""Licenses API (web) + entitlement check (desktop).

This is the only path through which the desktop app learns whether it's
licensed.  It is intentionally narrow:

  * Desktop:  POST /entitlement/check  -> 200 entitled OR 403 denied
  * Web:      GET/POST under /licenses + /devices (owner-scoped)

The license string is never sent to the desktop.  Device activations are
registered server-side and visible in the web UI so the user can revoke
a lost/stolen device from any browser.
"""
from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..schemas import (
    EntitlementCheckRequest,
    EntitlementCheckResponse,
    LicenseDevicesResponse,
    LicenseListResponse,
    LicenseSummary,
    DeviceSummary,
)
from ..security import SessionUser, current_user
from ..services import entitlements as ent_svc

router = APIRouter(tags=["licenses"])


# --------------------------------------------------------------- web (owner)

@router.get("/licenses/me", response_model=LicenseListResponse)
def list_my_licenses(user: SessionUser = Depends(current_user)) -> LicenseListResponse:
    rows = ent_svc.list_licenses_for_user(user.id)
    return LicenseListResponse(
        licenses=[
            LicenseSummary(
                id=r["id"],
                tier=r["tier"],
                is_active=r["is_active"],
                issued_at=r["issued_at"],
                reissued_at=r["reissued_at"],
                reissued_from_id=r["reissued_from_id"],
                device_count=r["device_count"],
            )
            for r in rows
        ]
    )


class RevokeRequest(BaseModel):
    reason: str | None = None


@router.post("/licenses/{license_id}/revoke")
def revoke_my_license(license_id: str, body: RevokeRequest, user: SessionUser = Depends(current_user)) -> dict:
    ok = ent_svc.revoke_license(license_id, user.id, body.reason)
    if not ok:
        raise HTTPException(status_code=404, detail="license not found")
    return {"ok": True}


@router.post("/licenses/{license_id}/reissue")
def reissue_my_license(license_id: str, user: SessionUser = Depends(current_user)) -> dict:
    new_id = ent_svc.reissue_license(license_id, user.id)
    if new_id is None:
        raise HTTPException(status_code=404, detail="license not found")
    return {"ok": True, "new_license_id": new_id}


@router.get("/licenses/{license_id}/devices", response_model=LicenseDevicesResponse)
def list_license_devices(license_id: str, user: SessionUser = Depends(current_user)) -> LicenseDevicesResponse:
    rows = ent_svc.list_devices_for_license(license_id, user.id)
    if rows is None:
        raise HTTPException(status_code=404, detail="license not found")
    return LicenseDevicesResponse(
        devices=[DeviceSummary(**r) for r in rows]
    )


@router.post("/devices/{device_id}/revoke")
def revoke_my_device(device_id: str, user: SessionUser = Depends(current_user)) -> dict:
    ok = ent_svc.revoke_device(device_id, user.id)
    if not ok:
        raise HTTPException(status_code=404, detail="device not found")
    return {"ok": True}


# ------------------------------------------------------------ desktop (check)

@router.post("/entitlement/check")
def entitlement_check(
    body: EntitlementCheckRequest,
    request: Request,
    user: SessionUser = Depends(current_user),
) -> EntitlementCheckResponse:
    """Desktop calls this on every launch (and every 6h).

    Returns 200 with an entitlement blob on success, 403 with a
    machine-readable ``reason`` on deny.  The response body is
    HMAC-signed (signed_blob) so the desktop can cache it for offline
    use; the signature is verified locally before the desktop trusts
    the cache.
    """
    # The current_user dep gives us the user_id, but the service expects
    # a User ORM object — re-fetch lightweight fields.
    from sqlalchemy import select

    from ..database import session_scope
    from ..models import User

    with session_scope() as session:
        row = session.execute(
            select(User).where(User.id == user.id)
        ).scalars().first()
        if row is None:
            raise HTTPException(status_code=401, detail="not authenticated")
        result = ent_svc.resolve_entitlement(
            user=row,
            device_id=body.device_id,
            device_name=body.device_name,
            os=body.os,
        )

    if not result["ok"]:
        # Shape the 403 response.  The desktop parses ``reason`` to decide
        # which UI to show (no_license -> "buy a license"; device_limit ->
        # "revoke a device on the web").
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=403,
            content={
                "entitled": False,
                "reason": result["reason"],
                "max_devices": result.get("max_devices", 0),
                "current_device_count": result.get("current_device_count", 0),
            },
        )
    payload = result["payload"]
    return EntitlementCheckResponse(
        entitled=True,
        tier=payload["tier"],
        max_devices=payload["max_devices"],
        current_device_count=payload["current_device_count"],
        expires_at=payload["expires_at"],
        credits=payload["credits"],
        cloud_enabled=payload["cloud_enabled"],
        server_time=dt.datetime.fromisoformat(payload["server_time"]),
        cache_max_age_days=payload["cache_max_age_days"],
        signed_blob=result["signed_blob"],
    )
