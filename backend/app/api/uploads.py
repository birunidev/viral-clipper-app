"""Upload endpoints: presigned S3 PUT URL for direct browser uploads."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException

from ..schemas import PresignRequest, PresignResponse
from ..security import SessionUser, current_user

router = APIRouter(prefix="/uploads", tags=["uploads"])

_EXT_RE = re.compile(r"\.([A-Za-z0-9]+)$")


@router.post("/presign", response_model=PresignResponse)
def presign_upload(
    payload: PresignRequest,
    user: SessionUser = Depends(current_user),
) -> dict:
    from core.s3 import S3Error, presign_put_url

    match = _EXT_RE.search(payload.file_name)
    ext = match.group(1).lower() if match else "bin"
    key = f"uploads/{uuid.uuid4().hex}.{ext}"

    try:
        url = presign_put_url(key, payload.content_type)
    except S3Error as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"url": url, "key": key}
