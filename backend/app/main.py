"""ClipForge backend: FastAPI service owning auth, CRUD, and the clipping pipeline."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth, jobs, projects, uploads
from .worker import pool

FRONTEND_URLS = [
    origin.strip()
    for origin in os.environ.get("FRONTEND_URLS", os.environ.get("FRONTEND_URL", "")).split(",")
    if origin.strip()
]

app = FastAPI(title="ClipForge Backend")

if FRONTEND_URLS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=FRONTEND_URLS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.on_event("startup")
def _start_worker_pool() -> None:
    # WORKERS defaults to 1: local models (whisper.cpp, Ollama) are
    # GPU/CPU/RAM-bound and must run one job at a time on modest hardware.
    # Cloud-only deployments (AssemblyAI + hosted LLM) can raise WORKERS
    # since there's no shared local model to contend for.
    pool.start()


app.include_router(auth.router, prefix="/api/v1")
app.include_router(projects.router, prefix="/api/v1")
app.include_router(jobs.router, prefix="/api/v1")
app.include_router(uploads.router, prefix="/api/v1")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "clipforge-backend"}
