"""Public reels endpoint: returns presigned R2 URLs for landing page.

Reels are stored in R2 under `reels/reel_*.mp4` and `reels/posters/*.jpg` with
metadata in `reels/reels.json` (uploaded from web/public/reels). This endpoint
is public (no auth) so the marketing page can fetch fresh presigned URLs
without exposing credentials to the browser.
"""

from __future__ import annotations

import json
import os

from fastapi import APIRouter

router = APIRouter(prefix="/reels", tags=["reels"])

# 7 days in seconds - R2 presigned URLs max is 7 days via S3
PRESIGNED_TTL = 7 * 24 * 3600


def _get_reels_bucket() -> str:
    """Reels bucket: dedicated `testing-bucket` for landing videos, fallback to main S3_BUCKET."""
    return (
        os.environ.get("REELS_BUCKET", "").strip()
        or os.environ.get("R2_REELS_BUCKET", "").strip()
        or os.environ.get("S3_REELS_BUCKET", "").strip()
        or os.environ.get("S3_BUCKET", "").strip()
        or "testing-bucket"
    )


def _presigned(key: str | None) -> str | None:
    if not key:
        return None
    from core.s3 import presigned_get_url

    bucket = _get_reels_bucket()
    if not bucket:
        return None
    try:
        return presigned_get_url(bucket, key, expires=PRESIGNED_TTL)
    except Exception:
        return None


@router.get("", response_model=list[dict])
def list_reels() -> list[dict]:
    """Return reels with fresh presigned URLs. Public, no auth required.

    Reads `reels/reels.json` from R2 (the manifest uploaded with the videos)
    and generates presigned GET URLs for each file/poster. Falls back to
    listing objects if manifest is missing.

    Uses dedicated `testing-bucket` (REELS_BUCKET) for reels, separate from
    main app bucket `clipzard-prod-bucket`.
    """
    from core.s3 import _client

    bucket = _get_reels_bucket()

    # Try to fetch manifest from R2
    manifest = None
    try:
        client = _client()
        obj = client.get_object(Bucket=bucket, Key="reels/reels.json")
        body = obj["Body"].read()
        manifest = json.loads(body)
    except Exception:
        manifest = None

    if manifest and isinstance(manifest, list) and len(manifest) > 0:
        # Generate presigned URLs for each entry
        result = []
        for entry in manifest:
            # Keys in R2 are like reels/reel_01.mp4, reels/posters/reel_01.jpg
            # The manifest's `file` is /reels/reel_01.mp4 -> strip leading /
            file_key = (entry.get("file") or "").lstrip("/")
            poster_key = (entry.get("poster") or "").lstrip("/")
            # Handle legacy absolute URLs or external CDN
            if file_key.startswith("http"):
                file_url = entry.get("file")
            else:
                file_url = _presigned(file_key) or entry.get("file")
            if poster_key.startswith("http"):
                poster_url = entry.get("poster")
            else:
                poster_url = _presigned(poster_key) or entry.get("poster")

            result.append(
                {
                    "file": file_url,
                    "poster": poster_url,
                    "youtubeId": entry.get("youtubeId"),
                    "handle": entry.get("handle", "@clipzard"),
                    "hook": entry.get("hook", ""),
                    "title": entry.get("title", ""),
                    "dur": entry.get("dur", ""),
                    "tag": entry.get("tag", "Viral"),
                    "views": entry.get("views", ""),
                }
            )
        return result

    # Fallback: list objects directly if manifest missing
    try:
        client = _client()
        resp = client.list_objects_v2(Bucket=bucket, Prefix="reels/reel_", MaxKeys=30)
        videos = [o["Key"] for o in resp.get("Contents", []) if o["Key"].endswith(".mp4")]
        videos.sort()
        result = []
        for key in videos[:30]:
            # Try to find matching poster
            poster_key = key.replace("reels/reel_", "reels/posters/reel_").replace(".mp4", ".jpg")
            try:
                client.head_object(Bucket=bucket, Key=poster_key)
                has_poster = True
            except Exception:
                has_poster = False
                poster_key = None
            result.append(
                {
                    "file": _presigned(key) or f"/{key}",
                    "poster": _presigned(poster_key) if has_poster else None,
                    "youtubeId": None,
                    "handle": "@clipzard",
                    "hook": "Viral moment",
                    "title": key.split("/")[-1],
                    "dur": "",
                    "tag": "Viral",
                    "views": "",
                }
            )
        return result
    except Exception:
        return []
