"""Resilient YouTube downloader with fallback chain, pacing, PO token, and metrics.

Implements the requirements from the resilient download module spec:

1. Latest yt-dlp startup check (ensure_ytdlp_latest).
2. Player-client fallback chain via --extractor-args "youtube:player_client=..." with
   ordered attempts: android, ios, tv, tv_embedded, web_embedded, web.
   Each attempt is timeout-wrapped and error signatures (bot-check, 403,
   empty formats) decide fallback vs fatal.
3. PO token provider (bgutil-ytdlp-pot-provider) as optional sidecar.
4. Request pacing (sleep_interval etc.) + global rate limiter to avoid bursts.
5. Structured logging of which client/method succeeded + in-memory success stats.
6. Clean abstraction: download_video(url) -> DownloadResult.

This module is the single source of truth; ``core.youtube`` delegates to it
for backward compatibility.
"""

from __future__ import annotations

import concurrent.futures
import dataclasses
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Callable

try:
    import yt_dlp
except ImportError:  # pragma: no cover
    yt_dlp = None  # type: ignore

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 1. Startup check – latest yt-dlp
# ---------------------------------------------------------------------------

def _current_ytdlp_version() -> str:
    if yt_dlp is None:
        return "not-installed"
    # yt_dlp.version is a module; need its __version__ string
    ver = getattr(yt_dlp, "__version__", None)
    if isinstance(ver, str) and ver:
        return ver
    try:
        mod = getattr(yt_dlp, "version", None)
        if mod is not None:
            v = getattr(mod, "__version__", None)
            if isinstance(v, str) and v:
                return v
            # fallback stringify safely
            if isinstance(mod, str):
                return mod
    except Exception:
        pass
    return "unknown"

