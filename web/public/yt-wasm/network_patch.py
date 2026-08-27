"""
Monkey-patches Python's stdlib networking so yt-dlp's outgoing HTTP
requests are routed through a configurable CORS proxy via the browser's
synchronous XMLHttpRequest (only legal inside a Web Worker).

This patch is only needed for the metadata-extraction step: once yt-dlp
has returned the format URLs, the main thread fetches the actual media
bytes directly from googlevideo (which serves CORS headers).

How it connects Python <-> browser:
  1. yt-dlp calls urllib.request.urlopen / opener.open OR yt_dlp.networking.RequestDirector.send
  2. Our patched handlers read the URL + headers off the Request,
     hands them to a JS XMLHttpRequest pointed at the proxy, blocks
     until the response arrives, and wraps the bytes in an object
     that quacks like http.client.HTTPResponse / yt_dlp.networking.Response
  3. The proxy unwraps the X-YTDLP-* headers, performs the real
     HTTPS request server-side, and streams bytes back. The browser
     sees an ordinary same-origin (CORS-allowed) response.
"""

from __future__ import annotations

import io
import urllib.request
import urllib.error
import urllib.response
from email.message import Message

import js  # provided by Pyodide

_PROXY_URL = ""  # set via install(proxy_url)
_PATCHED_YTDLP = False


class _ProxyResponse(io.BytesIO):
    """Minimum surface area to satisfy urllib + yt-dlp consumers."""

    def __init__(self, body: bytes, status: int, headers: dict, url: str):
        super().__init__(body)
        self.status = status
        self.code = status
        self.reason = ""
        self.url = url
        msg = Message()
        for k, v in headers.items():
            msg[k] = v
        self.headers = msg
        self.msg = msg

    def info(self):
        return self.headers

    def getcode(self):
        return self.status

    def geturl(self):
        return self.url

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def getheaders(self):
        return list(self.headers.items())


def _xhr_fetch(url: str, body, headers: dict, method: str):
    """Block on a synchronous XHR routed through the proxy."""
    if not _PROXY_URL:
        raise urllib.error.URLError(
            f"No metadata proxy configured; cannot fetch {url}"
        )

    # Only proxy http/https; let data/file urls through native path
    if not url.startswith("http://") and not url.startswith("https://"):
        raise urllib.error.URLError(f"Non-http URL not proxied: {url}")

    xhr = js.XMLHttpRequest.new()
    target = f"{_PROXY_URL}/proxy?url={js.encodeURIComponent(url)}"
    xhr.open(method, target, False)  # synchronous — Worker only
    xhr.responseType = "arraybuffer"

    # Forward every original header under an X-YTDLP- prefix so the
    # browser doesn't strip "forbidden" headers like User-Agent / Cookie.
    for k, v in (headers or {}).items():
        try:
            xhr.setRequestHeader(f"X-YTDLP-{k}", str(v))
        except Exception:
            pass

    if body is None:
        xhr.send()
    else:
        # Handle JsProxy bodies (Pyodide ffi) – convert to Python bytes first
        if hasattr(body, "to_py"):
            try:
                py_val = body.to_py()
                if isinstance(py_val, memoryview):
                    body = py_val.tobytes()
                elif isinstance(py_val, (bytes, bytearray)):
                    body = bytes(py_val)
                elif isinstance(py_val, str):
                    body = py_val.encode()
                elif py_val is not None:
                    try:
                        body = bytes(py_val)
                    except Exception:
                        body = str(py_val).encode()
                else:
                    body = None
            except Exception:
                try:
                    body = str(body).encode()
                except Exception:
                    body = None
        if body is None:
            xhr.send()
        elif isinstance(body, (bytes, bytearray, memoryview)):
            if isinstance(body, memoryview):
                body = body.tobytes()
            if isinstance(body, bytearray):
                body = bytes(body)
            # Now body is bytes – create JS Uint8Array
            try:
                # Proven method: double Uint8Array via memoryview
                buf = js.Uint8Array.new(len(body))
                buf.assign(js.Uint8Array.new(memoryview(body).tobytes()))
                xhr.send(buf)
            except Exception:
                # Fallback: try direct
                try:
                    xhr.send(js.Uint8Array.new(body))
                except Exception:
                    xhr.send(str(body))
        elif isinstance(body, str):
            xhr.send(body)
        else:
            try:
                b = bytes(body)
                buf = js.Uint8Array.new(len(b))
                buf.assign(js.Uint8Array.new(memoryview(b).tobytes()))
                xhr.send(buf)
            except Exception:
                xhr.send(str(body))

    if xhr.status == 0:
        raise urllib.error.URLError(f"Network error fetching {url}")

    arr = js.Uint8Array.new(xhr.response)
    py_bytes = bytes(arr.to_py())

    out_headers: dict[str, str] = {}
    for raw in (xhr.getAllResponseHeaders() or "").splitlines():
        if ":" in raw:
            k, v = raw.split(":", 1)
            out_headers[k.strip()] = v.strip()

    return py_bytes, int(xhr.status), out_headers


