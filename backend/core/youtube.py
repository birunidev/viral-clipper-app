"""Download videos from YouTube (and other yt-dlp supported sites).

Wraps ``yt-dlp`` so the rest of the pipeline can treat the result as a
plain local video file. Progress is reported via an optional callback.

YouTube sometimes rejects the default player client with HTTP 403
(bot detection). When that happens we retry once with alternate player
clients (android/tv/ios), which are generally allowed.
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
FALLBACK_CLIENTS = ["android_vr", "tv", "ios"]

# Shared hint for bot-guard failures — keep in one place so get_info()
# and download() stay consistent. Includes Docker mount hint.
_BOT_GUARD_HINT = (
    " (YouTube bot guard: set YTDLP_COOKIEFILE=/path/to/cookies.txt exported from your browser, "
    "or YTDLP_COOKIES_FROM_BROWSER=chrome, then restart backend. "
    "See https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)"
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


def _apply_cookie_and_po_opts(opts: dict, *, player_clients=None) -> None:
    """Mutate ``opts`` with cookie / PO-token / browser handling.

    Centralised so get_info() and download() (_build_opts) stay in sync.
    Safe to call multiple times; never raises — missing cookiefile is
    logged as warning and still passed to yt-dlp so the error is visible.
    """
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


def get_info(url: str) -> dict:
    """Fetch remote metadata (no download) for ``url``.

    Returns the yt-dlp extractor info dict, which includes useful fields such
    as ``id``, ``title``, ``uploader``, and ``language`` (the source video's
    spoken language as an ISO 639-1 code where available). Raises
    DownloadError if yt-dlp is missing or metadata cannot be fetched.

    Retries once with FALLBACK_CLIENTS on bot/403 errors, mirroring download().
    """
    if yt_dlp is None:
        raise DownloadError("yt-dlp is not installed. Run: poetry install")

    _validate_source(url)

    last_error: Exception | None = None
    for player_clients in (None, FALLBACK_CLIENTS):
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "remote_components": ["ejs:github"],
        }
        _apply_cookie_and_po_opts(opts, player_clients=player_clients)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(url, download=False) or {}
        except yt_dlp.utils.DownloadError as exc:
            last_error = exc
            detail = _strip_ansi(str(exc))
            # Only retry with fallback clients for bot/403-ish errors; other
            # failures (private video, etc.) should fail fast without retry.
            is_bot = "Sign in to confirm" in detail or "bot" in detail.lower() or "403" in detail or "Forbidden" in detail
            if player_clients is None and is_bot:
                logger.info("get_info retrying with fallback clients after: %s", detail[:200])
                continue
            hint = _BOT_GUARD_HINT if is_bot else ""
            raise DownloadError(f"Could not fetch video metadata: {detail}{hint}") from exc

    # Exhausted fallback — surface last error with hint
    detail = _strip_ansi(str(last_error or "unknown error"))
    hint = ""
    if "Sign in to confirm" in detail or "bot" in detail.lower():
        hint = _BOT_GUARD_HINT
    raise DownloadError(f"Could not fetch video metadata: {detail}{hint}") from last_error


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


def _build_opts(out_dir: str, hook: Callable[[dict], None], player_clients) -> dict:
    opts = {
        "format": "bv*[height<=1080]+ba/b[height<=1080]/b",
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
    _apply_cookie_and_po_opts(opts, player_clients=player_clients)
    return opts


def download(
    url: str,
    out_dir: str,
    progress: Callable[[float], None] | None = None,
) -> str:
    """Download ``url`` into ``out_dir`` and return the local file path.

    Downloads the best available quality and merges audio/video to MP4.
    On a download-stage failure it retries once with alternate YouTube
    player clients. Raises DownloadError when yt-dlp is missing, the URL
    cannot be fetched, or the output file is not produced.
    """
    if yt_dlp is None:
        raise DownloadError("yt-dlp is not installed. Run: poetry install")

    _validate_source(url)

    os.makedirs(out_dir, exist_ok=True)

    def _hook(data: dict) -> None:
        if progress is None:
            return
        status = data.get("status")
        if status == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            done = data.get("downloaded_bytes") or 0
            if total:
                progress(0.05 + 0.25 * done / total)
        elif status == "finished":
            progress(0.3)

    info = None
    last_error: Exception | None = None

    for player_clients in (None, FALLBACK_CLIENTS):
        try:
            with yt_dlp.YoutubeDL(_build_opts(out_dir, _hook, player_clients)) as ydl:
                info = ydl.extract_info(url, download=True)
            break
        except yt_dlp.utils.DownloadError as exc:
            last_error = exc
            _clean_out_dir(out_dir)

    if info is None:
        detail = _strip_ansi(str(last_error or "unknown error"))
        hint = ""
        if "Sign in to confirm" in detail or "bot" in detail.lower():
            hint = _BOT_GUARD_HINT
        raise DownloadError(f"Download failed: {detail}{hint}")

    video_id = (info or {}).get("id")
    if video_id:
        path = os.path.join(out_dir, f"{video_id}.mp4")
        if os.path.isfile(path):
            return path

        for name in os.listdir(out_dir):
            if name.startswith(str(video_id)):
                return os.path.join(out_dir, name)

    raise DownloadError("Download finished but no output file was found.")


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
