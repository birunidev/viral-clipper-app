"""Project endpoints: list, create, detail (with signed source/clip URLs), jobs."""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import (
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


@router.get("", response_model=list[ProjectListItem])
def list_projects(user: SessionUser = Depends(current_user)) -> list[dict]:
    # Lazy trash sweep: anything past its 30-day retention is permanently
    # deleted (rows + S3 objects) before we show the live list.
    _cleanup_expired_trash()
    return db.list_projects_for_user(user.id)


@router.get("/trash", response_model=list[TrashListItem])
def list_trash(user: SessionUser = Depends(current_user)) -> list[dict]:
    _cleanup_expired_trash()
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
