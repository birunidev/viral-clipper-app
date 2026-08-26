"""Tests for the source-URL safety guard (SSRF prevention)."""

from __future__ import annotations

import pytest

from core.urlguard import UrlNotAllowed, validate_source_url


def test_accepts_youtube_hosts():
    for url in (
        "https://www.youtube.com/watch?v=abc",
        "https://youtube.com/watch?v=abc",
        "https://youtu.be/abc",
        "https://music.youtube.com/watch?v=abc",
    ):
        assert validate_source_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:8000/api/v1/auth/me",
        "http://127.0.0.1/x",
        "http://192.168.1.10/admin",
        "http://10.0.0.5/internal",
        "file:///etc/passwd",
        "ftp://example.com/video.mp4",
        "javascript:alert(1)",
        "https://evil.example.com/watch?v=abc",  # not a YouTube host
        "not a url at all",
        "",
    ],
)
def test_rejects_non_public_and_non_youtube(url):
    with pytest.raises(UrlNotAllowed):
        validate_source_url(url)


def test_rejects_youtube_lookalike_subdomains_of_other_domains():
    # evil-youtube.com is NOT a subdomain of youtube.com.
    with pytest.raises(UrlNotAllowed):
        validate_source_url("https://evil-youtube.com/watch")


def test_rejects_host_resolving_to_private_address(monkeypatch):
    """A hostname that passes the allowlist but resolves to an internal IP
    (DNS rebinding / internal DNS entry) must still be rejected."""
    import socket

    def fake_getaddrinfo(host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(UrlNotAllowed):
        validate_source_url("https://www.youtube.com/watch?v=abc")
