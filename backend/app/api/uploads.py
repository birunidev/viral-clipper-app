"""Upload endpoints: presigned S3 PUT URL for direct browser uploads."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import PresignRequest, PresignResponse
from ..security import SessionUser, current_user
from core import storage

router = APIRouter(prefix="/uploads", tags=["uploads"])

_EXT_RE = re.compile(r"\.([A-Za-z0-9]+)$")

# Video containers accepted for source uploads. Anything else is rejected —
# the bucket is a video workspace, not a general file host.
ALLOWED_EXTENSIONS = {
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
    "webm": "video/webm",
    "avi": "video/x-msvideo",
    "m4v": "video/x-m4v",
}


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
    ext = match.group(1).lower() if match else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload MP4, MOV, MKV, WebM or AVI.",
        )
    content_type = ALLOWED_EXTENSIONS[ext]
    key = f"uploads/{uuid.uuid4().hex}.{ext}"

    try:
        url = presign_put_url(key, content_type)
    except S3Error as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # Ownership ledger: project creation later proves this key belongs to
    # the caller before binding it (single-use).
    db.record_upload(key, user.id, content_type)

    return {"url": url, "key": key}
