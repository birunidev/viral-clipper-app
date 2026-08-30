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
import hmac
import os
import time
import uuid
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from ..database import session_scope
from ..models import AppUpdate
from ..ratelimit import RateLimitExceeded, limiter
from ..security import SESSION_COOKIE, SessionUser, get_user_from_session

router = APIRouter(tags=["updates"])

ALLOWED_PLATFORMS = {"win32", "darwin", "linux"}
ALLOWED_ARCHES = {"ia32", "x64", "arm64"}
ALLOWED_CHANNELS = {"stable", "beta"}
ADMIN_EMAILS_ENV = "CLIPZARD_ADMIN_EMAILS"
ADMIN_TOKEN_ENV = "CLIPZARD_ADMIN_TOKEN"
# Secret used to sign the optional ?sig=…&exp=… query on /update/download.
# If unset, signed URLs are disabled (the download URL is the static,
# rate-limited /update/download endpoint, which is fine — Caddy already
# rate-limits these per IP).
DOWNLOAD_SIGN_SECRET_ENV = "CLIPZARD_DOWNLOAD_SIGN_SECRET"


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
    signed = _download_signed_url(update.platform, update.arch, update.version, base)
    download_url = signed or f"{base}/api/v1/update/download?platform={update.platform}&arch={update.arch}&version={update.version}"
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

    This is a JSON convenience endpoint mirroring the YAML feed below
    (used by the web admin UI's check-URL preview, third-party tools, and
    legacy Electron builds that pre-date the YAML feed).
    """
    # Rate-limit check calls (60/IP/min) — Electron's 6h cadence is
    # trivially under this, but a misbehaving client can't drain S3.
    try:
        limiter.check(f"check:{request.client.host}", limit=60, window_seconds=60)
    except RateLimitExceeded as e:
        raise HTTPException(status_code=429, detail=f"rate limited, retry in {e.retry_after}s")

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


@router.get("/update-feed/{platform}/{arch}/{channel}.yml")
def feed_yml(
    request: Request,
    platform: str,
    arch: str,
    channel: str,
):
    """Serve an ``electron-updater``-compatible YAML feed.

    The generic provider of ``electron-updater`` fetches
    ``${baseUrl}/<channel>.yml`` and parses the YAML the same way as the
    GitHub releases feed.  We generate the YAML on-the-fly from the
    ``app_updates`` table -- picking the newest published version for the
    requested ``(platform, arch, channel)``.

    404 when no version has been published for the combination yet.
    """
    try:
        limiter.check(f"feed:{request.client.host}", limit=60, window_seconds=60)
    except RateLimitExceeded as e:
        raise HTTPException(status_code=429, detail=f"rate limited, retry in {e.retry_after}s")

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
            .where(
                AppUpdate.platform == platform,
                AppUpdate.arch == arch,
                AppUpdate.is_beta == is_beta,
            )
        ).scalars().all()
        if not rows:
            raise HTTPException(status_code=404, detail="no published update for this platform/arch/channel")
        best = max(rows, key=lambda r: _parse_version(r.version))

        base = str(request.base_url).rstrip("/")
        signed = _download_signed_url(platform, arch, best.version, base)
        download_url = signed or f"{base}/api/v1/update/download?platform={platform}&arch={arch}&version={best.version}"
        binary_name = f"clipzard-{platform}-{arch}-{best.version}.bin"

        # Match the YAML schema emitted by `electron-builder publish`.
        # `path` is the legacy single-file field; `files[]` is what the
        # generic provider actually consumes.
        yml = (
            f"version: {best.version}\n"
            f"files:\n"
            f"  - url: {download_url}\n"
            f"    sha512: {best.sha512 or ''}\n"
            f"    size: {int(best.size_bytes or 0)}\n"
            f"path: {download_url}\n"
            f"sha512: {best.sha512 or ''}\n"
            f"releaseDate: '{best.created_at.isoformat() if best.created_at else ''}'\n"
        )
        if best.release_notes:
            # Embed notes in the YAML; electron-updater exposes them via info.releaseNotes
            safe = (best.release_notes or "").replace("\r", "").replace("\n", "\\n")
            yml += f"releaseNotes: '{safe}'\n"
        if is_beta:
            yml += "isBeta: true\n"

    from fastapi import Response
    return Response(
        content=yml,
        media_type="application/x-yaml; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


def _download_signed_url(
    platform: str,
    arch: str,
    version: str,
    base_url: str,
    ttl_seconds: int = 3600,
) -> str:
    """Generate a HMAC-SHA256 signed download URL with expiry."""
    secret = os.environ.get(DOWNLOAD_SIGN_SECRET_ENV, "").strip()
    if not secret:
        # Unsigned fallback: the static URL with Caddy rate-limit is sufficient.
        return ""
    exp = int(time.time()) + ttl_seconds
    payload = f"{platform}:{arch}:{version}:{exp}"
    sig = hmac.new(secret.encode(), payload.encode(), "sha256").hexdigest()
    return (
        f"{base_url}/api/v1/update/download"
        f"?platform={platform}&arch={arch}&version={version}"
        f"&exp={exp}&sig={sig}"
    )


def _verify_download_signature(
    platform: str,
    arch: str,
    version: str,
    exp: str | None,
    sig: str | None,
) -> bool:
    """Verify HMAC-SHA256 signature on a download URL.  Returns True if
    valid or if signing is disabled (no secret set).  Raises 403 if stale."""
    secret = os.environ.get(DOWNLOAD_SIGN_SECRET_ENV, "").strip()
    if not secret or not sig:
        # Signing disabled — Caddy rate-limit is the guard.
        return True
    if not exp:
        raise HTTPException(status_code=403, detail="missing exp")
    try:
        exp_int = int(exp)
    except ValueError:
        raise HTTPException(status_code=403, detail="invalid exp")
    if time.time() > exp_int:
        raise HTTPException(status_code=403, detail="URL expired")
    payload = f"{platform}:{arch}:{version}:{exp_int}"
    expected = hmac.new(secret.encode(), payload.encode(), "sha256").hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=403, detail="invalid signature")
    return True


@router.get("/update/download")
def download_update(
    request: Request,
    platform: str = Query(...),
    arch: str = Query(...),
    version: str = Query(...),
    exp: str = Query(default=None),
    sig: str = Query(default=None),
):
    """Stream the S3 binary for ``(platform, arch, version)``.

    Supports optional HMAC-SHA256 signed URLs (set ``CLIPZARD_DOWNLOAD_SIGN_SECRET``):
    the ``sig`` and ``exp`` query params are verified before streaming.
    Without a secret the static URL is rate-limited by Caddy and is safe enough.

    Streams via FastAPI so the client never sees S3 credentials.
    """
    if platform not in ALLOWED_PLATFORMS or arch not in ALLOWED_ARCHES:
        raise HTTPException(status_code=400, detail="invalid platform/arch")

    # Rate-limit: 60 downloads / IP / minute (Caddy is the primary guard;
    # this is a second layer in case a request bypasses Caddy).
    try:
        limiter.check(f"dl:{request.client.host}", limit=60, window_seconds=60)
    except RateLimitExceeded as e:
        raise HTTPException(status_code=429, detail=f"rate limited, retry in {e.retry_after}s")

    _verify_download_signature(platform, arch, version, exp, sig)

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
        "Cache-Control": "no-store",  # never cache binaries
        "X-Update-Version": row.version,
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
def list_updates(request: Request, _: SessionUser = Depends(_require_admin)):
    """Admin-only: list all published updates (most recent first)."""
    try:
        limiter.check(f"list:{request.client.host}", limit=120, window_seconds=60)
    except RateLimitExceeded as e:
        raise HTTPException(status_code=429, detail=f"rate limited, retry in {e.retry_after}s")
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
    request: Request,
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
    # Tight rate-limit: 1 upload / IP / 5 min (admins only; the binary
    # is huge — never let a bug loop drain S3).
    try:
        limiter.check(f"upload:{request.client.host}", limit=1, window_seconds=300)
    except RateLimitExceeded as e:
        raise HTTPException(status_code=429, detail=f"rate limited, retry in {e.retry_after}s")

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

