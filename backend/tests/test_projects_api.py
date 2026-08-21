"""Tests for the projects API (list/create/detail/start/render)."""

from __future__ import annotations

from app import db
from helpers import register_user


def _make_project(client):
    return client.post(
        "/api/v1/projects", json={"title": "Mine", "source": "https://youtu.be/abc"}
    ).json()


def _make_clip(project_id: str):
    """Insert a clip (with a real analyze job as its parent, to satisfy the
    clips.job_id FK) and return its id."""
    job = db.create_job(project_id, {}, job_type="analyze")
    return db.add_clip(
        project_id=project_id,
        job_id=job["id"],
        title="The hook",
        viral_hook="You won't believe this",
        start=12.5,
        end=38.0,
        video_url=None,
        thumbnail_url=None,
    )


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
    assert job["type"] == "analyze"
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


# ------------------------------------------------------------------ render


def test_project_detail_exposes_source_video_url_and_clip_state(client, monkeypatch):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])

    monkeypatch.setattr(
        "app.api.projects._presigned",
        lambda key: f"https://signed.example/{key}" if key else None,
    )

    res = client.get(f"/api/v1/projects/{project['id']}")
    assert res.status_code == 200
    data = res.json()
    assert data["source_video_url"] == "https://signed.example/projects/x/source.mp4"
    assert len(data["clips"]) == 1
    clip = data["clips"][0]
    assert clip["id"] == clip_id
    assert clip["video_url"] is None
    assert clip["signed_video_url"] is None  # no video_url yet, nothing to sign
    assert clip["render_job"] is None


def test_render_clip_creates_render_job_and_enqueues(client):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])

    res = client.post(
        f"/api/v1/projects/{project['id']}/clips/{clip_id}/render",
        json={"orientation": "portrait"},
    )
    assert res.status_code == 201
    job = res.json()
    assert job["type"] == "render"
    assert job["clip_id"] == clip_id
    assert job["status"] == "queued"
    assert job["id"] in client._submitted_jobs


def test_render_clip_conflict_when_already_rendering(client):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])

    first = client.post(f"/api/v1/projects/{project['id']}/clips/{clip_id}/render", json={})
    assert first.status_code == 201

    second = client.post(f"/api/v1/projects/{project['id']}/clips/{clip_id}/render", json={})
    assert second.status_code == 409


def test_render_clip_conflict_when_already_rendered(client):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])
    db.set_clip_video_url(clip_id, "projects/x/clips/rendered.mp4")

    res = client.post(f"/api/v1/projects/{project['id']}/clips/{clip_id}/render", json={})
    assert res.status_code == 409


def test_render_clip_not_found_for_other_user(client):
    register_user(client, email="owner@example.com")
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])

    client.post("/api/v1/auth/logout")
    register_user(client, email="other@example.com")

    res = client.post(f"/api/v1/projects/{project['id']}/clips/{clip_id}/render", json={})
    assert res.status_code == 404


def test_render_clip_not_found_for_missing_clip(client):
    register_user(client)
    project = _make_project(client)
    res = client.post(f"/api/v1/projects/{project['id']}/clips/does-not-exist/render", json={})
    assert res.status_code == 404


# ---------------------------------------------------------- caption styles


def _classic_style_id():
    style = db.get_caption_style_by_key("classic")
    assert style is not None  # seeded by migration
    return style["id"]


def test_list_caption_styles_requires_auth(client):
    assert client.get("/api/v1/caption-styles").status_code == 401


def test_list_caption_styles_returns_seeded_presets(client):
    register_user(client)
    res = client.get("/api/v1/caption-styles")
    assert res.status_code == 200
    styles = res.json()
    keys = {s["key"] for s in styles}
    assert {"classic", "clean", "pop", "boxed", "minimal"} <= keys
    classic = next(s for s in styles if s["key"] == "classic")
    assert classic["label"] == "Classic"
    assert "font" in classic["config"]
    assert classic["is_builtin"] is True


def test_render_clip_with_caption_style(client):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])
    style_id = _classic_style_id()

    res = client.post(
        f"/api/v1/projects/{project['id']}/clips/{clip_id}/render",
        json={"orientation": "portrait", "caption_style_id": style_id},
    )
    assert res.status_code == 201
    job = res.json()
    assert job["options"] == {"orientation": "portrait", "caption_style_id": style_id}


def test_render_clip_re_render_with_caption_style_when_already_rendered(client):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])
    db.set_clip_video_url(clip_id, "projects/x/clips/old.mp4")
    style_id = _classic_style_id()

    res = client.post(
        f"/api/v1/projects/{project['id']}/clips/{clip_id}/render",
        json={"caption_style_id": style_id},
    )
    assert res.status_code == 201  # re-render allowed when a style is requested


def test_render_clip_invalid_caption_style_400(client):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])

    res = client.post(
        f"/api/v1/projects/{project['id']}/clips/{clip_id}/render",
        json={"caption_style_id": "no-such-style"},
    )
    assert res.status_code == 400


def test_project_detail_reports_caption_style_id_for_rendered_clip(client, monkeypatch):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])
    style_id = _classic_style_id()

    # simulate a completed render with a caption style
    render_job = db.create_job(
        project["id"],
        {"orientation": "portrait", "caption_style_id": style_id},
        job_type="render",
        clip_id=clip_id,
    )
    db.update_job(render_job["id"], status="completed")
    db.set_clip_video_url(clip_id, "projects/x/clips/rendered.mp4")

    monkeypatch.setattr(
        "app.api.projects._presigned",
        lambda key: f"https://signed.example/{key}" if key else None,
    )

    res = client.get(f"/api/v1/projects/{project['id']}")
    assert res.status_code == 200
    clip = res.json()["clips"][0]
    assert clip["video_url"] == "projects/x/clips/rendered.mp4"
    assert clip["caption_style_id"] == style_id


def test_project_detail_caption_style_none_for_unrendered(client):
    register_user(client)
    project = _make_project(client)
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    clip_id = _make_clip(project["id"])

    res = client.get(f"/api/v1/projects/{project['id']}")
    assert res.status_code == 200
    clip = res.json()["clips"][0]
    assert clip["video_url"] is None
    assert clip["caption_style_id"] is None
