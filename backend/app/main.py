"""ClipForge backend: FastAPI job service for the viral clipping engine."""

from __future__ import annotations

import os
import threading

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import db, pipeline

INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "")

app = FastAPI(title="ClipForge Backend")

if FRONTEND_URL:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[FRONTEND_URL],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


class JobCreate(BaseModel):
    jobId: str


def require_api_key(
    x_internal_api_key: str | None = Header(default=None),
):
    if not INTERNAL_API_KEY or x_internal_api_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid internal API key")
    return True


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "clipforge-backend"}


@app.post("/jobs", dependencies=[Depends(require_api_key)])
def start_job(payload: JobCreate) -> dict:
    job_id = payload.jobId
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") in ("running", "completed"):
        raise HTTPException(
            status_code=409, detail=f"Job already started ({job.get('status')})"
        )
    db.update_job(job_id, status="queued")
    thread = threading.Thread(target=pipeline.run_job, args=(job_id,), daemon=True)
    thread.start()
    return {"status": "queued", "jobId": job_id}


@app.get("/jobs/{job_id}", dependencies=[Depends(require_api_key)])
def job_status(job_id: str) -> dict:
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
