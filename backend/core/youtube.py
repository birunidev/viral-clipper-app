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
# Ordered fallback when web client is bot-blocked. android/ios/mweb work
# without PO token more often than web; tv/android_vr as last resort.
FALLBACK_CLIENTS = ["android", "ios", "mweb", "tv", "android_vr"]

# Shared hint for bot-guard failures — keep in one place so get_info()
# and download() stay consistent. Includes Docker mount hint.
_BOT_GUARD_HINT = (
    " (YouTube bot guard on datacenter IP: set YTDLP_COOKIEFILE=/path/to/cookies.txt exported from your browser, "
    "or YTDLP_COOKIES_FROM_BROWSER=chrome, or set YTDLP_PROXY=http://user:pass@residential-proxy:port + "
    "YTDLP_PO_TOKEN/YTDLP_VISITOR_DATA, then restart backend. "
    "For immediate workaround, download the video locally and use Upload instead. "
    "See https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies and "
    "https://github.com/coletdjnz/bgutil-ytdlp-pot-provider)"
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


def _apply_cookie_and_po_opts(opts: dict, *, player_clients=None) -> None:
    """Mutate ``opts`` with cookie / PO-token / browser / proxy handling.

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

    # --- Datacenter bypass: proxy + impersonation + PO-token plugin ---
    # Residential proxy (e.g. http://user:pass@proxy:port) via YTDLP_PROXY or
    # standard http_proxy/https_proxy. Lets the VPS egress via residential IP.
    proxy = (
        os.environ.get("YTDLP_PROXY", "").strip()
        or os.environ.get("YTDLP_HTTP_PROXY", "").strip()
        or os.environ.get("http_proxy", "").strip()
        or os.environ.get("https_proxy", "").strip()
        or os.environ.get("HTTP_PROXY", "").strip()
        or os.environ.get("HTTPS_PROXY", "").strip()
    )
    if proxy:
        opts["proxy"] = proxy

    # Browser impersonation via curl_cffi (chrome) – helps TLS fingerprint.
    # yt-dlp Python API expects ImpersonateTarget object, not raw string.
    impersonate = os.environ.get("YTDLP_IMPERSONATE", "").strip()
    # Default off — enable with YTDLP_IMPERSONATE=chrome if you have curl_cffi
    if impersonate and impersonate.lower() not in ("0", "false", "off", "no"):
        try:
            from yt_dlp.networking.impersonate import ImpersonateTarget

            # e.g. "chrome", "chrome:chrome110", "safari"
            target = ImpersonateTarget.from_str(impersonate) if hasattr(ImpersonateTarget, "from_str") else impersonate
            opts["impersonate"] = target
        except Exception as exc:  # noqa: BLE001
            logger.debug("Could not set impersonate %r: %s", impersonate, exc)

    # bgutil-ytdlp-pot-provider auto-generates PO tokens if installed as
    # yt_dlp_plugins. No opts needed – it hooks automatically.


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
    no cookies). Falls back to yt-dlp only if ENABLE_YTDLP=1. Retries once
    with FALLBACK_CLIENTS on bot/403 errors, mirroring download().
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

    # 2) Legacy yt-dlp – gated
    if not _is_ytdlp_enabled():
        raise DownloadError(
            f"Could not fetch video metadata: YouTube downloads disabled in safe prod mode (ENABLE_YTDLP=0) and no YOUTUBE_API_KEY or API returned no result for {url[:60]}. "
            + _UPLOAD_HINT
        )
    if yt_dlp is None:
        raise DownloadError("yt-dlp is not installed. Run: poetry install")

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

    In safe prod mode (ENABLE_YTDLP=0, default) this raises with
    _UPLOAD_HINT – callers should prompt user to Upload instead. This
    keeps the shared prod Google session out of scope and is ToS-compliant.
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
        is_bot = "Sign in to confirm" in detail or "bot" in detail.lower()
        # --- Cobalt fallback for datacenter bot-guard ---
        # If YouTube blocked the VPS IP, try cobalt.tools (yt-dlp alternative
        # backend) which fetches via its own residential pool. No cookies needed.
        if is_bot:
            cobalt_err = None
            try:
                logger.info("yt-dlp bot-blocked, trying cobalt fallback for %s", url[:80])
                return _cobalt_download(url, out_dir, progress)
            except Exception as exc:  # noqa: BLE001
                cobalt_err = _strip_ansi(str(exc))
                logger.warning("Cobalt fallback failed: %s", cobalt_err[:300])
                detail = f"{detail} | cobalt fallback also failed: {cobalt_err[:200]}"
        hint = _BOT_GUARD_HINT if is_bot else ""
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


def _cobalt_download(url: str, out_dir: str, progress=None) -> str:
    """Fallback download via cobalt.tools API (bypasses YouTube bot-guard on VPS).

    cobalt runs its own yt-dlp pool with residential egress. Returns local
    file path on success, raises DownloadError otherwise. Respects
    YTDLP_COBALT_API env (default https://api.cobalt.tools).
    """
    import json
    import urllib.request

    api = os.environ.get("YTDLP_COBALT_API", "https://api.cobalt.tools").rstrip("/")
    # Some cobalt instances live at /api/json, others at / . Try both.
    endpoints = [f"{api}/api/json", f"{api}/"] if not api.endswith("/api/json") else [api]
    # Youtube URL validation already done via _validate_source()
    payload = json.dumps(
        {
            "url": url,
            "vCodec": "h264",
            "vQuality": "1080",
            "aFormat": "mp3",
            "isAudioOnly": False,
            "filenamePattern": "basic",
        }
    ).encode()

    last_err: str | None = None
    for ep in endpoints:
        try:
            req = urllib.request.Request(
                ep,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "snapclip/1.0",
                },
                method="POST",
            )
            # Optional auth for self-hosted cobalt
            token = os.environ.get("YTDLP_COBALT_API_KEY", "").strip()
            if token:
                req.add_header("Authorization", f"Api-Key {token}")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
            status = data.get("status")
            dl_url = data.get("url")
            if status == "redirect" and dl_url:
                # cobalt returns direct file URL – download it
                os.makedirs(out_dir, exist_ok=True)
                # Determine extension from cobalt filename or url
                filename = data.get("filename") or "video.mp4"
                dest = os.path.join(out_dir, filename)
                # Stream download with progress
                def _dl_progress(blocks, block_size, total):  # noqa: ARG001
                    if progress and total:
                        progress(0.05 + 0.25 * min(1.0, (blocks * block_size) / total))

                # Use urllib with timeout; fallback to requests if available
                try:
                    import requests  # type: ignore

                    with requests.get(dl_url, stream=True, timeout=60) as r:
                        r.raise_for_status()
                        total = int(r.headers.get("content-length", 0))
                        downloaded = 0
                        with open(dest, "wb") as fh:
                            for chunk in r.iter_content(chunk_size=8192):
                                if chunk:
                                    fh.write(chunk)
                                    downloaded += len(chunk)
                                    if progress and total:
                                        progress(0.05 + 0.25 * downloaded / total)
                except ImportError:
                    import urllib.request as _ur

                    _ur.urlretrieve(dl_url, dest)  # noqa: S310
                if progress:
                    progress(0.3)
                # Normalize to <video_id>.mp4 if cobalt gave different name
                vid = _extract_id(url) or "video"
                final = os.path.join(out_dir, f"{vid}.mp4")
                if dest != final:
                    try:
                        os.rename(dest, final)
                        dest = final
                    except OSError:
                        pass
                if os.path.isfile(dest) and os.path.getsize(dest) > 0:
                    return dest
                raise DownloadError(f"Cobalt downloaded file missing/empty: {dest}")
            # Error status from cobalt
            err = data.get("error") or data.get("text") or json.dumps(data)[:300]
            last_err = str(err)
            logger.warning("Cobalt %s returned %r: %s", ep, status, last_err[:200])
            continue
        except DownloadError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_err = _strip_ansi(str(exc))
            logger.warning("Cobalt %s failed: %s", ep, last_err[:200])
            continue
    raise DownloadError(f"Cobalt fallback failed: {last_err or 'unknown error'}")


def _extract_id(url: str) -> str | None:
    """Extract YouTube video ID from URL for cobalt filename normalization."""
    m = re.search(r"(?:v=|youtu\.be/|shorts/)([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else None


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