def ensure_ytdlp_latest(*, timeout: int = 120, auto_update: bool | None = None) -> str:
    """Ensure yt-dlp is up-to-date at startup.

    When YTDLP_AUTO_UPDATE != "0" (default: enabled), runs ``pip install -U yt-dlp``
    with a timeout. Never raises – logs outcome and returns the version string.

    Called from FastAPI startup; can also be scheduled periodically.
    """
    if auto_update is None:
        auto_update = os.environ.get("YTDLP_AUTO_UPDATE", "1").strip().lower() not in ("0", "false", "no", "off")
    before = _current_ytdlp_version()
    logger.info("yt-dlp version at startup: %s (auto_update=%s)", before, auto_update)
    if not auto_update:
        return before
    # Prefer pip; fallback to yt-dlp --update if pip not available
    pip_bin = shutil.which("pip") or shutil.which("pip3") or sys.executable + " -m pip"
    # Try pip install -U yt-dlp
    try:
        cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", "-U", "yt-dlp"]
        logger.info("Updating yt-dlp: %s", " ".join(cmd))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0:
            # Reload version if possible (importlib reload)
            try:
                import importlib
                if yt_dlp is not None:
                    importlib.reload(yt_dlp)  # type: ignore
            except Exception:
                pass
            after = _current_ytdlp_version()
            logger.info("yt-dlp updated: %s -> %s", before, after)
            return after
        else:
            logger.warning("pip install -U yt-dlp failed (%s): %s", result.returncode, (result.stderr or result.stdout)[:500])
    except subprocess.TimeoutExpired:
        logger.warning("pip install -U yt-dlp timed out after %ss", timeout)
    except Exception as exc:
        logger.warning("pip install -U yt-dlp error: %s", exc)

    # Fallback: yt-dlp --update via module
    try:
        cmd = [sys.executable, "-m", "yt_dlp", "--update"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        logger.info("yt-dlp --update result: %s %s", result.returncode, (result.stdout or result.stderr)[:300])
    except Exception:
        pass
    return _current_ytdlp_version()


def schedule_ytdlp_auto_update(interval_hours: float = 12.0) -> None:
    """Start a daemon thread that periodically re-runs ensure_ytdlp_latest.

    Interval controlled by YTDLP_UPDATE_INTERVAL_HOURS env (default 12h).
    Disabled when YTDLP_AUTO_UPDATE=0.
    """
    try:
        raw = os.environ.get("YTDLP_UPDATE_INTERVAL_HOURS", str(interval_hours))
        hrs = float(raw)
    except ValueError:
        hrs = interval_hours
    if hrs <= 0:
        return
    if os.environ.get("YTDLP_AUTO_UPDATE", "1").strip().lower() in ("0", "false", "no", "off"):
        return

    def _loop() -> None:
        while True:
            time.sleep(hrs * 3600)
            try:
                ensure_ytdlp_latest()
            except Exception:
                logger.exception("Scheduled yt-dlp update failed")

    t = threading.Thread(target=_loop, name="ytdlp-auto-update", daemon=True)
    t.start()
    logger.info("Scheduled yt-dlp auto-update every %.1fh", hrs)

# ---------------------------------------------------------------------------
# 2. Fallback chain + error signatures
# ---------------------------------------------------------------------------

# Spec-ordered fallback chain: android, ios, tv, tv_embedded, web_embedded, web
PLAYER_CLIENTS_ORDER: list[str] = ["android", "ios", "tv", "tv_embedded", "web_embedded", "web"]

# Stripped ANSI for matching
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
URL_RE = re.compile(r"https?://\S+")

# Retryable error signatures (bot-check, 403, empty formats)
_RETRYABLE_PATTERNS = [
    r"Sign in to confirm you'?re not a bot",
    r"Sign in to confirm",
    r"bot.?guard",
    r"HTTP Error 403",
    r"\b403\b.*Forbidden",
    r"Forbidden",
    r"No video formats found",
    r"Requested format is not available",
    r"empty.*format",
    r"nsig extraction failed",
    r"Unable to extract.*player",
    r"Failed to extract",
    r"Got error:.*403",
    r"HTTP Error 429",
    r"Too Many Requests",
]
_RETRYABLE_RE = re.compile("|".join(_RETRYABLE_PATTERNS), re.IGNORECASE)

# Fatal (do NOT retry across clients) – private/unavailable/copyright etc.
_FATAL_PATTERNS = [
    r"Private video",
    r"Video unavailable",
    r"This video is not available",
    r"Copyright",
    r"has been removed",
    r"members-only",
    r"Join this channel to get access",
    r"Premiere will begin shortly",
    r"live event will begin",
    r"Invalid URL",
]
_FATAL_RE = re.compile("|".join(_FATAL_PATTERNS), re.IGNORECASE)


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def is_retryable_error(detail: str) -> bool:
    """Return True if error looks like bot/403/formats issue worth retrying with another client."""
    text = _strip_ansi(detail)
    if _FATAL_RE.search(text):
        return False
    return bool(_RETRYABLE_RE.search(text))


def is_empty_formats_error(detail: str) -> bool:
    text = _strip_ansi(detail).lower()
    return "no video formats found" in text or "empty" in text and "format" in text or "requested format is not available" in text

# ---------------------------------------------------------------------------
# 3. PO token provider (bgutil)
# ---------------------------------------------------------------------------

def _pot_provider_url() -> str | None:
    # Preferred env per spec: POT_PROVIDER_URL or BGUTIL_URL
    url = (
        os.environ.get("POT_PROVIDER_URL", "").strip()
        or os.environ.get("BGUTIL_URL", "").strip()
        or os.environ.get("YTDLP_POT_PROVIDER_URL", "").strip()
    )
    if url:
        return url.rstrip("/")
    # Default sidecar location when compose adds the service (loopback inside backend)
    # Probe env YTDLP_POT_PROVIDER_ENABLED auto-discovers http://pot:4416 or http://bgutil:4416
    # If not set, treat as disabled (partial mitigation, not required).
    default = os.environ.get("POT_PROVIDER_DEFAULT_URL", "").strip()
    if default:
        return default.rstrip("/")
    return None


def _apply_pot_provider(opts: dict) -> None:
    """Wire bgutil-ytdlp-pot-provider if available.

    The pip package ``bgutil-ytdlp-pot-provider`` registers a yt-dlp plugin that
    automatically contacts the sidecar when it is reachable. We optionally pass
    the base_url via extractor_args for explicit wiring.
    """
    pot_url = _pot_provider_url()
    if not pot_url:
        return
    # The plugin expects base_url under youtubepot extractor args (per README)
    # and also supports generic PO token via youtube extractor_args.
    # Set both for compatibility across plugin versions.
    extractor_args = opts.get("extractor_args", {})
    # youtubepot provider
    youtubepot_args = dict(extractor_args.get("youtubepot", {}))
    youtubepot_args.setdefault("base_url", pot_url)
    extractor_args["youtubepot"] = youtubepot_args
    # Also set bgutil_base_url alias used by some forks
    bgutil_args = dict(extractor_args.get("bgutil", {}))
    bgutil_args.setdefault("base_url", pot_url)
    extractor_args["bgutil"] = bgutil_args
    opts["extractor_args"] = extractor_args
    logger.info("PO token provider wired: %s", pot_url)


def _pot_health_log() -> None:
    """Best-effort health probe of POT provider (logs warning if unreachable)."""
    pot_url = _pot_provider_url()
    if not pot_url:
        logger.info("PO token provider not configured (POT_PROVIDER_URL unset) – running without POT (partial mitigation)")
        return
    try:
        import requests
        # bgutil exposes /ping or healthcheck; try base_url itself
        resp = requests.get(pot_url, timeout=3)
        if resp.status_code < 500:
            logger.info("PO token provider reachable at %s (status %s)", pot_url, resp.status_code)
        else:
            logger.warning("PO token provider at %s returned %s", pot_url, resp.status_code)
    except Exception as exc:
        logger.warning("PO token provider at %s unreachable: %s (downloads will continue without POT)", pot_url, exc)

# ---------------------------------------------------------------------------
# 4. Request pacing + rate limiter
# ---------------------------------------------------------------------------

def _pacing_opts() -> dict:
    """Return yt-dlp pacing options from env (with sensible defaults)."""
    def _float(env: str, default: float) -> float:
        try:
            return float(os.environ.get(env, str(default)).strip())
        except (ValueError, AttributeError):
            return default

    def _int(env: str, default: int) -> int:
        try:
            return int(os.environ.get(env, str(default)).strip())
        except (ValueError, AttributeError):
            return default

    sleep_interval = _float("YTDLP_SLEEP_INTERVAL", 1.5)
    max_sleep = _float("YTDLP_MAX_SLEEP_INTERVAL", 5.0)
    sleep_requests = _int("YTDLP_SLEEP_REQUESTS", 1)
    # Clamp to sane ranges
    sleep_interval = max(0.0, min(sleep_interval, 10.0))
    max_sleep = max(sleep_interval, min(max_sleep, 30.0))
    opts: dict = {}
    if sleep_interval > 0:
        opts["sleep_interval"] = sleep_interval
    if max_sleep > 0:
        opts["max_sleep_interval"] = max_sleep
    if sleep_requests > 0:
        # yt-dlp option is sleep_interval_requests
        opts["sleep_interval_requests"] = sleep_requests
    # Optional extra: sleep before each extractor request
    # yt-dlp uses sleep_interval; we map correctly.
    return opts

# Global rate limiter: ensure serialized / paced extraction starts
class ExtractionRateLimiter:
    """Simple process-wide limiter: at most one extraction every min_interval and
    bounded concurrency. Prevents bursts from same IP triggering flags.
    """

    def __init__(self, min_interval: float = 2.0, max_concurrent: int = 1) -> None:
        self.min_interval = min_interval
        self.max_concurrent = max_concurrent
        self._lock = threading.Lock()
        self._last_ts = 0.0
        self._sem = threading.Semaphore(max_concurrent)

    def configure_from_env(self) -> None:
        try:
            self.min_interval = float(os.environ.get("YTDLP_RATE_INTERVAL", str(self.min_interval)).strip())
        except ValueError:
            pass
        try:
            self.max_concurrent = int(os.environ.get("YTDLP_MAX_CONCURRENT", str(self.max_concurrent)).strip())
            # Recreate semaphore if changed
            self._sem = threading.Semaphore(max(1, self.max_concurrent))
        except ValueError:
            pass

    def acquire(self) -> None:
        # Enforce min interval between acquisitions (sleep outside lock)
        wait = 0.0
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_ts
            if elapsed < self.min_interval:
                wait = self.min_interval - elapsed
            self._last_ts = now + wait
        if wait > 0:
            logger.info("Rate limiter pacing: sleeping %.1fs before next extraction", wait)
            time.sleep(wait)
        self._sem.acquire()

    def release(self) -> None:
        try:
            self._sem.release()
        except ValueError:
            pass

    # Context manager helper
    def __enter__(self) -> "ExtractionRateLimiter":
        self.acquire()
        return self

    def __exit__(self, *args) -> None:
        self.release()


rate_limiter = ExtractionRateLimiter()
# Configure from env at import
rate_limiter.configure_from_env()

# ---------------------------------------------------------------------------
# 5. Logging / metrics – which client succeeded
# ---------------------------------------------------------------------------

# In-memory counters: {client: {"success": int, "fail": int, "last_success_ts": float}}
_stats_lock = threading.Lock()
_method_stats: dict[str, dict] = {c: {"success": 0, "fail": 0, "last_success_ts": 0.0} for c in PLAYER_CLIENTS_ORDER}
_method_stats["default"] = {"success": 0, "fail": 0, "last_success_ts": 0.0}
_method_stats["with_pot"] = {"success": 0, "fail": 0, "last_success_ts": 0.0}


def _record_success(client: str, *, with_pot: bool = False) -> None:
    with _stats_lock:
        key = client or "default"
        if key not in _method_stats:
            _method_stats[key] = {"success": 0, "fail": 0, "last_success_ts": 0.0}
        _method_stats[key]["success"] += 1
        _method_stats[key]["last_success_ts"] = time.time()
        if with_pot:
            _method_stats["with_pot"]["success"] += 1
            _method_stats["with_pot"]["last_success_ts"] = time.time()
    logger.info("yt-dlp success via client=%s pot=%s", client or "default", with_pot)


def _record_failure(client: str) -> None:
    with _stats_lock:
        key = client or "default"
        if key not in _method_stats:
            _method_stats[key] = {"success": 0, "fail": 0, "last_success_ts": 0.0}
        _method_stats[key]["fail"] += 1


def get_method_stats() -> dict[str, dict]:
    """Return a snapshot of per-client success/failure counters."""
    with _stats_lock:
        return {k: dict(v) for k, v in _method_stats.items()}


def get_recommended_order() -> list[str]:
    """Return PLAYER_CLIENTS_ORDER re-sorted by observed success rate (desc).

    Useful for reprioritizing the fallback order based on real data.
    Clients with no data keep their original relative order at the end.
    """
    snapshot = get_method_stats()
    def _score(c: str) -> float:
        s = snapshot.get(c, {})
        succ = s.get("success", 0)
        fail = s.get("fail", 0)
        total = succ + fail
        if total == 0:
            return -1.0
        return succ / total
    # Stable sort: higher score first, preserve original order for ties
    ordered = sorted(PLAYER_CLIENTS_ORDER, key=lambda c: _score(c), reverse=True)
    # Move never-tried (-1 score) to end preserving original order
    tried = [c for c in ordered if _score(c) >= 0]
    untried = [c for c in PLAYER_CLIENTS_ORDER if c not in tried]
    return tried + untried


def _log_attempt(client: str | None, url: str, attempt: int) -> None:
    logger.info("yt-dlp attempt %d/%d client=%s url=%s pot=%s", attempt, len(PLAYER_CLIENTS_ORDER) + 1, client or "default", url[:80], bool(_pot_provider_url()))


# ---------------------------------------------------------------------------
# 6. Core abstraction
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class DownloadResult:
    """Return value of download_video – pipeline-friendly."""

    video_path: str
    method_used: str  # e.g. "android", "tv", "default"
    client: str
    format: str | None  # yt-dlp format string used
    ext: str
    video_id: str | None
    info: dict
    with_pot: bool = False


def _build_opts(
    out_dir: str,
    hook: Callable[[dict], None] | None,
    player_client: str | None,
    client_cookies_path: str | None = None,
) -> dict:
    """Build yt-dlp options for one attempt (single player_client)."""
    # Base format: cap 1080p, prefer avc
    opts: dict = {
        "format": "bestvideo[vcodec^=avc][height<=1080]+bestaudio/bv*[vcodec^=avc][height<=1080]+ba/bv*[vcodec^=vp9][height<=1080]+ba/bv*[height<=1080]+ba/b[height<=1080]/b",
        "outtmpl": os.path.join(out_dir, "%(id)s.%(ext)s"),
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 3,
        "fragment_retries": 5,
        "extractor_retries": 2,
        "socket_timeout": 30,
        "remote_components": ["ejs:github"],
    }
    if hook is not None:
        opts["progress_hooks"] = [hook]

    # Pacing
    opts.update(_pacing_opts())

    # Cookie / browser handling (reuse core.youtube helper if available)
    try:
        from core.youtube import _apply_cookie_and_po_opts as _legacy_cookie
        _legacy_cookie(opts, player_clients=[player_client] if player_client else None, client_cookies_path=client_cookies_path)  # type: ignore
        # _legacy handles extractor_args; ensure single client string, not list
        if player_client:
            # Override to single client for this attempt (clearer logging per attempt)
            existing = opts.get("extractor_args", {})
            youtube_args = dict(existing.get("youtube", {}))
            youtube_args["player_client"] = player_client
            opts["extractor_args"] = {**existing, "youtube": youtube_args}
    except Exception:
        # Fallback minimal
        if player_client:
            opts["extractor_args"] = {"youtube": {"player_client": player_client}}
        if client_cookies_path and os.path.isfile(client_cookies_path):
            opts["cookiefile"] = client_cookies_path
        else:
            cookiefile = os.environ.get("YTDLP_COOKIEFILE", "").strip()
            if cookiefile and os.path.isfile(cookiefile):
                opts["cookiefile"] = cookiefile

    # PO token provider
    _apply_pot_provider(opts)

    # Env-controlled timeout per attempt (socket + overall)
    try:
        to = int(os.environ.get("YTDLP_TIMEOUT", "90").strip())
        if to > 0:
            opts["socket_timeout"] = min(to, 120)
    except ValueError:
        pass

    return opts


def _run_with_timeout(func: Callable, timeout: float, *args, **kwargs):
    """Run func(*args, **kwargs) with a hard timeout; raise TimeoutError on expiry."""
    if timeout <= 0:
        return func(*args, **kwargs)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(func, *args, **kwargs)
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError as exc:
            # Cancel best-effort
            future.cancel()
            raise TimeoutError(f"yt-dlp attempt timed out after {timeout}s") from exc


def _extraction_attempt(url: str, out_dir: str, player_client: str | None, hook, client_cookies_path: str | None, timeout: float) -> dict | None:
    """Single yt-dlp extraction attempt; returns info dict or raises."""
    if yt_dlp is None:
        raise RuntimeError("yt-dlp is not installed")

    opts = _build_opts(out_dir, hook, player_client, client_cookies_path=client_cookies_path)

    def _do() -> dict:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=True)  # type: ignore

    return _run_with_timeout(_do, timeout)


