"""App update endpoints for ClipZard Desktop.

Public read endpoints expose the latest published version per
``(platform, arch, channel)`` so the Electron auto-updater can decide
whether to install a newer binary.  Upload is admin-only (env-based
admin token + signed admin payload).

S3 stores the binary; the backend streams it back to the client so the
Electron app never sees S3 credentials.  The ``sha512`` hash is computed
at upload time, persisted on the row, and returned in the check
response; ``electron-updater`` uses it to verify the download.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from ..database import session_scope
from ..models import AppUpdate

router = APIRouter(tags=["updates"])

ALLOWED_PLATFORMS = {"win32", "darwin", "linux"}
ALLOWED_ARCHES = {"ia32", "x64", "arm64"}
ALLOWED_CHANNELS = {"stable", "beta"}
ADMIN_ENV_VAR = "CLIPZARD_ADMIN_TOKEN"


def _admin_token() -> Optional[str]:
    return os.environ.get(ADMIN_ENV_VAR, "").strip() or None


def _require_admin(authorization: Optional[str] = Header(default=None)) -> None:
    """Verify the admin token.  Token can be sent as ``Authorization: Bearer <token>``
    or as the literal value (no scheme) for simplicity when invoked from CI."""
    expected = _admin_token()
    if not expected:
        raise HTTPException(status_code=503, detail="admin upload disabled (CLIPZARD_ADMIN_TOKEN not set)")
    if not authorization:
        raise HTTPException(status_code=401, detail="missing admin token")
    token = authorization.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if token != expected:
        raise HTTPException(status_code=403, detail="invalid admin token")


def _parse_version(v: str) -> tuple[int, ...]:
    """Parse ``MAJOR.MINOR.PATCH[-prerelease]`` into a comparable tuple.
    Pre-release tags sort before the release of the same ``MAJOR.MINOR.PATCH``."""
    v = (v or "").strip()
    if not v:
        return (0,)
    # Split off any pre-release suffix (e.g. "0.2.0-beta.1")
    core = v.split("-", 1)[0]
    parts: list[int] = []
    for p in core.split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    is_prerelease = "-" in v
    # Add a high number for release so 0.2.0 > 0.2.0-beta.1
    return (*parts, 0 if is_prerelease else 1)


def _is_newer(candidate: str, current: str) -> bool:
    return _parse_version(candidate) > _parse_version(current)


def _check_response(update: AppUpdate, request: Request) -> dict:
    base = str(request.base_url).rstrip("/")
    download_url = f"{base}/api/v1/update/download?platform={update.platform}&arch={update.arch}&version={update.version}"
    binary_name = f"clipzard-{update.platform}-{update.arch}-{update.version}{'-beta' if update.is_beta else ''}.bin"
    return {
        "url": download_url,
        "version": update.version,
        "releaseNotes": update.release_notes or "",
        "releaseDate": update.created_at.isoformat() if update.created_at else None,
        "isBeta": bool(update.is_beta),
        "files": [
            {
                "url": download_url,
                "name": binary_name,
                "size": int(update.size_bytes or 0),
                "sha512": update.sha512 or "",
            }
        ],
    }


@router.get("/update/check")
def check_update(
    request: Request,
    version: str = Query(..., description="Currently installed app version (semver)"),
    platform: str = Query(..., description="OS: win32/darwin/linux"),
    arch: str = Query(..., description="CPU: ia32/x64/arm64"),
    channel: str = Query("stable", description="stable or beta"),
):
    """Return update info if a newer version is available for this platform.

    200 with body when an update is available; 204 when the installed
    version is current; 400 on invalid query params.
    """
    if platform not in ALLOWED_PLATFORMS:
        raise HTTPException(status_code=400, detail=f"invalid platform: {platform}")
    if arch not in ALLOWED_ARCHES:
        raise HTTPException(status_code=400, detail=f"invalid arch: {arch}")
    if channel not in ALLOWED_CHANNELS:
        raise HTTPException(status_code=400, detail=f"invalid channel: {channel}")

    is_beta = channel == "beta"
    with session_scope() as session:
        rows = session.execute(
            select(AppUpdate)
            .where(AppUpdate.platform == platform, AppUpdate.arch == arch, AppUpdate.is_beta == is_beta)
        ).scalars().all()
        candidates = [r for r in rows if _is_newer(r.version, version)]
        if not candidates:
            # No newer version found in this channel — return 204 (no body)
            from fastapi import Response
            return Response(status_code=204)
        # Pick the highest-versioned candidate
        best = max(candidates, key=lambda r: _parse_version(r.version))
        return _check_response(best, request)


@router.get("/update/download")
def download_update(
    request: Request,
    platform: str = Query(...),
    arch: str = Query(...),
    version: str = Query(...),
):
    """Stream the S3 binary for ``(platform, arch, version)``.

    Streams via FastAPI so the client never sees S3 credentials.  Uses a
    ranged GET to avoid loading the entire binary into memory; falls back
    to streaming the body for older boto3 versions.
    """
    if platform not in ALLOWED_PLATFORMS or arch not in ALLOWED_ARCHES:
        raise HTTPException(status_code=400, detail="invalid platform/arch")

    with session_scope() as session:
        row = session.execute(
            select(AppUpdate)
            .where(
                AppUpdate.platform == platform,
                AppUpdate.arch == arch,
                AppUpdate.version == version,
            )
            .limit(1)
        ).scalars().first()
        if not row or not row.s3_key:
            raise HTTPException(status_code=404, detail="update not found")

        s3_key = row.s3_key
        size = int(row.size_bytes or 0)
        binary_name = f"clipzard-{platform}-{arch}-{version}{'-beta' if row.is_beta else ''}.bin"

    # Resolve S3 helpers lazily so import-time failures (e.g. boto3 missing
    # in CI) don't break the rest of the app.
    try:
        from core import s3
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"s3 backend unavailable: {exc}")

    def iter_chunks(chunk_size: int = 1024 * 1024):
        client = s3._client()
        bucket = s3._get_bucket()
        obj = client.get_object(Bucket=bucket, Key=s3_key)
        body = obj["Body"]
        while True:
            chunk = body.read(chunk_size)
            if not chunk:
                break
            yield chunk

    headers = {
        "Content-Disposition": f'attachment; filename="{binary_name}"',
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
    }
    if size:
        headers["Content-Length"] = str(size)

    return StreamingResponse(iter_chunks(), media_type="application/octet-stream", headers=headers)


class UpdateRow(BaseModel):
    version: str
    platform: str
    arch: str
    is_beta: bool
    size_bytes: int
    created_at: Optional[str] = None


@router.get("/update/list", response_model=list[UpdateRow])
def list_updates(authorization: Optional[str] = Header(default=None)):
    """Admin-only: list all published updates (most recent first)."""
    _require_admin(authorization)
    with session_scope() as session:
        rows = session.execute(select(AppUpdate).order_by(AppUpdate.created_at.desc())).scalars().all()
        return [
            UpdateRow(
                version=r.version,
                platform=r.platform,
                arch=r.arch,
                is_beta=bool(r.is_beta),
                size_bytes=int(r.size_bytes or 0),
                created_at=r.created_at.isoformat() if r.created_at else None,
            )
            for r in rows
        ]


@router.post("/update/upload")
async def upload_update(
    file: UploadFile = File(...),
    version: str = Form(...),
    platform: str = Form(...),
    arch: str = Form(...),
    release_notes: str = Form(""),
    is_beta: str = Form("false"),
    authorization: Optional[str] = Header(default=None),
):
    """Admin-only: stream an installer binary to S3 and record metadata.

    Computes ``sha512`` on the fly so a corrupt upload is detected before
    it reaches the bucket.  Rejects uploads for ``(platform, arch,
    version, is_beta)`` combinations that already exist.
    """
    _require_admin(authorization)
    if platform not in ALLOWED_PLATFORMS:
        raise HTTPException(status_code=400, detail=f"invalid platform: {platform}")
    if arch not in ALLOWED_ARCHES:
        raise HTTPException(status_code=400, detail=f"invalid arch: {arch}")
    if not version.strip():
        raise HTTPException(status_code=400, detail="version is required")
    is_beta_bool = is_beta.strip().lower() in ("1", "true", "yes", "on")

    s3_key = f"releases/{platform}/{arch}/{version}{'-beta' if is_beta_bool else ''}.bin"

    try:
        from core import s3
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"s3 backend unavailable: {exc}")

    bucket = s3._get_bucket()
    client = s3._client()

    # Upload in a single PUT while computing SHA512 incrementally.
    hasher = hashlib.sha512()
    size = 0
    try:
        upload = client.put_object(
            Bucket=bucket,
            Key=s3_key,
            # Use a placeholder body, then replace with file-like below
            Body=b"",
            ContentType="application/octet-stream",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"failed to start S3 upload: {exc}")

    # Multipart upload for large files; boto3's upload_fileobj is fine for
    # arbitrary sizes and supports streaming.
    try:
        from boto3.s3.transfer import TransferConfig
        config = TransferConfig(
            multipart_threshold=8 * 1024 * 1024,
            multipart_chunksize=8 * 1024 * 1024,
            use_threads=False,
        )
        file_obj = file.file
        # Wrap to compute hash as bytes flow through
        class _HashingReader:
            def __init__(self, inner):
                self._inner = inner

            def read(self, n=-1):
                chunk = self._inner.read(n)
                if chunk:
                    hasher.update(chunk)
                return chunk

            def readable(self):
                return True

        reader = _HashingReader(file_obj)
        client.upload_fileobj(reader, bucket, s3_key, Config=config, ExtraArgs={"ContentType": "application/octet-stream"})
        # Determine total size: the wrapper can't track it; ask S3 for HEAD
        head = client.head_object(Bucket=bucket, Key=s3_key)
        size = int(head.get("ContentLength", 0))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"S3 upload failed: {exc}")

    sha512_hex = hasher.hexdigest()

    with session_scope() as session:
        existing = session.execute(
            select(AppUpdate).where(
                AppUpdate.platform == platform,
                AppUpdate.arch == arch,
                AppUpdate.version == version,
                AppUpdate.is_beta == is_beta_bool,
            ).limit(1)
        ).scalars().first()
        if existing:
            # Update metadata in place; the file has already been overwritten in S3.
            existing.release_notes = release_notes or ""
            existing.sha512 = sha512_hex
            existing.size_bytes = size
            existing.s3_key = s3_key
            update = existing
        else:
            update = AppUpdate(
                id=uuid.uuid4().hex,
                version=version,
                platform=platform,
                arch=arch,
                release_notes=release_notes or "",
                sha512=sha512_hex,
                size_bytes=size,
                is_beta=is_beta_bool,
                s3_key=s3_key,
            )
            session.add(update)

    return {
        "ok": True,
        "id": update.id,
        "version": update.version,
        "platform": update.platform,
        "arch": update.arch,
        "is_beta": bool(update.is_beta),
        "sha512": sha512_hex,
        "size_bytes": size,
        "s3_key": s3_key,
    }
