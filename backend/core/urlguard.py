"""URL safety guard for user-submitted source URLs.

The product's promise is "paste a YouTube link" — so source URLs are
allowlisted to YouTube hosts AND resolved to verify they point at public
internet addresses. Without this, yt-dlp happily fetches attacker-chosen
URLs from the server's network position: cloud metadata endpoints
(169.254.169.254), internal services, localhost admin panels — classic
blind SSRF, amplified by yt-dlp error text being reflected back to users.

Validation happens twice: at project creation (fail fast, clear message)
and again inside the downloader (defense in depth — covers retries and any
future caller that forgets).
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class UrlNotAllowed(ValueError):
    """Raised when a submitted source URL fails the safety policy."""


# Registrable YouTube hosts users actually paste. Subdomains of these are
# accepted (e.g. music.youtube.com); everything else is rejected.
ALLOWED_SOURCE_DOMAINS = (
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
)


def _host_allowed(hostname: str) -> bool:
    hostname = hostname.lower().rstrip(".")
    for domain in ALLOWED_SOURCE_DOMAINS:
        if hostname == domain or hostname.endswith("." + domain):
            return True
    return False


def _assert_public_ips(hostname: str) -> None:
    """Resolve ``hostname`` and reject anything that isn't globally routable."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except OSError as exc:
        raise UrlNotAllowed(f"Could not resolve video host: {hostname}") from exc

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        # is_global excludes loopback, RFC1918 private ranges, link-local
        # (incl. cloud metadata 169.254.169.254), CGNAT, multicast, etc.
        if not ip.is_global:
            raise UrlNotAllowed("Video host resolves to a non-public address.")


def validate_source_url(url: str) -> str:
    """Validate a user-submitted source URL; returns it unchanged on success.

    Raises :class:`UrlNotAllowed` with a safe, user-presentable message on
    any policy violation.
    """
    candidate = (url or "").strip()
    parsed = urlparse(candidate)
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise UrlNotAllowed("Only http(s) video URLs are supported.")
    hostname = parsed.hostname or ""
    if not hostname:
        raise UrlNotAllowed("The URL has no host name.")
    if not _host_allowed(hostname):
        raise UrlNotAllowed(
            "Only YouTube links are supported right now "
            "(youtube.com / youtu.be / music.youtube.com)."
        )
    _assert_public_ips(hostname)
    return candidate
