"""App update endpoints for ClipZard Desktop.

Public read endpoints expose the latest published version per
``(platform, arch, channel)`` so the Electron auto-updater can decide
whether to install a newer binary.  Upload is admin-only — admins are
identified either by ``CLIPZARD_ADMIN_EMAILS`` (comma-separated allowlist
matched against the logged-in user's email) or by a static
``CLIPZARD_ADMIN_TOKEN`` (used by the CI upload CLI).

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

from fastapi import APIRouter, Cookie, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from ..database import session_scope
from ..models import AppUpdate
from ..security import SESSION_COOKIE, SessionUser, get_user_from_session

router = APIRouter(tags=["updates"])

ALLOWED_PLATFORMS = {"win32", "darwin", "linux"}
ALLOWED_ARCHES = {"ia32", "x64", "arm64"}
ALLOWED_CHANNELS = {"stable", "beta"}
ADMIN_EMAILS_ENV = "CLIPZARD_ADMIN_EMAILS"
ADMIN_TOKEN_ENV = "CLIPZARD_ADMIN_TOKEN"


def _admin_emails() -> set[str]:
    raw = os.environ.get(ADMIN_EMAILS_ENV, "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _admin_token() -> Optional[str]:
    return os.environ.get(ADMIN_TOKEN_ENV, "").strip() or None


def _is_admin_user(user: Optional[SessionUser]) -> bool:
    if user is None or not user.email:
        return False
    return user.email.lower() in _admin_emails()


def _require_admin(
    request: Request,
    session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    authorization: Optional[str] = Header(default=None),
) -> SessionUser:
    """Admin check with two paths:

    1. **Session-cookie path** (web UI): the request must include a
       valid session whose email is in ``CLIPZARD_ADMIN_EMAILS``.
    2. **Bearer-token path** (CI/CLI): ``Authorization: Bearer <token>``
       matching ``CLIPZARD_ADMIN_TOKEN`` (kept for backwards compatibility).
    """
    expected_token = _admin_token()
    if expected_token and authorization:
        token = authorization.strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        if token == expected_token:
            # Synthetic admin principal — token auth does not bind a user.
            return SessionUser(id="__token__", email="__token__", name="admin-token")
    # Fall back to session-cookie auth
    user = get_user_from_session(session)
    if _is_admin_user(user):
        return user
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    raise HTTPException(status_code=403, detail="Admin access required")


def _parse_version(v: str) -> tuple[int, ...]:
    """Parse ``MAJOR.MINOR.PATCH[-prerelease]`` into a comparable tuple.
    Pre-release tags sort before the release of the same ``MAJOR.MINOR.PATCH``."""
    v = (v or "").strip()
    if not v:
        return (0,)
    core = v.split("-", 1)[0]
    parts: list[int] = []
    for p in core.split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    is_prerelease = "-" in v
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
            from fastapi import Response
            return Response(status_code=204)
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

    Streams via FastAPI so the client never sees S3 credentials.
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
    id: str
    version: str
    platform: str
    arch: str
    is_beta: bool
    size_bytes: int
    sha512: str
    release_notes: str
    s3_key: str
    created_at: Optional[str] = None


@router.get("/update/admin-status")
def admin_status(
    session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    """Returns whether the current session is an admin (for nav visibility)."""
    user = get_user_from_session(session)
    return {
        "is_admin": _is_admin_user(user),
        "email": user.email if user else None,
        "admin_emails_configured": bool(_admin_emails()),
    }


@router.get("/update/list", response_model=list[UpdateRow])
def list_updates(_: SessionUser = Depends(_require_admin)):
    """Admin-only: list all published updates (most recent first)."""
    with session_scope() as session:
        rows = session.execute(select(AppUpdate).order_by(AppUpdate.created_at.desc())).scalars().all()
        return [
            UpdateRow(
                id=r.id,
                version=r.version,
                platform=r.platform,
                arch=r.arch,
                is_beta=bool(r.is_beta),
                size_bytes=int(r.size_bytes or 0),
                sha512=r.sha512 or "",
                release_notes=r.release_notes or "",
                s3_key=r.s3_key or "",
                created_at=r.created_at.isoformat() if r.created_at else None,
            )
            for r in rows
        ]


@router.delete("/update/{update_id}")
def delete_update(update_id: str, _: SessionUser = Depends(_require_admin)):
    """Admin-only: delete an update record and its S3 object."""
    from core import s3
    with session_scope() as session:
        row = session.execute(
            select(AppUpdate).where(AppUpdate.id == update_id).limit(1)
        ).scalars().first()
        if not row:
            raise HTTPException(status_code=404, detail="update not found")
        s3_key = row.s3_key
        if s3_key:
            try:
                s3.delete_object(s3._get_bucket(), s3_key)
            except Exception as e:
                print(f"[updates] failed to delete S3 object {s3_key}: {e}")
        session.delete(row)
    return {"ok": True}


@router.post("/update/upload")
async def upload_update(
    file: UploadFile = File(...),
    version: str = Form(...),
    platform: str = Form(...),
    arch: str = Form(...),
    release_notes: str = Form(""),
    is_beta: str = Form("false"),
    _: SessionUser = Depends(_require_admin),
):
    """Admin-only: stream an installer binary to S3 and record metadata.

    Computes ``sha512`` on the fly so a corrupt upload is detected before
    it reaches the bucket.  Upserts on ``(platform, arch, version, is_beta)``;
    uploading the same combination again overwrites the previous binary.
    """
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

    hasher = hashlib.sha512()
    size = 0
    try:
        from boto3.s3.transfer import TransferConfig
        config = TransferConfig(
            multipart_threshold=8 * 1024 * 1024,
            multipart_chunksize=8 * 1024 * 1024,
            use_threads=False,
        )

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

        reader = _HashingReader(file.file)
        s3._client().upload_fileobj(
            reader,
            s3._get_bucket(),
            s3_key,
            Config=config,
            ExtraArgs={"ContentType": "application/octet-stream"},
        )
        head = s3._client().head_object(Bucket=s3._get_bucket(), Key=s3_key)
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