def patched_urlopen(req, data=None, timeout=None, *, cafile=None, capath=None,
                    cadefault=False, context=None):
    if isinstance(req, str):
        url, headers, method = req, {}, "GET"
        body = data
    else:
        url = req.full_url
        headers = dict(req.header_items()) if hasattr(req, "header_items") else dict(getattr(req, "headers", {}))
        method = req.get_method() if hasattr(req, "get_method") else "GET"
        body = data if data is not None else getattr(req, "data", None)

    body_bytes, status, resp_headers = _xhr_fetch(url, body, headers, method)

    if status >= 400:
        raise urllib.error.HTTPError(url, status, resp_headers.get("status", ""),
                                     _headers_to_message(resp_headers),
                                     io.BytesIO(body_bytes))

    return _ProxyResponse(body_bytes, status, resp_headers, url)


def _headers_to_message(headers: dict) -> Message:
    m = Message()
    for k, v in headers.items():
        m[k] = v
    return m


class _ProxyOpener(urllib.request.OpenerDirector):
    """Replaces every default handler with our single proxy call."""

    def open(self, fullurl, data=None, timeout=None):
        return patched_urlopen(fullurl, data=data, timeout=timeout)


def _patch_yt_dlp_networking():
    """Patch yt_dlp.networking layer (UrllibRH + RequestDirector) to use XHR proxy."""
    global _PATCHED_YTDLP
    if _PATCHED_YTDLP:
        return
    try:
        from yt_dlp.networking._urllib import UrllibRH
        from yt_dlp.networking.common import RequestDirector, Response
        from yt_dlp.networking.exceptions import HTTPError, NoSupportingHandlers
    except ImportError as e:
        print(f"[network_patch] yt_dlp networking not available (skip): {e}")
        return

    # --- Patch UrllibRH._send ---
    try:
        orig_urllib_send = UrllibRH._send

        def patched_urllib_send(self, request):
            url = request.url
            # bypass for non-http (data:, file:)
            if not url.startswith("http://") and not url.startswith("https://"):
                return orig_urllib_send(self, request)
            headers = dict(request.headers) if hasattr(request, "headers") else {}
            method = getattr(request, "method", "GET")
            data = getattr(request, "data", None)
            # Normalize data: bytes / bytearray / file-like / iterable / JsProxy
            body = None
            if data is not None:
                # Handle JsProxy first
                if hasattr(data, "to_py"):
                    try:
                        data = data.to_py()
                        if isinstance(data, memoryview):
                            data = data.tobytes()
                    except Exception:
                        pass
                if isinstance(data, (bytes, bytearray)):
                    body = bytes(data)
                elif hasattr(data, "read"):
                    try:
                        body = data.read()
                        if hasattr(body, "to_py"):
                            try:
                                body = body.to_py()
                                if isinstance(body, memoryview):
                                    body = body.tobytes()
                            except Exception:
                                pass
                        if isinstance(body, str):
                            body = body.encode()
                        elif isinstance(body, memoryview):
                            body = body.tobytes()
                        elif not isinstance(body, (bytes, bytearray)) and body is not None:
                            try:
                                body = bytes(body)
                            except Exception:
                                body = str(body).encode()
                    except Exception:
                        body = None
                elif isinstance(data, str):
                    body = data.encode()
                elif isinstance(data, memoryview):
                    body = data.tobytes()
                else:
                    # iterable of bytes
                    try:
                        body = b"".join(data)  # type: ignore
                    except Exception:
                        try:
                            body = bytes(data)
                        except Exception:
                            body = None
            try:
                body_bytes, status, resp_headers = _xhr_fetch(url, body, headers, method)
            except urllib.error.URLError as e:
                # For non-http fallback, try original
                if "Non-http" in str(e):
                    return orig_urllib_send(self, request)
                raise
            import io as _io
            fp = _io.BytesIO(body_bytes)
            resp = Response(fp=fp, headers=resp_headers, url=url, status=status)
            if status >= 400:
                raise HTTPError(resp)
            return resp

        UrllibRH._send = patched_urllib_send
        print("[network_patch] patched UrllibRH._send")
    except Exception as e:
        print(f"[network_patch] failed to patch UrllibRH: {e}")

    # --- Patch RequestDirector.send as fallback for any handler ordering ---
    try:
        orig_director_send = RequestDirector.send

        def patched_director_send(self, request):
            # Fast path: try our XHR directly for http/https; this bypasses handler preference issues
            # But first try original; if it succeeds we win, if NoSupportingHandlers we fallback
            try:
                return orig_director_send(self, request)
            except NoSupportingHandlers as e:
                url = getattr(request, "url", "")
                if not isinstance(url, str) or (not url.startswith("http://") and not url.startswith("https://")):
                    raise
                headers = dict(getattr(request, "headers", {}) or {})
                method = getattr(request, "method", "GET")
                data = getattr(request, "data", None)
                body = None
                if data is not None:
                    if hasattr(data, "to_py"):
                        try:
                            data = data.to_py()
                            if isinstance(data, memoryview):
                                data = data.tobytes()
                        except Exception:
                            pass
                    if isinstance(data, (bytes, bytearray)):
                        body = bytes(data)
                    elif hasattr(data, "read"):
                        try:
                            body = data.read()
                            if hasattr(body, "to_py"):
                                try:
                                    body = body.to_py()
                                    if isinstance(body, memoryview):
                                        body = body.tobytes()
                                except Exception:
                                    pass
                            if isinstance(body, str):
                                body = body.encode()
                            elif isinstance(body, memoryview):
                                body = body.tobytes()
                            elif not isinstance(body, (bytes, bytearray)) and body is not None:
                                try:
                                    body = bytes(body)
                                except Exception:
                                    body = str(body).encode()
                        except Exception:
                            body = None
                    elif isinstance(data, str):
                        body = data.encode()
                    elif isinstance(data, memoryview):
                        body = data.tobytes()
                    else:
                        try:
                            body = b"".join(data)  # type: ignore
                        except Exception:
                            try:
                                body = bytes(data)
                            except Exception:
                                body = None
                try:
                    body_bytes, status, resp_headers = _xhr_fetch(url, body, headers, method)
                except Exception as xhr_e:
                    # re-raise original NoSupportingHandlers with unexpected error appended
                    raise NoSupportingHandlers(e.unsupported_errors, e.unexpected_errors + [xhr_e]) from xhr_e
                import io as _io
                from yt_dlp.networking.common import Response as _Resp
                from yt_dlp.networking.exceptions import HTTPError as _HE
                fp = _io.BytesIO(body_bytes)
                resp = _Resp(fp=fp, headers=resp_headers, url=url, status=status)
                if status >= 400:
                    raise _HE(resp) from e
                return resp

        RequestDirector.send = patched_director_send
        print("[network_patch] patched RequestDirector.send")
    except Exception as e:
        print(f"[network_patch] failed to patch RequestDirector: {e}")

    _PATCHED_YTDLP = True


