"""Project endpoints: list, create, detail (with signed source/clip URLs), jobs."""

from __future__ import annotations

import logging
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import db
from ..schemas import (
    ClientRenderComplete,
    ClipResponse,
    JobResponse,
    ProjectCreate,
    ProjectDetail,
    ProjectListItem,
    RenderClipRequest,
    StartJobRequest,
    TrashListItem,
)
from ..security import SessionUser, current_user
from ..worker import QueueFull, pool
from core import billing, storage
from core.s3 import head_object_size_default_bucket as head_object_size_default_bucket

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


def _paywall(exc: billing.PaywallError) -> HTTPException:
    """Convert a billing soft-throttle into a 402 paywall response."""
    return HTTPException(status_code=402, detail=str(exc))


def _presigned(key: str | None) -> str | None:
    if not key:
        return None
    from core.s3 import presigned_get_url

    bucket = os.environ.get("S3_BUCKET", "")
    if not bucket:
        return None
    try:
        return presigned_get_url(bucket, key)
    except Exception:
        return None


@router.get("/{project_id}/source/stream")
def stream_source(project_id: str, request: Request, user: SessionUser = Depends(current_user)):
    """Same-origin proxy for the source video — avoids R2 CORS when bucket CORS
    is misconfigured. Supports Range requests so mediabunny can stream."""
    from fastapi.responses import StreamingResponse

    from core.s3 import _client, _get_bucket

    project = db.get_project_for_user(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Not found")
    key = project.get("source_key")
    if not key:
        raise HTTPException(status_code=404, detail="No source")
    client = _client()
    bucket = _get_bucket()
    range_header = request.headers.get("range")
    candidates = [key, f"testing-bucket/{key}", key.removeprefix("testing-bucket/")]
    obj = None
    last_exc: Exception | None = None
    status = 200
    for cand in dict.fromkeys(candidates):
        try:
            if range_header:
                obj = client.get_object(Bucket=bucket, Key=cand, Range=range_header)
                status = 206
            else:
                obj = client.get_object(Bucket=bucket, Key=cand)
                status = 200
            break
        except Exception as exc:
            last_exc = exc
            continue
    if obj is None:
        raise HTTPException(status_code=404, detail=str(last_exc) if last_exc else "Not found")
    headers: dict[str, str] = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"}
    if obj.get("ContentRange"):
        headers["Content-Range"] = obj["ContentRange"]
    if obj.get("ContentLength") is not None:
        headers["Content-Length"] = str(obj["ContentLength"])
    return StreamingResponse(
        obj["Body"].iter_chunks(chunk_size=1 << 20),
        status_code=status,
        media_type=obj.get("ContentType") or "video/mp4",
        headers=headers,
    )


@router.get("", response_model=list[ProjectListItem])
def list_projects(user: SessionUser = Depends(current_user)) -> list[dict]:
    # Lazy trash sweep: anything past its 30-day retention is permanently
    # deleted (rows + S3 objects) before we show the live list.
    _cleanup_expired_trash()
    _cleanup_stale_uploads()
    return db.list_projects_for_user(user.id)


@router.get("/trash", response_model=list[TrashListItem])
def list_trash(user: SessionUser = Depends(current_user)) -> list[dict]:
    _cleanup_expired_trash()
    _cleanup_stale_uploads()
    return db.list_trash_for_user(user.id)


def _cleanup_expired_trash() -> None:
    """Best-effort purge of expired trash; S3 removal is best-effort too."""
    try:
        for purged in db.purge_expired_trash():
            bucket = os.environ.get("S3_BUCKET", "")
            if bucket:
                from core.s3 import delete_object

                for key in purged["keys"]:
                    delete_object(bucket, key)
    except Exception as exc:  # never block listings on cleanup failures
        logger.warning("Trash purge failed: %s", exc)


def _cleanup_stale_uploads() -> None:
    """Best-effort purge of never-claimed upload keys (dead client renders,
    abandoned source uploads): drops their ledger rows and deletes any
    orphaned objects. Runs lazily next to the trash sweep."""
    try:
        keys = db.delete_stale_uploads()
        bucket = os.environ.get("S3_BUCKET", "")
        if not keys or not bucket:
            return
        from core.s3 import delete_object

        for key in keys:
            try:
                delete_object(bucket, key)
            except Exception as exc:  # one bad object can't stop the sweep
                logger.warning("Stale upload object delete failed (%s): %s", key, exc)
    except Exception as exc:  # never block listings on cleanup failures
        logger.warning("Stale upload purge failed: %s", exc)


@router.post("", response_model=ProjectListItem, status_code=201)
def create_project(payload: ProjectCreate, user: SessionUser = Depends(current_user)) -> dict:
    source = payload.source.strip()
    if not source:
        raise HTTPException(status_code=400, detail="source is required")

    # Soft-throttle project creation at the plan's project cap (read access
    # to existing projects is never blocked).
    try:
        billing.enforce_project_cap(user.id)
    except billing.PaywallError as exc:
        raise _paywall(exc) from exc

    source_type = "upload" if payload.source_type == "upload" else "youtube"
    title = (payload.title or "").strip() or "Untitled"

    # SSRF guard: remote sources must be YouTube links resolving to public
    # addresses. yt-dlp would otherwise fetch any URL from our network
    # position (cloud metadata, internal services).
    if source_type != "upload":
        from core.urlguard import UrlNotAllowed, validate_source_url

        try:
            validate_source_url(source)
        except UrlNotAllowed as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Determine the authoritative size of the uploaded object in S3, so a
    # client cannot bypass the cap by claiming ``source_size_bytes=0``.
    if source_type == "upload":
        real_size = head_object_size_default_bucket(source)
        if real_size is None:
            # Fall back to the client-provided size; if that is also absent
            # or zero we must reject because we cannot verify the upload.
            if not payload.source_size_bytes:
                raise HTTPException(
                    status_code=400,
                    detail="Could not verify uploaded file size; try re-uploading.",
                )
            real_size = payload.source_size_bytes
        elif real_size <= 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        size_bytes = real_size
    else:
        size_bytes = payload.source_size_bytes or 0

    if source_type == "upload" and size_bytes:
        # Enforce cap with the *real* size before persisting.
        try:
            storage.enforce_cap(user.id, size_bytes)
        except storage.StorageQuotaExceeded as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    project = db.create_project(user.id, title, source, source_type)

    # Per-request YouTube cookies from client after cookie-consent opt-in
    # (SO 75426272: must include HttpOnly via chrome.cookies). Stored
    # ephemerally as /tmp/youtube_cookies_{project_id}.txt for this single
    # analysis job and deleted after download (never persisted in DB).
    if source_type == "youtube" and getattr(payload, "youtube_cookies", None):
        cookies = (payload.youtube_cookies or "").strip()
        if cookies and ("youtube.com" in cookies.lower() or "youtu.be" in cookies.lower() or "# Netscape" in cookies):
            try:
                import pathlib

                p = pathlib.Path(f"/tmp/youtube_cookies_{project['id']}.txt")
                p.write_text(cookies, encoding="utf-8")
                p.chmod(0o600)
            except Exception as exc:
                logger.warning("Failed to store client cookies for %s: %s", project["id"], exc)

    if source_type == "upload":
        # Ownership proof: the key must have been presigned for THIS user
        # and never bound to another project. Prevents attaching someone
        # else's object and minting read URLs for it.
        if not db.claim_upload_for_project(source, user.id, project["id"]):
            raise HTTPException(
                status_code=400,
                detail="Unknown upload key. Re-upload the file and try again.",
            )

    if source_type == "upload" and size_bytes:
        db.update_project(
            project["id"],
            source_key=source,
            source_size_bytes=size_bytes,
            storage_bytes=size_bytes,
        )
        storage.add_storage(user.id, size_bytes)
    project["clip_count"] = 0
    project["latest_job"] = None
    return project


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(project_id: str, user: SessionUser = Depends(current_user)) -> dict:
    project = db.get_project_detail(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Not found")

    # The stored source video powers clip previews (browser seeks to the
    # clip's [start_time, end_time]). Expose a signed URL when available.
    project["source_video_url"] = _presigned(project.get("source_key"))

    for clip in project["clips"]:
        # Rendered file (only exists after a render job ran).
        clip["signed_video_url"] = _presigned(clip.get("video_url"))
        clip["signed_thumbnail_url"] = _presigned(clip.get("thumbnail_url"))
        # A clip may have a render job queued/running — surface it so the
        # UI can show progress and disable duplicate downloads.
        clip["render_job"] = db.find_active_render_job(clip["id"])
        # Which caption style (if any) produced the current video_url, so
        # the UI can show "rendered with: Classic" and let the user re-pick.
        clip["caption_style_id"] = None
        if clip.get("video_url"):
            last_render = db.get_latest_completed_render_job(clip["id"])
            if last_render:
                clip["caption_style_id"] = (last_render.get("options") or {}).get(
                    "caption_style_id"
                )

    return project


@router.post("/{project_id}/start", response_model=JobResponse, status_code=201)
def start_job(
    project_id: str,
    payload: StartJobRequest,
    user: SessionUser = Depends(current_user),
) -> dict:
    project = db.get_project_for_user(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Not found")

    if db.find_active_job(project_id) is not None:
        raise HTTPException(status_code=409, detail="A job is already running for this project")

    # Soft-throttle managed jobs once the credit balance runs out. BYOK users
    # (own keys, opt-in flag) are unmetered and skip this check. The pipeline
    # enforces the authoritative check again at analyze time.
    if billing.uses_managed(user.id):
        try:
            billing.enforce_credits(user.id)
        except billing.PaywallError as exc:
            raise _paywall(exc) from exc

    orientation = payload.orientation if payload.orientation in ("portrait", "landscape", "original") else "portrait"
    options = {
        "orientation": orientation,
        "max_clips": payload.max_clips,
        "min_clip_seconds": payload.min_clip_seconds,
        "max_clip_seconds": payload.max_clip_seconds,
    }

    job = db.create_job(project_id, options, job_type="analyze")
    db.update_project(project_id, status="queued")

    # In-process enqueue — no HTTP hop to a separate service needed now
    # that the API and the pipeline worker live in the same FastAPI app.
    # Backpressure: a full queue answers 429 instead of accepting unbounded
    # lag the VPS can't drain.
    try:
        pool.submit(job["id"])
    except QueueFull as exc:
        db.update_job(job["id"], status="failed", error="Queue full — please retry shortly.")
        db.update_project(project_id, status="idle")
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    return job


@router.post("/{project_id}/clips/{clip_id}/render", response_model=JobResponse, status_code=201)
def render_clip(
    project_id: str,
    clip_id: str,
    payload: RenderClipRequest,
    user: SessionUser = Depends(current_user),
) -> dict:
    """Enqueue cutting + uploading a single clip (on-demand download).

    When ``caption_style_id`` is supplied, the clip is re-rendered with that
    style even if it already has a rendered file (a new S3 variant replaces
    the current ``video_url``). A render without ``caption_style_id`` for an
    already-rendered clip is a no-op (409).
    """
    project = db.get_project_for_user(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Not found")

    clip = db.get_clip_for_user(clip_id, user.id)
    if clip is None:
        raise HTTPException(status_code=404, detail="Not found")

    # The clip must belong to the project in the path — the two lookups
    # above are owner-scoped but independent, so a same-user mismatch
    # would otherwise create a job cutting one video with another's timings.
    if clip.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Not found")

    # Validate the caption style exists AND is visible to this user
    # (built-in or their own custom style) before enqueueing.
    caption_style_id = payload.caption_style_id
    if caption_style_id:
        style = db.get_caption_style_visible_to(caption_style_id, user.id)
        if style is None:
            raise HTTPException(status_code=400, detail="Unknown caption style")

    if db.find_active_render_job(clip_id) is not None:
        raise HTTPException(status_code=409, detail="A render job is already running for this clip")

    # Already rendered with no requested change — nothing to do.
    if clip.get("video_url") and not caption_style_id:
        raise HTTPException(status_code=409, detail="Clip is already rendered")

    orientation = payload.orientation if payload.orientation in ("portrait", "landscape", "original") else "portrait"
    options = {"orientation": orientation}
    if caption_style_id:
        options["caption_style_id"] = caption_style_id

    job = db.create_job(project_id, options, job_type="render", clip_id=clip_id)
    try:
        pool.submit(job["id"])
    except QueueFull as exc:
        db.update_job(job["id"], status="failed", error="Queue full — please retry shortly.")
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return job


@router.post(
    "/{project_id}/clips/{clip_id}/client-render/presign", response_model=dict
)
def client_render_presign(
    project_id: str,
    clip_id: str,
    user: SessionUser = Depends(current_user),
) -> dict:
    """Presign a PUT for a browser-rendered clip file.

    Client-side rendering (WebCodecs) produces the mp4 in the browser; this
    hands the page a one-shot upload slot inside THIS clip's namespace and
    ledgers it, so the follow-up ``complete`` call can prove ownership —
    same security model as source uploads.
    """
    from core.s3 import S3Error, presign_put_url

    if db.get_project_for_user(project_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    if db.get_clip_for_user(clip_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Not found")

    # The backend never sees the bytes, so this is a headroom pre-check
    # only (mirrors /uploads/presign); the authoritative cap check happens
    # at ``complete`` with the real object size.
    if storage.storage_remaining(user.id) <= storage.UPLOAD_HEADROOM_BYTES:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Storage limit reached ({storage.storage_used(user.id)} of "
                f"{storage.storage_cap(user.id)} bytes used). Delete a project "
                "or buy a bigger credit pack to free up space."
            ),
        )

    key = f"projects/{project_id}/clips/{uuid.uuid4().hex}.mp4"
    try:
        url = presign_put_url(key, "video/mp4")
    except S3Error as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    db.record_upload(key, user.id, "video/mp4")
    return {"url": url, "key": key}


@router.post(
    "/{project_id}/clips/{clip_id}/client-render/complete",
    response_model=ClipResponse,
)
def client_render_complete(
    project_id: str,
    clip_id: str,
    payload: ClientRenderComplete,
    user: SessionUser = Depends(current_user),
) -> dict:
    """Register a browser-rendered clip file as the clip's rendered video.

    Validates that ``key`` was presigned to THIS user for THIS clip flow
    (ledger + single-use claim), then stamps ``clip.video_url`` and runs
    storage accounting exactly like a server render.
    """
    if db.get_project_for_user(project_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    clip = db.get_clip_for_user(clip_id, user.id)
    if clip is None or clip.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Not found")

    expected_prefix = f"projects/{project_id}/clips/"
    key = payload.key.strip()
    if not key.startswith(expected_prefix) or not key.endswith(".mp4"):
        raise HTTPException(status_code=400, detail="Invalid render key")
    from core.s3 import head_object_size_default_bucket

    size = head_object_size_default_bucket(key)
    if size is None:
        raise HTTPException(status_code=400, detail="Rendered file not found in storage")

    # Authoritative quota check with the real object size — the presign
    # headroom check can't see bytes. Mirrors the server render's
    # enforce_cap-before-accounting order (pipeline.py). Deliberately runs
    # BEFORE the single-use claim: on rejection the ledger row stays
    # unclaimed so the stale-upload sweep reclaims it along with the object.
    try:
        storage.enforce_cap(user.id, size)
    except storage.StorageQuotaExceeded as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if not db.claim_upload_for_project(key, user.id, project_id):
        raise HTTPException(status_code=400, detail="Unknown render upload")

    db.set_clip_video_url(clip_id, key)
    storage.add_project_storage(project_id, user.id, size)
    data = db.get_clip_for_user(clip_id, user.id) or {}
    data["signed_video_url"] = _presigned(key)
    return data


@router.post("/{project_id}/clips/{clip_id}/client-render/upload")
async def client_render_upload(
    project_id: str,
    clip_id: str,
    request: Request,
    user: SessionUser = Depends(current_user),
):
    """Same-origin upload fallback for browser-rendered clips — avoids R2 CORS
    on presigned PUT. Body is raw video/mp4 bytes; query ?key= must match the
    presigned key. Streams to R2 server-side then completes like the presign
    path. Used when direct PUT fails with CORS."""
    from core.s3 import _client, _get_bucket

    key = request.query_params.get("key", "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Missing key")
    expected_prefix = f"projects/{project_id}/clips/"
    if not key.startswith(expected_prefix) or not key.endswith(".mp4"):
        raise HTTPException(status_code=400, detail="Invalid render key")
    if db.get_project_for_user(project_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    if db.get_clip_for_user(clip_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty upload")
    try:
        storage.enforce_cap(user.id, len(body))
    except storage.StorageQuotaExceeded as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    try:
        client = _client()
        bucket = _get_bucket()
        client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="video/mp4")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"R2 upload failed: {exc}") from exc
    claimed = db.claim_upload_for_project(key, user.id, project_id)
    if not claimed:
        existing = db.get_upload(key)
        if not existing or existing.get("user_id") != user.id or existing.get("used_project_id") not in (None, project_id):
            raise HTTPException(status_code=400, detail="Unknown render upload")
    db.set_clip_video_url(clip_id, key)
    storage.add_project_storage(project_id, user.id, len(body))
    data = db.get_clip_for_user(clip_id, user.id) or {}
    data["signed_video_url"] = _presigned(key)
    return data


@router.post("/{project_id}/restore", response_model=ProjectListItem, status_code=200)
def restore_project(project_id: str, user: SessionUser = Depends(current_user)) -> dict:
    """Take a soft-deleted project out of the trash. Storage stays counted
    and the project keeps occupying the tier's project quota while trashed,
    so restoring is always possible within the retention window."""
    if db.get_deleted_project_for_user(project_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    db.restore_project(project_id)
    data = db.get_project_for_user(project_id, user.id)
    if data is None:  # defensive: restored row vanished
        raise HTTPException(status_code=404, detail="Not found")
    data["clip_count"] = len(db.get_project_detail(project_id, user.id).get("clips", []))
    data["latest_job"] = None
    return data


@router.delete("/{project_id}/purge", status_code=204, response_model=None)
def purge_project(project_id: str, user: SessionUser = Depends(current_user)) -> None:
    """Permanently delete a trashed project: drop the DB rows (clips/jobs/
    words cascade), release the owner's storage accounting and remove the
    S3 objects best-effort. This is how a user reclaims storage and project
    quota; it is not undoable."""
    from core.s3 import delete_object

    if db.get_deleted_project_for_user(project_id, user.id) is None:
        raise HTTPException(status_code=404, detail="Not found")

    purged = db.hard_delete_project(project_id)
    if purged:
        bucket = os.environ.get("S3_BUCKET", "")
        if bucket:
            for key in purged["keys"]:
                delete_object(bucket, key)


@router.delete("/{project_id}", status_code=204, response_model=None)
def delete_project(project_id: str, user: SessionUser = Depends(current_user)) -> None:
    """Soft-delete a project: stamp ``deleted_at`` so it moves to the trash.
    Rows and S3 objects are kept (storage usage and the project-quota count
    stay), so the project can be restored for 30 days before the lazy
    trash sweep purges it permanently."""
    project = db.get_project_for_user(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Not found")

    db.delete_project(project_id)
