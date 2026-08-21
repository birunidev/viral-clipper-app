"""Tests for the pipeline orchestrators' thumbnail helpers + caption logic."""

from __future__ import annotations

import os

import pytest

from app import db
from app.pipeline import (
    _build_caption_file,
    _build_clip_caption_json,
    _extract_thumbnail,
    _extract_thumbnail_offsets,
    _probe_dimensions,
    _upload_thumbnail,
)


def _fake_success_run(monkeypatch, tmp_path, ok=True):
    """Replace subprocess.run in app.pipeline with a fake that either
    succeeds (writes a non-empty file) or fails."""

    def fake_run(cmd, **kwargs):
        if ok:
            dest = cmd[-1]
            with open(dest, "wb") as fh:
                fh.write(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00")  # tiny JPEG
        return type("R", (), {"returncode": 0 if ok else 1, "stderr": ""})()

    monkeypatch.setattr("app.pipeline.subprocess.run", fake_run)


def test_extract_thumbnail_success(monkeypatch, tmp_path):
    _fake_success_run(monkeypatch, tmp_path, ok=True)
    dest = str(tmp_path / "thumb.jpg")
    assert _extract_thumbnail("video.mp4", 12.5, dest) is True
    assert os.path.getsize(dest) > 0


def test_extract_thumbnail_failure(monkeypatch, tmp_path):
    _fake_success_run(monkeypatch, tmp_path, ok=False)
    dest = str(tmp_path / "thumb.jpg")
    assert _extract_thumbnail("video.mp4", 12.5, dest) is False


def test_extract_thumbnail_offsets_tries_multiple(monkeypatch, tmp_path):
    """If the midpoint fails, the offsets helper falls back to other points."""
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd[cmd.index("-ss") + 1])
        dest = cmd[-1]
        if len(calls) == 1:  # first candidate (the midpoint) fails
            return type("R", (), {"returncode": 1, "stderr": ""})()
        with open(dest, "wb") as fh:
            fh.write(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00")
        return type("R", (), {"returncode": 0, "stderr": ""})()

    monkeypatch.setattr("app.pipeline.subprocess.run", fake_run)
    dest = str(tmp_path / "thumb.jpg")
    assert _extract_thumbnail_offsets("video.mp4", 10.0, 40.0, dest) is True
    assert len(calls) >= 2
    assert os.path.isfile(dest)


def test_extract_thumbnail_offsets_all_fail(monkeypatch, tmp_path):
    _fake_success_run(monkeypatch, tmp_path, ok=False)
    dest = str(tmp_path / "thumb.jpg")
    assert _extract_thumbnail_offsets("video.mp4", 10.0, 40.0, dest) is False


def test_upload_thumbnail_returns_key(monkeypatch, tmp_path):
    from core.s3 import S3Upload

    monkeypatch.setattr(
        "app.pipeline.s3.upload_file_as",
        lambda path, key, content_type=None: S3Upload(
            bucket="b", key=key, url=f"https://example/{key}"
        ),
    )
    path = tmp_path / "thumb.jpg"
    path.write_bytes(b"\xff\xd8\xff\xe0")
    key = _upload_thumbnail("proj-1", str(path))
    assert key is not None
    assert key.startswith("projects/proj-1/thumbs/")
    assert key.endswith(".jpg")


def test_upload_thumbnail_none_on_failure(monkeypatch, tmp_path):
    def boom(*args, **kwargs):
        raise RuntimeError("s3 down")

    monkeypatch.setattr("app.pipeline.s3.upload_file_as", boom)
    path = tmp_path / "thumb.jpg"
    path.write_bytes(b"\xff\xd8\xff\xe0")
    assert _upload_thumbnail("proj-1", str(path)) is None


# ----------------------------------------------------------------- captions


@pytest.fixture
def project_with_timeline():
    """A project with a few absolute-timed timeline words inserted."""
    from helpers import register_user
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        register_user(client)
        project = client.post(
            "/api/v1/projects",
            json={"title": "Mine", "source": "https://youtu.be/abc"},
        ).json()
        words = [
            {"text": "Hello", "start_ms": 1000, "end_ms": 1800},
            {"text": "world", "start_ms": 1850, "end_ms": 2600},
            {"text": "wait", "start_ms": 4000, "end_ms": 4400},
            {"text": "what", "start_ms": 4500, "end_ms": 5200},
        ]
        db.add_timeline_words(project["id"], words)
        yield project
        client.post("/api/v1/auth/logout")


def test_build_caption_json_anchors_to_clip(project_with_timeline):
    # clip from 1.5s to 4.5s overlaps "Hello" (1000-1800, clamped at start),
    # "world" (1850-2600), and "wait" (4000-4400). All re-anchored to
    # clip-relative ms.
    caption = _build_clip_caption_json(project_with_timeline["id"], 1.5, 4.5)

    assert caption == [
        {"text": "Hello", "start_ms": 0, "end_ms": 300},    # 1000-1500 clamped to 0
        {"text": "world", "start_ms": 350, "end_ms": 1100},  # 1850-1500
        {"text": "wait", "start_ms": 2500, "end_ms": 2900},  # 4000-1500
    ]


def test_build_caption_json_clamps_straddling_word(project_with_timeline):
    # clip 2.0s-3.0s: "world" (end 2600) straddles into it, clamped to end
    caption = _build_clip_caption_json(project_with_timeline["id"], 2.0, 3.0)
    assert caption == [{"text": "world", "start_ms": 0, "end_ms": 600}]


def test_build_caption_json_none_when_no_words(project_with_timeline):
    # a gap with no words -> no captions
    caption = _build_clip_caption_json(project_with_timeline["id"], 5.5, 9.0)
    assert caption is None


def test_build_caption_json_none_when_no_timeline(monkeypatch):
    # project with no timeline words at all
    from helpers import register_user
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        register_user(client, email="none@example.com")
        project = client.post(
            "/api/v1/projects",
            json={"title": "Mine", "source": "https://youtu.be/abc"},
        ).json()
        assert _build_clip_caption_json(project["id"], 0, 10) is None
        client.post("/api/v1/auth/logout")


def test_timeline_words_roundtrip(project_with_timeline):
    words = db.get_timeline_words(project_with_timeline["id"])
    texts = [w["text"] for w in words]
    assert texts == ["Hello", "world", "wait", "what"]
    assert words[0]["start_ms"] == 1000
    assert db.get_timeline_words("no-such-project") == []


# --------------------------------------------------------- render captions


def test_probe_dimensions_success(monkeypatch):
    def fake_run(cmd, **kwargs):
        return type("R", (), {"returncode": 0, "stdout": "720x1280\n"})()

    monkeypatch.setattr("app.pipeline.subprocess.run", fake_run)
    assert _probe_dimensions("video.mp4") == (720, 1280)


def test_probe_dimensions_failure(monkeypatch):
    def fake_run(cmd, **kwargs):
        return type("R", (), {"returncode": 1, "stdout": ""})()

    monkeypatch.setattr("app.pipeline.subprocess.run", fake_run)
    assert _probe_dimensions("video.mp4") is None


def test_probe_dimensions_exception(monkeypatch):
    def boom(cmd, **kwargs):
        raise OSError("ffprobe missing")

    monkeypatch.setattr("app.pipeline.subprocess.run", boom)
    assert _probe_dimensions("video.mp4") is None


CLASSIC_STYLE_CONFIG = {
    "font": "Anton",
    "font_size": 72,
    "y": 0.8,
    "bold": True,
    "primary_color": "#FFFFFF",
    "highlight_color": "#FFD60A",
    "outline_color": "#000000",
    "outline": 4,
    "shadow": 0,
    "max_chars_per_line": 32,
    "boxed": False,
    "box_opacity": 0.0,
}


def test_build_caption_file_writes_ass(monkeypatch, tmp_path):
    monkeypatch.setattr("app.pipeline._probe_dimensions", lambda path: (720, 1280))
    clip = {
        "caption_json": [
            {"text": "Hello", "start_ms": 0, "end_ms": 400},
            {"text": "world", "start_ms": 450, "end_ms": 900},
        ]
    }
    out_dir = str(tmp_path)
    ass_path = _build_caption_file(clip, CLASSIC_STYLE_CONFIG, "video.mp4", "portrait", out_dir)
    assert ass_path is not None
    assert os.path.isfile(ass_path)
    content = open(ass_path).read()
    assert "[Script Info]" in content
    assert "Dialogue:" in content


def test_build_caption_file_none_without_words(monkeypatch, tmp_path):
    monkeypatch.setattr("app.pipeline._probe_dimensions", lambda path: (720, 1280))
    clip = {"caption_json": None}
    assert _build_caption_file(clip, CLASSIC_STYLE_CONFIG, "video.mp4", "portrait", str(tmp_path)) is None


def test_build_caption_file_none_when_probe_fails(monkeypatch, tmp_path):
    monkeypatch.setattr("app.pipeline._probe_dimensions", lambda path: None)
    clip = {"caption_json": [{"text": "Hi", "start_ms": 0, "end_ms": 300}]}
    assert _build_caption_file(clip, CLASSIC_STYLE_CONFIG, "video.mp4", "portrait", str(tmp_path)) is None


# ------------------------------------------------------------ BYOK settings


def _seed_user_with_settings(monkeypatch, **settings):
    from core import secrets

    monkeypatch.setenv("APP_SECRET_KEY", "test-secret-key")
    secrets.reset_fernet()

    user = db.create_user("byok@example.com", "hash")
    db.upsert_user_settings(
        user["id"],
        {
            "llm_api_key": secrets.encrypt_secret(settings.get("llm_api_key", "")),
            "assemblyai_key": secrets.encrypt_secret(settings.get("assemblyai_key", "")),
            "llm_base_url": settings.get("llm_base_url") or None,
            "llm_model": settings.get("llm_model") or None,
            "transcription_provider": settings.get("transcription_provider", "assemblyai"),
        },
    )
    return user["id"]


def test_user_settings_precedence_user_over_env(monkeypatch):
    from app.pipeline import _user_settings_for

    monkeypatch.setenv("LLM_API_KEY", "env-key")
    monkeypatch.setenv("ASSEMBLYAI_KEY", "env-aai")
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "assemblyai")

    uid = _seed_user_with_settings(
        monkeypatch,
        llm_api_key="user-llm",
        assemblyai_key="user-aai",
        llm_base_url="https://user.openai/v1",
        llm_model="gpt-4o",
    )

    resolved = _user_settings_for(uid)
    assert resolved["llm_api_key"] == "user-llm"
    assert resolved["assemblyai_key"] == "user-aai"
    assert resolved["llm_base_url"] == "https://user.openai/v1"
    assert resolved["llm_model"] == "gpt-4o"


