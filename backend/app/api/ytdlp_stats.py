"""Observability for resilient yt-dlp downloader.

GET /api/v1/youtube/stats – per-client success/failure counters and recommended order.
Auth required (any logged-in user) to avoid public scraping.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..security import SessionUser, current_user

router = APIRouter(prefix="/youtube", tags=["youtube"])


@router.get("/stats")
def ytdlp_stats(user: SessionUser = Depends(current_user)) -> dict:
    from core.downloader import get_method_stats, get_recommended_order, _current_ytdlp_version

    stats = get_method_stats()
    # Enrich with success rate
    enriched = {}
    for client, data in stats.items():
        succ = data.get("success", 0)
        fail = data.get("fail", 0)
        total = succ + fail
        rate = (succ / total) if total else None
        enriched[client] = {**data, "success_rate": rate, "total": total}

    return {
        "ytdlp_version": _current_ytdlp_version(),
        "stats": enriched,
        "recommended_order": get_recommended_order(),
    }
