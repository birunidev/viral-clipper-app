"""Upload endpoints: presigned S3 PUT URL for direct browser uploads."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException

from ..schemas import PresignRequest, PresignResponse
from ..security import SessionUser, current_user
from core import storage

router = APIRouter(prefix="/uploads", tags=["uploads"])

_EXT_RE = re.compile(r"\.([A-Za-z0-9]+)$")


@router.post("/presign", response_model=PresignResponse)
def presign_upload(
    payload: PresignRequest,
    user: SessionUser = Depends(current_user),
) -> dict:
    from core.s3 import S3Error, presign_put_url

    # The backend never sees the bytes on a presigned PUT, so we can't know
    # the exact final size here. Reject up front only when the user has less
    # than a small headroom left — the authoritative check happens later at
    # project creation (source_size_bytes) and/or the analyze job.
    if storage.storage_remaining(user.id) <= storage.UPLOAD_HEADROOM_BYTES:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Storage limit reached ({storage.storage_used(user.id)} of "
                f"{storage.storage_cap(user.id)} bytes used). Delete a project "
                "or buy a bigger credit pack to free up space."
            ),
        )

    match = _EXT_RE.search(payload.file_name)
    ext = match.group(1).lower() if match else "bin"
    key = f"uploads/{uuid.uuid4().hex}.{ext}"

    try:
        url = presign_put_url(key, payload.content_type)
    except S3Error as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"url": url, "key": key}
