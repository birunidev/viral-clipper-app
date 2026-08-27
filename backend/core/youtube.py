"""Download videos from YouTube (and other yt-dlp supported sites).

Wraps ``yt-dlp`` so the rest of the pipeline can treat the result as a
plain local video file. Progress is reported via an optional callback.

YouTube sometimes rejects the default player client with HTTP 403
(bot detection). When that happens we retry once with alternate player
clients (android/tv/ios), which are generally allowed.

Safe prod mode: set YOUTUBE_API_KEY and ENABLE_YTDLP=0 (default). Then
get_info() uses the official YouTube Data API v3 (no cookies, ToS-
compliant) and download() requires user upload (source_type="upload").
This avoids shared Google session hijack on the server.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
from typing import Callable

try:
    import yt_dlp
except ImportError:  # pragma: no cover - defensive
    yt_dlp = None

logger = logging.getLogger(__name__)

URL_RE = re.compile(r"^https?://", re.IGNORECASE)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
# Spec-ordered fallback chain: android -> ios -> tv -> tv_embedded -> web_embedded -> web
# This order is tuned for datacenter IPs (android/ios bypass bot-check most often).
# Exposed for observability; the resilient downloader iterates them one-by-one.
FALLBACK_CLIENTS = ["android", "ios", "tv", "tv_embedded", "web_embedded", "web"]
# Alias used by downloader
PLAYER_CLIENTS_ORDER = FALLBACK_CLIENTS

# Shared hint for bot-guard failures — keep in one place so get_info()
# and download() stay consistent. Includes Docker mount hint.
_BOT_GUARD_HINT = (
    " (YouTube bot guard: set YTDLP_COOKIEFILE=/path/to/cookies.txt exported from your browser, "
    "or YTDLP_COOKIES_FROM_BROWSER=chrome, then restart backend. "
    "See https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)"
)

# Safe-mode hint when yt-dlp is disabled – direct users to upload.
_UPLOAD_HINT = (
    " (YouTube downloads disabled in safe prod mode: please use Upload instead, "
    "or set YOUTUBE_API_KEY for metadata and ENABLE_YTDLP=1 for legacy yt-dlp "
    "with your own cookies. See backend/.env.example)"
)


class DownloadError(Exception):
    """Raised when a remote video cannot be downloaded."""


def _validate_source(url: str) -> None:
    """Defense-in-depth SSRF check before any network fetch (see
    core/urlguard). Called again here because download()/get_info() may be
    reached by callers that skipped API-layer validation."""
    from core.urlguard import UrlNotAllowed, validate_source_url

    try:
        validate_source_url(url)
    except UrlNotAllowed as exc:
        raise DownloadError(str(exc)) from exc


def _apply_cookie_and_po_opts(opts: dict, *, player_clients=None, client_cookies_path: str | None = None) -> None:
    """Mutate ``opts`` with cookie / PO-token / browser handling.

    Centralised so get_info() and download() (_build_opts) stay in sync.
    Safe to call multiple times; never raises — missing cookiefile is
    logged as warning and still passed to yt-dlp so the error is visible.

    `client_cookies_path` — per-request Netscape cookies file supplied by the
    browser after cookie-consent opt-in (SO 75426272: must be HttpOnly-aware
    via chrome.cookies). Takes precedence over server YTDLP_COOKIEFILE and
    is used ephemerally for this single download.
    """
    # Per-request client cookies (consent opt-in) take absolute precedence
    if client_cookies_path and os.path.isfile(client_cookies_path):
        opts["cookiefile"] = client_cookies_path
        return

    cookiefile = os.environ.get("YTDLP_COOKIEFILE", "").strip()
    cookies_from_browser = os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
    auto_enabled = os.environ.get("YTDLP_COOKIES_AUTO", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )

    use_browser: str | None = None
    if cookies_from_browser:
        use_browser = cookies_from_browser
    elif cookiefile:
        if os.path.isfile(cookiefile):
            # Placeholder detection: real cookies.txt must contain youtube.com
            try:
                with open(cookiefile, "r", encoding="utf-8", errors="ignore") as fh:
                    content = fh.read(8192)
                    is_placeholder = "youtube.com" not in content.lower() and "youtu.be" not in content.lower()
            except OSError:
                is_placeholder = True
            if is_placeholder and os.path.getsize(cookiefile) < 2048:
                logger.warning(
                    "YTDLP_COOKIEFILE=%r looks like a placeholder (no youtube.com cookies) — "
                    "bot guard will fail until you replace ./cookies.txt with a real export. "
                    "See https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies",
                    cookiefile,
                )
            opts["cookiefile"] = cookiefile
        else:
            # File missing (common in Docker when volume not mounted) — log
            # loudly and still set it so yt-dlp's error mentions the path.
            logger.warning("YTDLP_COOKIEFILE=%r does not exist or not mounted — bot guard will fail", cookiefile)
            opts["cookiefile"] = cookiefile
    elif auto_enabled:
        detected = _detect_browser()
        if detected:
            use_browser = detected

    if use_browser:
        parts = [p.strip() for p in use_browser.split(":")]
        while len(parts) < 4:
            parts.append(None)
        opts["cookiesfrombrowser"] = tuple(p if p else None for p in parts[:4])

    po_token = os.environ.get("YTDLP_PO_TOKEN", "").strip()
    visitor_data = os.environ.get("YTDLP_VISITOR_DATA", "").strip()
    extractor_args: dict = {}
    if player_clients:
        extractor_args["player_client"] = player_clients
    if po_token:
        extractor_args["po_token"] = [po_token]
    if visitor_data:
        extractor_args["visitor_data"] = visitor_data
    if extractor_args:
        # Merge with any existing extractor_args (preserve other keys)
        existing = opts.get("extractor_args", {})
        youtube_args = dict(existing.get("youtube", {}))
        youtube_args.update(extractor_args)
        opts["extractor_args"] = {**existing, "youtube": youtube_args}


def _is_ytdlp_enabled() -> bool:
    """Gate for legacy yt-dlp. Safe prod default is OFF (0)."""
    return os.environ.get("ENABLE_YTDLP", "0").strip().lower() in ("1", "true", "yes", "on")


def get_info(url: str) -> dict:
    """Fetch remote metadata (no download) for ``url``.

    Returns the yt-dlp extractor info dict, which includes useful fields such
    as ``id``, ``title``, ``uploader``, and ``language`` (the source video's
    spoken language as an ISO 639-1 code where available). Raises
    DownloadError if yt-dlp is missing or metadata cannot be fetched.

    Prefers official YouTube Data API v3 when YOUTUBE_API_KEY is set (safe,
    no cookies). Falls back to the resilient downloader's fallback chain
    (android -> ios -> tv -> tv_embedded -> web_embedded -> web) via
    ``core.downloader.get_info_resilient``.
    """
    _validate_source(url)

    # 1) Official API (safe, no cookies) – preferred
    try:
        from core.youtube_api import get_info_official

        official = get_info_official(url)
        if official is not None:
            logger.info("get_info via official YouTube Data API for %s", url[:80])
            return official
    except Exception as exc:  # pragma: no cover – never block on official API failure
        logger.warning("Official API get_info failed, falling back to yt-dlp: %s", exc)

    # 2) Resilient yt-dlp – gated
    if not _is_ytdlp_enabled():
        raise DownloadError(
            f"Could not fetch video metadata: YouTube downloads disabled in safe prod mode (ENABLE_YTDLP=0) and no YOUTUBE_API_KEY or API returned no result for {url[:60]}. "
            + _UPLOAD_HINT
        )
    if yt_dlp is None:
        raise DownloadError("yt-dlp is not installed. Run: poetry install")

    # Delegate to resilient downloader (handles fallback chain, timeout, PO token, pacing, logging)
    try:
        from core.downloader import get_info_resilient

        return get_info_resilient(url)
    except DownloadError:
        raise
    except Exception as exc:  # pragma: no cover
        raise DownloadError(f"Could not fetch video metadata: {_strip_ansi(str(exc))}") from exc


def is_url(value: str) -> bool:
    """Return True if ``value`` looks like a remote (http/https) URL."""
    return bool(URL_RE.match(value.strip()))


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def _detect_browser() -> str | None:
    """Return first available browser for cookiesfrombrowser, or None."""
    # Check env override first
    explicit = os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
    if explicit:
        return explicit
    # Auto-detect: try chrome, then firefox, edge, chromium
    # This is programmatic - no manual export needed if browser is logged into YouTube
    for browser in ("chrome", "firefox", "chromium", "edge", "opera", "brave"):
        # yt-dlp will try to find the browser's cookie store; we just check if binary exists
        # or if cookie DB exists. Simplest: check binary, but also try yt-dlp's detection
        # by attempting to use it and catching error - here we just probe via which
        if shutil.which(browser) or shutil.which(f"{browser}-browser") or browser == "chrome" and os.path.exists("/usr/bin/google-chrome"):
            # Verify yt-dlp can actually read it by checking for cookie DB path
            # Don't verify deeply - let yt-dlp fail gracefully and we'll fallback
            return browser
    # Check for google-chrome specifically
    if os.path.exists("/usr/bin/google-chrome") or os.path.exists("/usr/bin/chromium-browser"):
        return "chrome"
    return None


def _build_opts(out_dir: str, hook: Callable[[dict], None], player_clients, client_cookies_path: str | None = None) -> dict:
    # Prefer H.264 (broadest compatibility) → VP9 → AV1 fallback (per Fetchr
    # note: AV1 is often served but browser/device support is inconsistent).
    # Instagram serves separate DASH video+audio – the `+ba` merge handles it
    # (previous Fetchr bug was silent Instagram files).
    opts = {
        "format": "bestvideo[vcodec^=avc][height<=1080]+bestaudio/bv*[vcodec^=avc][height<=1080]+ba/bv*[vcodec^=vp9][height<=1080]+ba/bv*[height<=1080]+ba/b[height<=1080]/b",
        "outtmpl": os.path.join(out_dir, "%(id)s.%(ext)s"),
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "retries": 5,
        "fragment_retries": 5,
        "extractor_retries": 5,
        "socket_timeout": 30,
        "remote_components": ["ejs:github"],
    }
    # YouTube bot guard: supports cookiefile, cookies-from-browser, or auto.
    # See _apply_cookie_and_po_opts() — single source of truth.
    _apply_cookie_and_po_opts(opts, player_clients=player_clients, client_cookies_path=client_cookies_path)
    return opts


def _client_cookies_path_for(project_id: str | None) -> str | None:
    """Resolve per-project client cookies file (from opt-in consent).

    When the frontend sends youtube_cookies with ProjectCreate, the API
    writes it to /tmp/youtube_cookies_{project_id}.txt for this single
    job. Returns path if file exists, else None.
    """
    if not project_id:
        return None
    p = f"/tmp/youtube_cookies_{project_id}.txt"
    return p if os.path.isfile(p) else None


def download(
    url: str,
    out_dir: str,
    progress: Callable[[float], None] | None = None,
    client_cookies_path: str | None = None,
    project_id: str | None = None,
) -> str:
    """Download ``url`` into ``out_dir`` and return the local file path.

    Thin wrapper over ``core.downloader.download_video`` which implements the
    full fallback chain (android -> ios -> tv -> tv_embedded -> web_embedded -> web),
    timeout wrapping, bot-signature detection, PO token sidecar, pacing and
    success logging. This wrapper preserves the legacy ``download(...) -> str``
    contract so existing callers (pipeline, tests) need not change.

    For the richer abstraction use ``from core.downloader import download_video``.

    In safe prod mode (ENABLE_YTDLP=0, default) this raises with
    _UPLOAD_HINT – callers should prompt user to Upload instead.
    """
    if not _is_ytdlp_enabled():
        raise DownloadError(
            f"Download failed: YouTube downloads disabled in safe prod mode (ENABLE_YTDLP=0) for {url[:60]}. "
            "Please download the video yourself and use Upload instead, "
            "or set YOUTUBE_API_KEY for metadata and ENABLE_YTDLP=1 with your own cookies for legacy mode."
            + _UPLOAD_HINT
        )
    if yt_dlp is None:
        raise DownloadError("yt-dlp is not installed. Run: poetry install")

    # Delegate to resilient downloader (handles validation, pacing, PO token, retries)
    from core.downloader import download_video as _dlv

    result = _dlv(
        url,
        out_dir,
        progress=progress,
        client_cookies_path=client_cookies_path,
        project_id=project_id,
    )
    logger.info(
        "download() succeeded via method=%s pot=%s path=%s",
        result.method_used,
        result.with_pot,
        result.video_path,
    )
    return result.video_path


def _clean_out_dir(out_dir: str) -> None:
    for name in os.listdir(out_dir):
        try:
            path = os.path.join(out_dir, name)
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.remove(path)
        except OSError:
            pass


# Re-export resilient abstraction for callers that want the richer contract.
try:
    from core.downloader import DownloadResult, download_video  # noqa: F401
except ImportError:
    pass
