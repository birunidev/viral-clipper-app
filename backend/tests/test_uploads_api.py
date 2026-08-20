"""Tests for the uploads API (presigned PUT URL)."""

from __future__ import annotations

from helpers import register_user


def test_presign_requires_auth(client):
    res = client.post(
        "/api/v1/uploads/presign", json={"file_name": "video.mp4", "content_type": "video/mp4"}
    )
    assert res.status_code == 401


def test_presign_returns_url_and_key(client, monkeypatch):
    register_user(client)
    monkeypatch.setattr(
        "core.s3.presign_put_url",
        lambda key, content_type, expires=3600: f"https://example.com/{key}?sig=abc",
    )

    res = client.post(
        "/api/v1/uploads/presign", json={"file_name": "My Video.MP4", "content_type": "video/mp4"}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["key"].startswith("uploads/")
    assert data["key"].endswith(".mp4")
    assert data["url"] == f"https://example.com/{data['key']}?sig=abc"


def test_presign_defaults_extension_to_bin_when_missing(client, monkeypatch):
    register_user(client)
    monkeypatch.setattr(
        "core.s3.presign_put_url",
        lambda key, content_type, expires=3600: f"https://example.com/{key}",
    )

    res = client.post("/api/v1/uploads/presign", json={"file_name": "noext"})
    assert res.status_code == 200
    assert res.json()["key"].endswith(".bin")


def test_presign_s3_error_returns_500(client, monkeypatch):
    register_user(client)

    def boom(key, content_type, expires=3600):
        from core.s3 import S3Error

        raise S3Error("no bucket configured")

    monkeypatch.setattr("core.s3.presign_put_url", boom)

    res = client.post(
        "/api/v1/uploads/presign", json={"file_name": "video.mp4", "content_type": "video/mp4"}
    )
    assert res.status_code == 500
