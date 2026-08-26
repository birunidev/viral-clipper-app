"""Download videos from YouTube (and other yt-dlp supported sites).

Wraps ``yt-dlp`` so the rest of the pipeline can treat the result as a
plain local video file. Progress is reported via an optional callback.

YouTube sometimes rejects the default player client with HTTP 403
(bot detection). When that happens we retry once with alternate player
clients (android/tv/ios), which are generally allowed.
"""

from __future__ import annotations

import os
import re
import shutil
from typing import Callable

try:
    import yt_dlp
except ImportError:  # pragma: no cover - defensive
    yt_dlp = None

URL_RE = re.compile(r"^https?://", re.IGNORECASE)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
FALLBACK_CLIENTS = ["android_vr", "tv", "ios"]


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


def get_info(url: str) -> dict:
    """Fetch remote metadata (no download) for ``url``.

    Returns the yt-dlp extractor info dict, which includes useful fields such
    as ``id``, ``title``, ``uploader``, and ``language`` (the source video's
    spoken language as an ISO 639-1 code where available). Raises
    DownloadError if yt-dlp is missing or metadata cannot be fetched.
    """
    if yt_dlp is None:
        raise DownloadError("yt-dlp is not installed. Run: poetry install")

    _validate_source(url)

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False) or {}
    except yt_dlp.utils.DownloadError as exc:
        detail = _strip_ansi(str(exc))
        raise DownloadError(f"Could not fetch video metadata: {detail}") from exc


def is_url(value: str) -> bool:
    """Return True if ``value`` looks like a remote (http/https) URL."""
    return bool(URL_RE.match(value.strip()))


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


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
    }
    cookiefile = os.environ.get("YTDLP_COOKIEFILE", "").strip()
    if cookiefile:
        opts["cookiefile"] = cookiefile
    if player_clients:
        opts["extractor_args"] = {"youtube": {"player_client": player_clients}}
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
        raise DownloadError(f"Download failed: {detail}")

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
