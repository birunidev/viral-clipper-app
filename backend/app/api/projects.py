"""Project endpoints: list, create, detail (with signed clip URLs), start job."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import (
    JobResponse,
    ProjectCreate,
    ProjectDetail,
    ProjectListItem,
    StartJobRequest,
)
from ..security import SessionUser, current_user
from ..worker import pool

router = APIRouter(prefix="/projects", tags=["projects"])


def _presigned(key: str | None) -> str | None:
    if not key:
        return None
    from core.s3 import presigned_get_url

    # Keys are stored without a bucket; the default bucket from S3_BUCKET
    # is used (mirrors the previous Next.js presignedGet behavior).
    import os

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

    for clip in project["clips"]:
        clip["signed_video_url"] = _presigned(clip.get("video_url"))
        clip["signed_thumbnail_url"] = _presigned(clip.get("thumbnail_url"))

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

    job = db.create_job(project_id, options)
    db.update_project(project_id, status="queued")

    # In-process enqueue — no HTTP hop to a separate service needed now
    # that the API and the pipeline worker live in the same FastAPI app.
    pool.submit(job["id"])

    return job
