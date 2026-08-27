"""ClipForge backend: FastAPI service owning auth, CRUD, and the clipping pipeline."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth, billing, caption_styles, jobs, projects, reels, settings, uploads
from .worker import pool

FRONTEND_URLS = [
    origin.strip()
    for origin in os.environ.get("FRONTEND_URLS", os.environ.get("FRONTEND_URL", "")).split(",")
    if origin.strip()
]

app = FastAPI(title="SnapClip Backend")

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
    pool.start()
    try:
        from core.paddle import ensure_notification_destination
        ensure_notification_destination()
    except Exception:
        pass
    try:
        from core.midtrans import resolve_notification_url as _mid_url
        import logging
        _mid = _mid_url()
        if _mid:
            logging.getLogger(__name__).info("Midtrans expected Dashboard notification URL: %s (set in Midtrans Dashboard > Settings > Configuration, not per-transaction)", _mid)
    except Exception:
        pass


app.include_router(auth.router, prefix="/api/v1")
app.include_router(projects.router, prefix="/api/v1")
app.include_router(jobs.router, prefix="/api/v1")
app.include_router(uploads.router, prefix="/api/v1")
app.include_router(reels.router, prefix="/api/v1")
app.include_router(caption_styles.router, prefix="/api/v1")
app.include_router(settings.router, prefix="/api/v1")
app.include_router(billing.router, prefix="/api/v1")
app.include_router(billing.hooks_router, prefix="/api/v1")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "clipforge-backend"}