def test_user_settings_precedence_falls_back_to_env(monkeypatch):
    from app.pipeline import _user_settings_for

    monkeypatch.setenv("LLM_API_KEY", "env-key")
    monkeypatch.setenv("ASSEMBLYAI_KEY", "env-aai")
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "assemblyai")
    monkeypatch.setenv("LLM_MODEL", "env-model")

    uid = _seed_user_with_settings(monkeypatch, transcription_provider="local")

    resolved = _user_settings_for(uid)
    # User set only the provider; keys/base_url/model fall back to env.
    assert resolved["transcription_provider"] == "local"
    assert resolved["llm_api_key"] == "env-key"
    assert resolved["assemblyai_key"] == "env-aai"
    assert resolved["llm_model"] == "env-model"


def test_user_settings_no_row_uses_env(monkeypatch):
    from app.pipeline import _user_settings_for

    monkeypatch.setenv("LLM_API_KEY", "env-key")
    monkeypatch.setenv("ASSEMBLYAI_KEY", "env-aai")
    uid = db.create_user("nosettings@example.com", "hash")["id"]

    resolved = _user_settings_for(uid)
    assert resolved["llm_api_key"] == "env-key"
    assert resolved["assemblyai_key"] == "env-aai"


def test_user_settings_local_provider_overrides_env(monkeypatch):
    from app.pipeline import _user_settings_for

    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "assemblyai")
    uid = _seed_user_with_settings(monkeypatch, transcription_provider="local")

    assert _user_settings_for(uid)["transcription_provider"] == "local"
