"""Project endpoints: list, create, detail (with signed source/clip URLs), jobs."""

from __future__ import annotations

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
)
from ..security import SessionUser, current_user
from ..worker import pool

router = APIRouter(prefix="/projects", tags=["projects"])


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
    return db.list_projects_for_user(user.id)


@router.post("", response_model=ProjectListItem, status_code=201)
def create_project(payload: ProjectCreate, user: SessionUser = Depends(current_user)) -> dict:
    source = payload.source.strip()
    if not source:
        raise HTTPException(status_code=400, detail="source is required")
    source_type = "upload" if payload.source_type == "upload" else "youtube"
    title = (payload.title or "").strip() or "Untitled"

    project = db.create_project(user.id, title, source, source_type)
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

    orientation = payload.orientation if payload.orientation in ("portrait", "landscape", "original") else "portrait"
    options = {"orientation": orientation, "max_clips": payload.max_clips}

    job = db.create_job(project_id, options, job_type="analyze")
    db.update_project(project_id, status="queued")

    # In-process enqueue — no HTTP hop to a separate service needed now
    # that the API and the pipeline worker live in the same FastAPI app.
    pool.submit(job["id"])

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

    # Validate the caption style exists before enqueueing.
    caption_style_id = payload.caption_style_id
    if caption_style_id:
        style = db.get_caption_style(caption_style_id)
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
    pool.submit(job["id"])
    return job
