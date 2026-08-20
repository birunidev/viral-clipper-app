"""Tests for the jobs API (status polling)."""

from __future__ import annotations

from helpers import register_user


def _make_project(client):
    return client.post(
        "/api/v1/projects", json={"title": "Mine", "source": "https://youtu.be/abc"}
    ).json()


def test_get_job_requires_auth(client):
    assert client.get("/api/v1/jobs/xyz").status_code == 401


def test_get_job_returns_status_and_project(client):
    register_user(client)
    project = _make_project(client)
    job = client.post(f"/api/v1/projects/{project['id']}/start", json={}).json()

    res = client.get(f"/api/v1/jobs/{job['id']}")
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == job["id"]
    assert data["status"] == "queued"
    assert data["project"]["id"] == project["id"]
    assert data["project"]["title"] == "Mine"


def test_get_job_hides_other_users_jobs(client):
    register_user(client, email="owner@example.com")
    project = _make_project(client)
    job = client.post(f"/api/v1/projects/{project['id']}/start", json={}).json()

    client.post("/api/v1/auth/logout")
    register_user(client, email="other@example.com")

    res = client.get(f"/api/v1/jobs/{job['id']}")
    assert res.status_code == 404
