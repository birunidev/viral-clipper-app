"""Tests for the projects API (list/create/detail/start)."""

from __future__ import annotations

from helpers import register_user


def test_list_projects_requires_auth(client):
    assert client.get("/api/v1/projects").status_code == 401


def test_create_and_list_project(client):
    register_user(client)

    res = client.post(
        "/api/v1/projects",
        json={"title": "My Video", "source": "https://youtu.be/abc", "source_type": "youtube"},
    )
    assert res.status_code == 201
    project = res.json()
    assert project["title"] == "My Video"
    assert project["source_type"] == "youtube"
    assert project["status"] == "idle"
    assert project["clip_count"] == 0

    res = client.get("/api/v1/projects")
    assert res.status_code == 200
    projects = res.json()
    assert len(projects) == 1
    assert projects[0]["id"] == project["id"]


def test_create_project_requires_source(client):
    register_user(client)
    res = client.post("/api/v1/projects", json={"title": "x", "source": "", "source_type": "youtube"})
    assert res.status_code in (400, 422)


def test_create_project_defaults_title_untitled(client):
    register_user(client)
    res = client.post("/api/v1/projects", json={"source": "https://youtu.be/abc"})
    assert res.status_code == 201
    assert res.json()["title"] == "Untitled"


def test_project_detail_not_found_for_other_user(client):
    register_user(client, email="owner@example.com")
    project = client.post(
        "/api/v1/projects", json={"title": "Mine", "source": "https://youtu.be/abc"}
    ).json()

    client.post("/api/v1/auth/logout")
    register_user(client, email="other@example.com")

    res = client.get(f"/api/v1/projects/{project['id']}")
    assert res.status_code == 404


def test_project_detail_includes_clips_and_jobs(client):
    register_user(client)
    project = client.post(
        "/api/v1/projects", json={"title": "Mine", "source": "https://youtu.be/abc"}
    ).json()

    res = client.get(f"/api/v1/projects/{project['id']}")
    assert res.status_code == 200
    data = res.json()
    assert data["clips"] == []
    assert data["jobs"] == []


def test_start_job_creates_job_and_enqueues(client):
    register_user(client)
    project = client.post(
        "/api/v1/projects", json={"title": "Mine", "source": "https://youtu.be/abc"}
    ).json()

    res = client.post(
        f"/api/v1/projects/{project['id']}/start",
        json={"orientation": "landscape", "max_clips": 5},
    )
    assert res.status_code == 201
    job = res.json()
    assert job["status"] == "queued"
    assert job["options"] == {"orientation": "landscape", "max_clips": 5}
    assert job["id"] in client._submitted_jobs

    project_after = client.get(f"/api/v1/projects/{project['id']}").json()
    assert project_after["status"] == "queued"


def test_start_job_conflict_when_already_running(client):
    register_user(client)
    project = client.post(
        "/api/v1/projects", json={"title": "Mine", "source": "https://youtu.be/abc"}
    ).json()

    first = client.post(f"/api/v1/projects/{project['id']}/start", json={})
    assert first.status_code == 201

    second = client.post(f"/api/v1/projects/{project['id']}/start", json={})
    assert second.status_code == 409


def test_start_job_not_found_for_missing_project(client):
    register_user(client)
    res = client.post("/api/v1/projects/does-not-exist/start", json={})
    assert res.status_code == 404