def download_video(
    url: str,
    out_dir: str | None = None,
    progress: Callable[[float], None] | None = None,
    client_cookies_path: str | None = None,
    project_id: str | None = None,
    timeout: float | None = None,
) -> DownloadResult:
    """Resilient download with fallback chain.

    Always returns a :class:`DownloadResult` on success; raises DownloadError
    only after exhausting all clients or on fatal (non-retryable) errors.

    The caller need not know about fallback logic – just pass the URL.
    """
    from core.youtube import DownloadError, _validate_source, _clean_out_dir  # local import to avoid cycle at top

    _validate_source(url)

    # Resolve out_dir and per-request cookies
    import tempfile
    _tmp_created = False
    if out_dir is None:
        out_dir = tempfile.mkdtemp(prefix="snapclip_dl_")
        _tmp_created = True
    else:
        os.makedirs(out_dir, exist_ok=True)

    # Resolve per-request client cookies
    if not client_cookies_path and project_id:
        cand = f"/tmp/youtube_cookies_{project_id}.txt"
        if os.path.isfile(cand):
            client_cookies_path = cand

    if timeout is None:
        try:
            timeout = float(os.environ.get("YTDLP_ATTEMPT_TIMEOUT", os.environ.get("YTDLP_TIMEOUT", "90")).strip())
        except ValueError:
            timeout = 90.0

    # Progress hook: map yt-dlp progress to 0.05..0.95 range
    def _hook(data: dict) -> None:
        if progress is None:
            return
        status = data.get("status")
        if status == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            done = data.get("downloaded_bytes") or 0
            if total:
                progress(0.05 + 0.55 * min(1.0, done / max(total, 1)))
        elif status == "finished":
            progress(0.65)

    # Pacing + rate limiter gate
    rate_limiter.configure_from_env()
    pot_url = _pot_provider_url()
    with_pot = bool(pot_url)
    # Emit pot health once per process start (avoid spam)
    if not hasattr(download_video, "_pot_health_done"):
        _pot_health_log()
        setattr(download_video, "_pot_health_done", True)

    # Build ordered attempts: default (no explicit client) first, then spec chain
    # Skip duplicate "web" if default already covers web behavior.
    attempts: list[str | None] = [None] + PLAYER_CLIENTS_ORDER

    last_error: Exception | None = None
    last_detail = ""

    # Acquire global rate limiter for the whole fallback sequence (hold semaphore across attempts)
    with rate_limiter:
        for idx, client in enumerate(attempts, start=1):
            _log_attempt(client, url, idx)
            try:
                info = _extraction_attempt(url, out_dir, client, _hook, client_cookies_path, timeout or 90.0)
                # Success – locate file
                if info is None:
                    raise RuntimeError("yt-dlp returned no info")
                # Empty formats check (retryable)
                formats = info.get("formats") or []
                # yt-dlp may return extractor info without formats when bot-blocked
                if not formats and info.get("extractor") == "youtube":
                    # Check if we got a live/empty response – treat as retryable
                    detail = "No video formats found (possibly bot-blocked)"
                    if is_retryable_error(detail):
                        raise yt_dlp.utils.DownloadError(detail)  # type: ignore

                # Locate file on disk
                video_id = (info or {}).get("id")
                video_path = None
                if video_id:
                    cand_mp4 = os.path.join(out_dir, f"{video_id}.mp4")
                    if os.path.isfile(cand_mp4):
                        video_path = cand_mp4
                    else:
                        for name in os.listdir(out_dir):
                            if name.startswith(str(video_id)):
                                video_path = os.path.join(out_dir, name)
                                break
                if not video_path:
                    # Fallback: any file in out_dir
                    candidates = [os.path.join(out_dir, f) for f in os.listdir(out_dir) if os.path.isfile(os.path.join(out_dir, f))]
                    if len(candidates) == 1:
                        video_path = candidates[0]
                    elif candidates:
                        # Pick largest
                        video_path = max(candidates, key=lambda p: os.path.getsize(p))

                if not video_path or not os.path.isfile(video_path):
                    raise RuntimeError("Download finished but no output file was found.")

                # Record success
                method = client or "default"
                _record_success(method, with_pot=with_pot)
                logger.info("download_video succeeded via %s (pot=%s) -> %s", method, with_pot, video_path)
                # Progress completion
                if progress:
                    progress(1.0)

                # Derive format/ext
                fmt = (info.get("format") or info.get("ext") or "mp4")
                ext = os.path.splitext(video_path)[1].lstrip(".") or (info.get("ext") or "mp4")

                return DownloadResult(
                    video_path=video_path,
                    method_used=method,
                    client=method,
                    format=str(fmt),
                    ext=ext,
                    video_id=video_id,
                    info=info,
                    with_pot=with_pot,
                )

            except Exception as exc:
                # Normalize detail
                detail = _strip_ansi(str(exc))
                # Unwrap yt-dlp DownloadError for matching
                last_error = exc
                last_detail = detail
                client_label = client or "default"
                _record_failure(client_label)
                logger.warning("yt-dlp attempt client=%s failed: %s", client_label, detail[:400])

                # Decide fallback vs fatal
                if isinstance(exc, TimeoutError):
                    # Timeout is retryable unless last attempt
                    _clean_out_dir(out_dir)
                    if idx >= len(attempts):
                        break
                    continue

                # Check if yt-dlp error is retryable
                if is_retryable_error(detail) or is_empty_formats_error(detail):
                    _clean_out_dir(out_dir)
                    if idx >= len(attempts):
                        break
                    # Small pacing between retries
                    time.sleep(0.5)
                    continue
                else:
                    # Fatal – do not try remaining clients (e.g., private video)
                    # But if this was the default attempt and error is ambiguous, try one fallback
                    if idx == 1 and _RETRYABLE_RE.search(detail) is None and _FATAL_RE.search(detail) is None:
                        # Ambiguous error on first attempt – try next client once
                        _clean_out_dir(out_dir)
                        continue
                    # Definite fatal
                    _clean_out_dir(out_dir)
                    break

    # Exhausted – surface with hint
    from core.youtube import _BOT_GUARD_HINT, _UPLOAD_HINT  # type: ignore

    detail = _strip_ansi(str(last_error or last_detail or "unknown error"))
    hint = ""
    if is_retryable_error(detail):
        hint = _BOT_GUARD_HINT
    # If safe prod hint needed, caller handles; keep generic
    raise _make_download_error(f"Download failed after {len(attempts)} attempts (last: {detail}){hint}", last_error)


