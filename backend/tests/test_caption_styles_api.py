"""Tests for the caption-styles API (list built-ins, create custom styles)."""

from __future__ import annotations

from app import db
from helpers import register_user

CLASSIC_LIKE_CONFIG = {
    "font": "Anton",
    "font_size": 60,
    "x": "center",
    "y": 0.7,
    "bold": True,
    "italic": False,
    "primary_color": "#FFFFFF",
    "highlight_color": "#00FF00",
    "outline_color": "#000000",
    "outline": 3,
    "shadow": 0,
    "words_per_line": 4,
    "max_chars_per_line": 30,
    "boxed": False,
    "box_opacity": 0.0,
}


def test_create_caption_style_requires_auth(client):
    res = client.post(
        "/api/v1/caption-styles", json={"label": "My Style", "config": CLASSIC_LIKE_CONFIG}
    )
    assert res.status_code == 401


def test_create_caption_style_saves_custom_style(client):
    register_user(client)
    res = client.post(
        "/api/v1/caption-styles", json={"label": "My Style", "config": CLASSIC_LIKE_CONFIG}
    )
    assert res.status_code == 201
    data = res.json()
    assert data["label"] == "My Style"
    assert data["key"] == "my-style"
    assert data["is_builtin"] is False
    assert data["config"]["highlight_color"] == "#00FF00"

    # shows up in the list alongside the built-ins
    listed = client.get("/api/v1/caption-styles").json()
    assert any(s["id"] == data["id"] for s in listed)


def test_create_caption_style_generates_unique_key_on_label_collision(client):
    register_user(client)
    first = client.post(
        "/api/v1/caption-styles", json={"label": "Duplicate", "config": CLASSIC_LIKE_CONFIG}
    ).json()
    second = client.post(
        "/api/v1/caption-styles", json={"label": "Duplicate", "config": CLASSIC_LIKE_CONFIG}
    ).json()
    assert first["key"] == "duplicate"
    assert second["key"] == "duplicate-2"
    assert first["id"] != second["id"]


def test_create_caption_style_rejects_invalid_config(client):
    register_user(client)
    bad_config = dict(CLASSIC_LIKE_CONFIG, primary_color="not-a-color")
    res = client.post(
        "/api/v1/caption-styles", json={"label": "Broken", "config": bad_config}
    )
    assert res.status_code == 400
    assert "Invalid caption style" in res.json()["detail"]


def test_create_caption_style_rejects_empty_config(client):
    register_user(client)
    res = client.post("/api/v1/caption-styles", json={"label": "Empty", "config": {}})
    assert res.status_code == 400


def test_create_caption_style_rejects_blank_label(client):
    register_user(client)
    res = client.post(
        "/api/v1/caption-styles", json={"label": "", "config": CLASSIC_LIKE_CONFIG}
    )
    assert res.status_code == 422


def test_created_caption_style_usable_for_render(client):
    """A saved custom style can be passed to the render endpoint just like
    a built-in preset (they're both just rows in caption_styles)."""
    register_user(client)
    project = client.post(
        "/api/v1/projects", json={"title": "Mine", "source": "https://youtu.be/abc"}
    ).json()
    db.update_project(project["id"], source_key="projects/x/source.mp4")
    job = db.create_job(project["id"], {}, job_type="analyze")
    clip_id = db.add_clip(
        project_id=project["id"],
        job_id=job["id"],
        title="The hook",
        viral_hook=None,
        start=0,
        end=10,
        video_url=None,
        thumbnail_url=None,
    )

    style = client.post(
        "/api/v1/caption-styles", json={"label": "Custom Look", "config": CLASSIC_LIKE_CONFIG}
    ).json()

    res = client.post(
        f"/api/v1/projects/{project['id']}/clips/{clip_id}/render",
        json={"orientation": "portrait", "caption_style_id": style["id"]},
    )
    assert res.status_code == 201
    assert res.json()["options"]["caption_style_id"] == style["id"]
