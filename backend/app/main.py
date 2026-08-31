"""ClipZard backend: FastAPI service owning auth, CRUD, and the clipping pipeline."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp

from .api import auth, billing, caption_styles, dev_test, jobs, licenses, licenses_v2, projects, reels, settings, updates, uploads, youtube_proxy, ytdlp_stats, yt_wasm_proxy
from .worker import pool

# ─── CORS configuration ────────────────────────────────────────────────────
# Two kinds of clients hit this API:
#
# 1. Browser (https://clipzard.web.id) — same-origin from the user's POV
#    (Caddy proxies /api/*), but the browser still sends an Origin header
#    so we need to whitelist it explicitly. The session cookie is the
#    credential, so `allow_credentials=True`.
#
# 2. Electron desktop app — runs from file:// or app:// origins. The
#    Chromium network stack sends `Origin: null` for opaque origins; the
#    spec disallows `file://` in `allow_origins`, so we must whitelist
#    `null` (and the security trade-off is acceptable because Electron
#    app binaries are signed and the user runs them deliberately).
#
# `FRONTEND_URLS` is a comma-separated allowlist of browser origins
# (default: production site).  `ELECTRON_ALLOW_NULL_ORIGIN=1` (default in
# production) enables the file:// path for the desktop app.

def _normalize_origin(o: str) -> str:
    # strip trailing slash, keep case for now but normalize
    return o.strip().rstrip("/")

FRONTEND_URLS = [
    _normalize_origin(origin)
    for origin in os.environ.get("FRONTEND_URLS", "https://clipzard.web.id").split(",")
    if origin.strip()
]
ELECTRON_ALLOW_NULL_ORIGIN = (
    os.environ.get("ELECTRON_ALLOW_NULL_ORIGIN", "1").strip().lower()
    in ("1", "true", "yes", "on")
)
# The `null` origin entry is only valid when we trust the desktop app.
# Deduplicate while preserving order
ALLOWED_ORIGINS = list(dict.fromkeys(FRONTEND_URLS))
if ELECTRON_ALLOW_NULL_ORIGIN and "null" not in ALLOWED_ORIGINS:
    ALLOWED_ORIGINS.append("null")

# In dev (`localhost:3000` etc.) keep the same allowlist but the host
# can be overridden via env.

app = FastAPI(title="ClipZard Backend")

# Browser CORS: full middleware (preflight + credentials).
if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        # Tighten from `["*"]` — only the methods the API actually uses
        # (still need OPTIONS for preflight, PUT for presigned uploads).
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Requested-With",
            "X-CSRF-Token",
            "X-API-Key",
            # Allow Electron to send the User-Agent header (so the backend
            # can skip the CORS preflight for desktop requests when the
            # origin is `null`).
            "User-Agent",
        ],
        # Don't expose headers the browser doesn't need; this prevents
        # leaking server-internal state via CORS.
        expose_headers=["Content-Disposition", "Content-Length", "X-Update-Version"],
        # Cache the preflight for an hour — short enough to propagate
        # Caddy rule changes, long enough to avoid OPTIONS on every
        # authenticated request.
        max_age=3600,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.start()
    # Resilient yt-dlp: ensure latest at startup (only if ENABLE_YTDLP=1)
    if os.environ.get("ENABLE_YTDLP", "0").strip().lower() in ("1", "true", "yes", "on"):
        try:
            from core.downloader import ensure_ytdlp_latest, schedule_ytdlp_auto_update

            ensure_ytdlp_latest()
            schedule_ytdlp_auto_update()
        except Exception:
            pass
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
    yield


app = FastAPI(title="ClipZard Backend", lifespan=lifespan)


@app.middleware("http")
async def _electron_origin_passthrough(request: Request, call_next: ASGIApp):
    """Allow Electron (and any CORS-skip client like curl, server-to-server)
    to call the API even when the browser preflight is impossible.

    Chromium sends ``Origin: null`` for opaque origins (file://, app://).
    The CORS spec disallows those from a normal middleware, so this
    middleware injects the ``null`` origin into the standard CORS headers
    for the desktop app's User-Agent family.  Public read endpoints
    (update feed, license verify) work either way; authenticated
    endpoints require the session cookie, which Electron always sends.
    """
    if not ELECTRON_ALLOW_NULL_ORIGIN:
        return await call_next(request)
    origin = request.headers.get("origin")
    user_agent = request.headers.get("user-agent", "")
    is_electron = "electron" in user_agent.lower() or "clipzard-desktop" in user_agent.lower()
    # Pre-flight shortcut: answer OPTIONS directly with permissive CORS
    # for desktop-originated requests whose Origin is `null` (the
    # CORSMiddleware would have rejected it). Must echo origin, not "*"
    # when Allow-Credentials is true (spec forbids * with credentials).
    if request.method == "OPTIONS" and is_electron and origin in (None, "null", "file://", "app://"):
        allow_origin = origin if origin not in (None, "file://", "app://") else "null"
        return Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": allow_origin,
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With, X-API-Key, User-Agent",
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Max-Age": "3600",
                "Vary": "Origin",
            },
        )
    response = await call_next(request)
    if is_electron and origin in (None, "null", "file://", "app://"):
        # Inject the CORS headers for non-preflight requests so the
        # browser's response is readable by the desktop renderer.
        # Must echo origin, not "*"
        existing = response.headers.get("access-control-allow-origin")
        if not existing:
            allow_origin = origin if origin not in (None, "file://", "app://") else "null"
            response.headers["Access-Control-Allow-Origin"] = allow_origin
            response.headers["Vary"] = "Origin"
    return response





ENABLE_WEB_CLIPPER = os.environ.get("ENABLE_WEB_CLIPPER", "0").strip().lower() in ("1", "true", "yes", "on")

app.include_router(auth.router, prefix="/api/v1")
if ENABLE_WEB_CLIPPER:
    app.include_router(projects.router, prefix="/api/v1")
    app.include_router(jobs.router, prefix="/api/v1")
    app.include_router(uploads.router, prefix="/api/v1")
    app.include_router(reels.router, prefix="/api/v1")
    app.include_router(caption_styles.router, prefix="/api/v1")
    app.include_router(settings.router, prefix="/api/v1")
app.include_router(billing.router, prefix="/api/v1")
app.include_router(billing.hooks_router, prefix="/api/v1")
app.include_router(licenses.router, prefix="/api/v1")
app.include_router(youtube_proxy.router, prefix="/api/v1")
app.include_router(ytdlp_stats.router, prefix="/api/v1")
app.include_router(yt_wasm_proxy.router, prefix="/api/v1")
app.include_router(updates.router, prefix="/api/v1")
app.include_router(licenses_v2.router, prefix="/api/v1")
# Dev-only test endpoints; 404 in production unless DEBUG=1
app.include_router(dev_test.router, prefix="/api/v1")


@app.get("/health")
def health() -> dict:
    try:
        from core.downloader import _current_ytdlp_version

        v = _current_ytdlp_version()
    except Exception:
        v = "unknown"
    return {"ok": True, "service": "clipzard-backend", "ytdlp_version": v}


@app.get("/health/ytdlp")
def health_ytdlp() -> dict:
    """Unauthenticated ytdlp diagnostics (version + recent stats)."""
    try:
        from core.downloader import _current_ytdlp_version, get_method_stats, get_recommended_order

        return {
            "ytdlp_version": _current_ytdlp_version(),
            "stats": get_method_stats(),
            "recommended_order": get_recommended_order(),
        }
    except Exception as exc:  # pragma: no cover
        return {"ytdlp_version": "unknown", "error": str(exc)}
