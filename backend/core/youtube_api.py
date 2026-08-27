"""Official YouTube Data API v3 wrapper – safe prod alternative to yt-dlp cookies.

Uses a server API key (YOUTUBE_API_KEY) or per-user OAuth – never a
shared Google session.  Only metadata is fetched; video bytes are
*not* downloaded via this API (ToS-compliant).  The pipeline must
still obtain bytes via user upload or, if ENABLE_YTDLP=1, via the
legacy yt-dlp path.

Set YOUTUBE_API_KEY in backend/.env (Cloud Console → YouTube Data API v3).
"""

from __future__ import annotations

import logging
import os
import re

import requests

logger = logging.getLogger(__name__)

_YT_ID_RE = re.compile(r"(?:v=|youtu\.be/|embed/|shorts/)([A-Za-z0-9_-]{11})")


def extract_video_id(url: str) -> str | None:
    m = _YT_ID_RE.search(url)
    return m.group(1) if m else None


def get_info_official(url: str, api_key: str | None = None) -> dict | None:
    """Fetch metadata via youtube.googleapis.com. Returns yt-dlp-shaped dict or None.

    Returns None if api_key missing or video not found – caller should fallback.
    Never raises for auth/network errors (returns None, logs warning).
    """
    api_key = (api_key or os.environ.get("YOUTUBE_API_KEY", "").strip())
    if not api_key:
        return None
    vid = extract_video_id(url)
    if not vid:
        return None
    try:
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/videos",
            params={
                "part": "snippet,contentDetails,statistics,status",
                "id": vid,
                "key": api_key,
            },
            timeout=15,
        )
        if resp.status_code == 403:
            logger.warning("YouTube Data API 403 (quota or key invalid): %s", resp.text[:300])
            return None
        resp.raise_for_status()
        data = resp.json()
        items = data.get("items") or []
        if not items:
            logger.info("YouTube Data API: video %s not found", vid)
            return None
        item = items[0]
        snippet = item.get("snippet", {})
        # Shape like yt-dlp info for pipeline compatibility
        return {
            "id": vid,
            "title": snippet.get("title") or "",
            "uploader": snippet.get("channelTitle") or "",
            "channel_id": snippet.get("channelId") or "",
            "description": snippet.get("description") or "",
            "language": snippet.get("defaultAudioLanguage", "")[:2] or None,  # e.g. en-US → en
            "original_language": snippet.get("defaultLanguage") or None,
            "duration": item.get("contentDetails", {}).get("duration"),
            "_official": True,  # marker: bytes not available via this path
            "_raw": item,
        }
    except Exception as exc:  # pragma: no cover
        logger.warning("YouTube Data API get_info failed for %s: %s", url, exc)
        return None


def is_official_enabled() -> bool:
    return bool(os.environ.get("YOUTUBE_API_KEY", "").strip())


def download_via_official_supported() -> bool:
    """Official API never supports byte download for arbitrary videos."""
    return False
