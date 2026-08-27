"""WASM metadata proxy – thin pass-through for yt-dlp-wasm extraction.

Mirrors `server/proxy.js` from https://forgejo.phillippepelzer.me/FiLL/yt-dlp-wasm:
  GET/POST /api/v1/yt-wasm/proxy?url=<encoded upstream URL>
  Request headers prefixed `x-ytdlp-` are unwrapped and forwarded to upstream
  (so yt-dlp's User-Agent/Cookie/Range survive). Response is streamed back
  with permissive CORS headers.

This proxy is ONLY for tiny metadata extraction (~10-50KB per video) – video
bytes are fetched directly from googlevideo.com by the browser (CORS allowed).
No logging/persistence, stateless, tiny.

Unlike the general youtube_proxy, this one does NOT require auth – the WASM
worker runs without a session cookie context (and CORS preflight). Rate limiting
is left to the caller's IP; the proxy is cheap if abuse is minimal. If abuse
appears, add auth or IP throttling here.
"""

from __future__ import annotations

import re
from typing import AsyncGenerator

from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse

import requests

router = APIRouter(prefix="/yt-wasm", tags=["yt-wasm-proxy"])

HEADER_PREFIX = "x-ytdlp-"
STRIP_REQ = {
    "host", "connection", "content-length", "origin", "referer",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
    "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
    "accept-encoding",
}
STRIP_RES = {
    "connection", "keep-alive", "transfer-encoding", "upgrade",
    "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "content-encoding", "content-length",
}

ALLOWED_UPSTREAM = re.compile(r"^https://(www\.youtube\.com|youtube\.com|m\.youtube\.com|music\.youtube\.com|www\.youtube-nocookie\.com|youtu\.be|.*\.googlevideo\.com|.*\.ytimg\.com|jnn-pa\.googlevideo\.com)/.*", re.I)

def _cors_headers() -> dict:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Expose-Headers": "*",
    }

@router.options("/proxy")
async def proxy_options():
    return Response(status_code=204, headers=_cors_headers())

@router.get("/proxy")
@router.post("/proxy")
@router.head("/proxy")
async def proxy(request: Request):
    # CORS preflight already handled, but handle OPTIONS here too
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_cors_headers())

    target = request.query_params.get("url", "")
    if not target or not re.match(r"^https?://", target, re.I):
        return Response(content="Missing or invalid ?url", status_code=400, headers=_cors_headers())

    # Optional allowlist – only youtube/googlevideo/ytimg; relax if needed for other yt-dlp sites
    # For now allow any https, but prefer allowlist above if you want lock-down:
    # if not ALLOWED_UPSTREAM.match(target):
    #     return Response(content="URL not allowed", status_code=403, headers=_cors_headers())
    # Keep open for generic yt-dlp (many sites) – so skip strict allowlist

    # Reconstruct upstream headers from X-YTDLP-* prefixed ones
    upstream_headers: dict[str, str] = {}
    for name, value in request.headers.items():
        lower = name.lower()
        if lower.startswith(HEADER_PREFIX):
            upstream_headers[lower[len(HEADER_PREFIX):]] = value
        elif lower not in STRIP_REQ and not lower.startswith("sec-") and not lower.startswith("x-"):
            upstream_headers[lower] = value
        # also copy x-ytdlp- case insensitive already handled

    if "user-agent" not in {k.lower() for k in upstream_headers}:
        upstream_headers["user-agent"] = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )

    body = None
    if request.method not in ("GET", "HEAD"):
        body = await request.body()

    # Forward via requests (sync) – metadata is tiny, blocking is fine
    try:
        # Use streaming to pipe back
        upstream = requests.request(
            method=request.method,
            url=target,
            headers=upstream_headers,
            data=body if body else None,
            stream=True,
            allow_redirects=True,
            timeout=20,
        )
    except Exception as exc:
        return Response(content=f"Upstream fetch failed: {exc}", status_code=502, headers=_cors_headers())

    # Build response headers
    headers = _cors_headers()
    for k, v in upstream.headers.items():
        if k.lower() in STRIP_RES:
            continue
        headers[k] = v

    # Check HLS manifest – rewrite URIs to proxy if needed
    ctype = str(upstream.headers.get("content-type", "")).lower()
    is_hls = "mpegurl" in ctype or re.search(r"\.m3u8(\?|$)", target, re.I)
    if is_hls:
        try:
            text = b"".join(upstream.iter_content(chunk_size=8192)).decode("utf-8", errors="ignore")
            # Minimal rewrite – proxify relative URIs
            def _rewrite_manifest(txt: str, manifest_url: str) -> str:
                import urllib.parse as up
                base_proxy = str(request.base_url).rstrip("/") + "/api/v1/yt-wasm/proxy"
                def proxify(raw: str) -> str:
                    absu = up.urljoin(manifest_url, raw)
                    return f"{base_proxy}?url={up.quote(absu, safe='')}"
                out_lines = []
                for line in txt.splitlines():
                    t = line.strip()
                    if not t:
                        out_lines.append(line)
                        continue
                    if t.startswith("#"):
                        if re.match(r"^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|SESSION-KEY|PART|PRELOAD-HINT|RENDITION-REPORT)", t, re.I):
                            line = re.sub(r'URI="([^"]+)"', lambda m: f'URI="{proxify(m.group(1))}"', line)
                        out_lines.append(line)
                    else:
                        out_lines.append(proxify(t))
                return "\n".join(out_lines)
            rewritten = _rewrite_manifest(text, target)
            headers["content-type"] = "application/vnd.apple.mpegurl"
            headers.pop("content-length", None)
            return Response(content=rewritten, status_code=upstream.status_code, headers=headers, media_type="application/vnd.apple.mpegurl")
        except Exception:
            pass  # fall through to streaming

    def iter_content():
        try:
            for chunk in upstream.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        finally:
            try:
                upstream.close()
            except:
                pass

    return StreamingResponse(iter_content(), status_code=upstream.status_code, headers=headers)
