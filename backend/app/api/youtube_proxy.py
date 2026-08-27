"""YouTube Innertube proxy for browser-side download.

POST /youtube/resolve  — resolves videoId via ANDROID client (no cookies, no PO).
GET  /youtube/proxy?url= — streams a googlevideo URL through backend (CORS fallback).

Both are auth-required (session cookie) to avoid open proxy abuse.
"""

from __future__ import annotations

import os
import re

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from ..security import SessionUser, current_user

router = APIRouter(prefix="/youtube", tags=["youtube"])

_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_INNERTUBE_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39"
_INNERTUBE_URL = f"https://www.youtube.com/youtubei/v1/player?key={_INNERTUBE_KEY}"


@router.post("/resolve")
def resolve(payload: dict, user: SessionUser = Depends(current_user)):
    video_id = (payload.get("videoId") or payload.get("video_id") or "").strip()
    if not _YT_ID_RE.match(video_id):
        raise HTTPException(status_code=400, detail="Invalid videoId")
    body = {
        "context": {
            "client": {
                "clientName": "ANDROID",
                "clientVersion": "19.09.37",
                "androidSdkVersion": 30,
                "hl": "en",
                "gl": "US",
            }
        },
        "videoId": video_id,
        "playbackContext": {"contentPlaybackContext": {"html5Preference": "HTML5_PREF_WANTS"}},
        "contentCheckOk": True,
        "racyCheckOk": True,
    }
    try:
        r = requests.post(INNERTUBE_URL, json=body, timeout=20, headers={"Content-Type": "application/json"})
        r.raise_for_status()
        data = r.json()
        # If innertube usable, return it
        if data.get("streamingData", {}).get("formats") or data.get("streamingData", {}).get("adaptiveFormats"):
            return JSONResponse(content=data)
        # Fallback: scrape watch page HTML (works for public videos without PO token)
        import json as _json
        import re as _re

        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        try:
            wr = requests.get(f"https://www.youtube.com/watch?v={video_id}", headers=headers, timeout=15)
            m = _re.search(r"ytInitialPlayerResponse\s*=\s*(\{.+?\});", wr.text)
            if m:
                j = _json.loads(m.group(1))
                if j.get("streamingData"):
                    return JSONResponse(content=j)
        except Exception:
            pass
        return JSONResponse(content=data)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"YouTube resolve failed: {exc}") from exc


@router.get("/proxy")
def proxy(request: Request, url: str, user: SessionUser = Depends(current_user)):
    # Only allow googlevideo and youtube domains
    if not (url.startswith("https://") and ("googlevideo.com" in url or "youtube.com" in url or "ytimg.com" in url)):
        raise HTTPException(status_code=400, detail="Only googlevideo/youtube URLs allowed")
    # Stream through
    try:
        upstream = requests.get(url, stream=True, timeout=30)
        upstream.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Upstream fetch failed: {exc}") from exc

    headers = {}
    for k in ("Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"):
        if k in upstream.headers:
            headers[k] = upstream.headers[k]
    # Use streaming response
    def gen():
        for chunk in upstream.iter_content(chunk_size=1 << 20):
            if chunk:
                yield chunk

    media = upstream.headers.get("Content-Type", "video/mp4")
    return StreamingResponse(gen(), media_type=media, headers=headers)


# Generic CORS proxy for youtubei.js browser usage (Innertube fetches youtube.com)
# Proxies any youtube.com youtubei / iframe_api / player JS through backend to avoid CORS
@router.api_route("/fetch", methods=["GET", "POST", "OPTIONS"])
async def youtube_fetch_proxy(request: Request, user: SessionUser = Depends(current_user)):
    # url via query param or JSON body
    url = request.query_params.get("url", "")
    if not url:
        try:
            body = await request.json()
            url = body.get("url", "") if isinstance(body, dict) else ""
        except Exception:
            pass
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")
    if not (url.startswith("https://www.youtube.com/") or url.startswith("https://youtube.com/") or url.startswith("https://www.youtube-nocookie.com/")):
        raise HTTPException(status_code=400, detail="Only youtube.com URLs allowed")

    method = request.method
    # Forward headers (filter)
    forward_headers = {}
    # youtubei needs Content-Type, maybe Origin
    if request.headers.get("content-type"):
        forward_headers["Content-Type"] = request.headers.get("content-type")
    forward_headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    forward_headers["Origin"] = "https://www.youtube.com"
    forward_headers["Referer"] = "https://www.youtube.com/"

    # Body for POST
    body_bytes = None
    if method in ("POST", "PUT", "PATCH"):
        body_bytes = await request.body()

    try:
        upstream = requests.request(
            method=method if method != "OPTIONS" else "GET",
            url=url,
            headers=forward_headers,
            data=body_bytes,
            timeout=30,
            stream=False,
        )
        # Return with CORS headers
        content_type = upstream.headers.get("Content-Type", "application/json")
        headers = {
            "Access-Control-Allow-Origin": request.headers.get("origin", "*"),
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Goog-Visitor-Id, X-Youtube-Client-Name, X-Youtube-Client-Version",
        }
        # Handle OPTIONS preflight
        if method == "OPTIONS":
            return JSONResponse(content={}, headers=headers)
        # Try JSON, else raw
        try:
            data = upstream.json()
            return JSONResponse(content=data, status_code=upstream.status_code, headers=headers)
        except Exception:
            return StreamingResponse(
                iter([upstream.content]),
                status_code=upstream.status_code,
                media_type=content_type,
                headers=headers,
            )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Proxy failed: {exc}") from exc