def _make_download_error(msg: str, cause: Exception | None):
    from core.youtube import DownloadError
    exc = DownloadError(msg)
    if cause is not None:
        exc.__cause__ = cause
    return exc


# ---------------------------------------------------------------------------
# get_info resilient variant
# ---------------------------------------------------------------------------

def get_info_resilient(url: str, *, timeout: float | None = None) -> dict:
    """Fetch metadata with same fallback chain (for pipeline language hint)."""
    from core.youtube import DownloadError, _validate_source, _strip_ansi  # type: ignore

    _validate_source(url)
    if yt_dlp is None:
        raise DownloadError("yt-dlp is not installed")

    if timeout is None:
        try:
            timeout = float(os.environ.get("YTDLP_ATTEMPT_TIMEOUT", os.environ.get("YTDLP_TIMEOUT", "60")).strip())
        except ValueError:
            timeout = 60.0

    attempts: list[str | None] = [None] + PLAYER_CLIENTS_ORDER
    last_error: Exception | None = None

    with rate_limiter:
        for idx, client in enumerate(attempts, start=1):
            opts = {
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "skip_download": True,
                "remote_components": ["ejs:github"],
            }
            if client:
                opts["extractor_args"] = {"youtube": {"player_client": client}}
            _apply_pot_provider(opts)
            opts.update(_pacing_opts())
            # Cookies
            try:
                from core.youtube import _apply_cookie_and_po_opts
                _apply_cookie_and_po_opts(opts, player_clients=[client] if client else None)
            except Exception:
                pass

            def _do():
                with yt_dlp.YoutubeDL(opts) as ydl:
                    return ydl.extract_info(url, download=False)

            try:
                info = _run_with_timeout(_do, timeout or 60.0)
                if info is not None:
                    _record_success(client or "default", with_pot=bool(_pot_provider_url()))
                    return info
            except Exception as exc:
                last_error = exc
                detail = _strip_ansi(str(exc))
                _record_failure(client or "default")
                logger.warning("get_info attempt client=%s failed: %s", client or "default", detail[:300])
                if is_retryable_error(detail) and idx < len(attempts):
                    continue
                if idx == 1 and not _FATAL_RE.search(detail) and idx < len(attempts):
                    continue
                break

    detail = _strip_ansi(str(last_error or "unknown error"))
    from core.youtube import _BOT_GUARD_HINT
    hint = _BOT_GUARD_HINT if is_retryable_error(detail) else ""
    from core.youtube import DownloadError
    raise DownloadError(f"Could not fetch video metadata: {detail}{hint}") from last_error