def install(proxy_url: str = "") -> None:
    """Configure the proxy URL and install the urllib + yt_dlp monkey-patches.

    proxy_url is the BASE URL of the proxy (e.g. http://localhost:8181);
    the patch will append /proxy?url=... to it. Empty string disables
    networking — callers will get URLError for any outgoing request.
    Call once before yt_dlp import for urllib, and again after `from yt_dlp import ...`
    to patch the networking layer.
    """
    global _PROXY_URL
    _PROXY_URL = (proxy_url or "").rstrip("/")

    urllib.request.urlopen = patched_urlopen
    urllib.request.install_opener(_ProxyOpener())

    # yt-dlp's modern networking layer instantiates urllib.request.OpenerDirector
    # itself inside UrllibRH; override the class-level open as a backstop.
    urllib.request.OpenerDirector.open = _ProxyOpener.open  # type: ignore[assignment]

    # Try to patch yt_dlp networking if already imported
    try:
        import sys
        if "yt_dlp" in sys.modules or "yt_dlp.networking" in sys.modules:
            _patch_yt_dlp_networking()
    except Exception:
        pass

    print("[network_patch] urllib routed through", _PROXY_URL or "<disabled>")
    if _PATCHED_YTDLP:
        print("[network_patch] yt_dlp networking routed through", _PROXY_URL or "<disabled>")


def install_yt_dlp(proxy_url: str | None = None) -> None:
    """Explicitly patch yt_dlp networking layer (call after `from yt_dlp import YoutubeDL`)."""
    global _PROXY_URL
    if proxy_url is not None:
        _PROXY_URL = proxy_url.rstrip("/")
    _patch_yt_dlp_networking()
    print("[network_patch] yt_dlp networking (explicit) routed through", _PROXY_URL or "<disabled>")
