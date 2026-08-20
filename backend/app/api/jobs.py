"""Job endpoints: poll a job's status (with project summary)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import JobWithProjectResponse
from ..security import SessionUser, current_user

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}", response_model=JobWithProjectResponse)
def get_job(job_id: str, user: SessionUser = Depends(current_user)) -> dict:
    job = db.get_job_with_project(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Not found")
    if job["project"].get("user_id") != user.id:
        raise HTTPException(status_code=404, detail="Not found")
    return job
