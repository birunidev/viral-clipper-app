"""Tests for the per-user storage quota (core.storage + API enforcement)."""

from __future__ import annotations

import pytest

from app import db
from core import storage
from helpers import register_user

MB = 1024 * 1024


def _make_project(client, source_type="upload", source_size=10 * MB):
    return client.post(
        "/api/v1/projects",
        json={
            "title": "P",
            "source": "uploads/abc.mp4" if source_type == "upload" else "https://youtu.be/x",
            "source_type": source_type,
            "source_size_bytes": source_size,
        },
    )


def test_storage_cap_constant():
    assert storage.STORAGE_CAP_BYTES == 100 * MB


def test_add_and_used_roundtrip(client):
    register_user(client, email="s@example.com")
    user = db.get_user_by_email("s@example.com")
    assert storage.storage_used(user["id"]) == 0
    storage.add_storage(user["id"], 5 * MB)
    assert storage.storage_used(user["id"]) == 5 * MB
    storage.add_storage(user["id"], -5 * MB)
    assert storage.storage_used(user["id"]) == 0
    # Never drops below zero.
    storage.add_storage(user["id"], -99 * MB)
    assert storage.storage_used(user["id"]) == 0


def test_enforce_cap_ok_when_under(client):
    register_user(client, email="s2@example.com")
    user = db.get_user_by_email("s2@example.com")
    storage.add_storage(user["id"], 50 * MB)
    # 50 + 49 = 99MB < 100MB -> ok.
    storage.enforce_cap(user["id"], 49 * MB)


def test_enforce_cap_raises_when_over(client):
    register_user(client, email="s3@example.com")
    user = db.get_user_by_email("s3@example.com")
    storage.add_storage(user["id"], 90 * MB)
    with pytest.raises(storage.StorageQuotaExceeded):
        storage.enforce_cap(user["id"], 20 * MB)


def test_uploaded_project_counts_toward_storage(client):
    register_user(client, email="u@example.com")
    res = _make_project(client, source_size=20 * MB)
    assert res.status_code == 201
    user = db.get_user_by_email("u@example.com")
    assert storage.storage_used(user["id"]) == 20 * MB


def test_uploaded_project_over_cap_rejected(client):
    register_user(client, email="u2@example.com")
    res = _make_project(client, source_size=101 * MB)
    assert res.status_code == 409
    assert "Storage limit" in res.json()["detail"]
    user = db.get_user_by_email("u2@example.com")
    assert storage.storage_used(user["id"]) == 0


def test_presign_rejected_when_near_cap(client, monkeypatch):
    register_user(client, email="u3@example.com")
    user = db.get_user_by_email("u3@example.com")
    storage.add_storage(user["id"], storage.STORAGE_CAP_BYTES)

    res = client.post(
        "/api/v1/uploads/presign", json={"file_name": "v.mp4", "content_type": "video/mp4"}
    )
    assert res.status_code == 409
    assert "Storage limit" in res.json()["detail"]


def test_presign_allowed_when_room_available(client, monkeypatch):
    register_user(client, email="u4@example.com")
    user = db.get_user_by_email("u4@example.com")
    storage.add_storage(user["id"], 10 * MB)

    monkeypatch.setattr(
        "core.s3.presign_put_url",
        lambda key, content_type, expires=3600: f"https://example.com/{key}",
    )
    res = client.post(
        "/api/v1/uploads/presign", json={"file_name": "v.mp4", "content_type": "video/mp4"}
    )
    assert res.status_code == 200
    assert res.json()["key"].startswith("uploads/")


def test_delete_project_frees_storage(client, monkeypatch):
    register_user(client, email="d@example.com")
    user = db.get_user_by_email("d@example.com")

    project = _make_project(client, source_size=30 * MB).json()
    job = db.create_job(project["id"], {}, job_type="analyze")
    clip_id = db.add_clip(
        project_id=project["id"],
        job_id=job["id"],
        title="C",
        viral_hook=None,
        start=0,
        end=10,
        video_url="projects/x/clips/c.mp4",
        thumbnail_url=None,
    )
    # Bump project storage for the render the same way the pipeline would.
    storage.add_project_storage(project["id"], user["id"], 5 * MB)
    assert storage.storage_used(user["id"]) == 35 * MB

    deleted = []
    monkeypatch.setattr(
        "core.s3.delete_object", lambda bucket, key: deleted.append((bucket, key))
    )
    monkeypatch.setenv("S3_BUCKET", "test-bucket")

    res = client.delete(f"/api/v1/projects/{project['id']}")
    assert res.status_code == 204
    # Project + clip rows gone (cascade), storage freed back to zero.
    assert db.get_project(project["id"]) is None
    assert db.get_clip(clip_id) is None
    assert storage.storage_used(user["id"]) == 0
    # S3 objects deleted: source + rendered clip.
    keys = [k for _, k in deleted]
    assert "uploads/abc.mp4" in keys
    assert "projects/x/clips/c.mp4" in keys


def test_delete_project_requires_auth(client):
    assert client.delete("/api/v1/projects/xyz").status_code == 401


def test_delete_project_other_users_404(client):
    register_user(client, email="a@example.com")
    project = _make_project(client, source_size=1 * MB).json()
    client.post("/api/v1/auth/logout")
    register_user(client, email="b@example.com")
    assert client.delete(f"/api/v1/projects/{project['id']}").status_code == 404
