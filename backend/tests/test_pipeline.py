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


def test_build_caption_json_recovers_gap_window(project_with_timeline):
    # A window past the last word (drifted LLM timestamp) now snaps back
    # into the timeline span and returns the nearest words, instead of
    # silently producing a caption-less render.
    caption = _build_clip_caption_json(project_with_timeline["id"], 5.5, 9.0)
    assert caption is not None
    assert len(caption) > 0


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

    monkeypatch.setenv("ENABLE_BYOK", "1")
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

    monkeypatch.setenv("ENABLE_BYOK", "1")
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

    monkeypatch.setenv("ENABLE_BYOK", "1")
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "assemblyai")
    uid = _seed_user_with_settings(monkeypatch, transcription_provider="local")

    assert _user_settings_for(uid)["transcription_provider"] == "local"


# ------------------------------------------------- storage accounting (BYOK)

MB = 1024 * 1024


def test_analyze_youtube_source_accounting_is_net_on_rerun(client, monkeypatch, tmp_path):
    """Re-running analysis on a YouTube project replaces the source object:
    the user's quota must reflect the NEW size, not old + new."""
    from app import pipeline as pl
    from core import storage
    from helpers import register_user

    monkeypatch.setenv("LLM_API_KEY", "sk-test")
    monkeypatch.setenv("ASSEMBLYAI_KEY", "sk-aai")
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "assemblyai")

    register_user(client, email="rerun@example.com")
    user = db.get_user_by_email("rerun@example.com")
    project = db.create_project(user["id"], "P", "https://youtu.be/x", "youtube")

    sizes = iter([10 * MB, 12 * MB])

    def fake_download(source, dest_dir, progress=None):
        os.makedirs(dest_dir, exist_ok=True)
        path = os.path.join(dest_dir, "video.mp4")
        with open(path, "wb") as fh:
            fh.write(b"0" * next(sizes))
        return path

    class FakeTranscript:
        text = "hello"
        words: list[dict] = []
        language = "en"

    monkeypatch.setattr("app.pipeline.youtube.get_info", lambda s: {})
    monkeypatch.setattr("app.pipeline.youtube.download", fake_download)
    monkeypatch.setattr(
        "app.pipeline.s3.upload_file_as",
        lambda local, key, ct: type(
            "U", (), {"key": key, "size_bytes": os.path.getsize(local)}
        )(),
    )
    monkeypatch.setattr(
        "app.pipeline.transcriber.transcribe_with_words",
        lambda *a, **k: FakeTranscript(),
    )
    monkeypatch.setattr(
        "app.pipeline.analyzer.analyze",
        lambda *a, **k: [{"title": "C", "start": 0.0, "end": 1.0}],
    )

    job = db.create_job(project["id"], {"max_clips": 5}, job_type="analyze")
    pl._run_analyze(job["id"])
    assert storage.storage_used(user["id"]) == 10 * MB
    p = db.get_project(project["id"])
    assert p["source_size_bytes"] == 10 * MB
    assert p["storage_bytes"] == 10 * MB

    # Second run with a bigger download: net total must be 12MB, not 22MB.
    job2 = db.create_job(project["id"], {"max_clips": 5}, job_type="analyze")
    pl._run_analyze(job2["id"])
    assert storage.storage_used(user["id"]) == 12 * MB
    p = db.get_project(project["id"])
    assert p["source_size_bytes"] == 12 * MB
    assert p["storage_bytes"] == 12 * MB


def test_analyze_reuses_stored_source_when_present(client, monkeypatch, tmp_path):
    """A failed analysis must not re-download the source on retry: when the
    canonical source already exists in S3, it's pulled from there and the
    YouTube download / re-upload / re-accounting are all skipped."""
    from app import pipeline as pl
    from core import storage
    from helpers import register_user

    monkeypatch.setenv("LLM_API_KEY", "sk-test")
    monkeypatch.setenv("ASSEMBLYAI_KEY", "sk-aai")
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "assemblyai")

    register_user(client, email="reuse@example.com")
    user = db.get_user_by_email("reuse@example.com")
    project = db.create_project(user["id"], "P", "https://youtu.be/x", "youtube")

    # Simulate a previous run that got through the download stage before
    # failing: source stored, size known, quota accounted.
    source_key = "projects/p/source.mp4"
    db.update_project(
        project["id"], source_key=source_key, source_size_bytes=10 * MB
    )
    storage.add_project_storage(project["id"], user["id"], 10 * MB)

    def boom(*a, **k):
        raise AssertionError("YouTube must not be touched on retry")

    monkeypatch.setattr("app.pipeline.youtube.get_info", boom)
    monkeypatch.setattr("app.pipeline.youtube.download", boom)
    monkeypatch.setattr(
        "app.pipeline.s3.upload_file_as", boom
    )  # no re-upload for a reused source
    monkeypatch.setattr(
        "app.pipeline.s3.head_object_size_default_bucket",
        lambda key: 10 * MB if key == source_key else None,
    )

    def fake_download_object(key, dest, progress=None):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(b"0" * (10 * MB))
        return dest

    class FakeTranscript:
        text = "hello"
        words: list[dict] = []
        language = "en"

    monkeypatch.setattr("app.pipeline.s3.download_object", fake_download_object)
    monkeypatch.setattr(
        "app.pipeline.transcriber.transcribe_with_words",
        lambda *a, **k: FakeTranscript(),
    )
    monkeypatch.setattr(
        "app.pipeline.analyzer.analyze",
        lambda *a, **k: [{"title": "C", "start": 0.0, "end": 1.0}],
    )

    job = db.create_job(project["id"], {"max_clips": 5}, job_type="analyze")
    pl._run_analyze(job["id"])

    assert db.get_job(job["id"])["status"] == "completed"
    # Storage accounting untouched by the retry (still exactly one copy).
    assert storage.storage_used(user["id"]) == 10 * MB
    p = db.get_project(project["id"])
    assert p["source_size_bytes"] == 10 * MB
    assert p["storage_bytes"] == 10 * MB
    # The stored S3 key must survive the retry (not be clobbered back to
    # the YouTube URL).
    assert p["source_key"] == source_key


def test_render_fails_when_clip_would_exceed_cap(client, monkeypatch, tmp_path):
    """The rendered mp4 is size-checked against the cap BEFORE upload: an
    over-quota render fails fast instead of silently exceeding it."""
    from app import pipeline as pl
    from core import billing, storage
    from helpers import register_user

    register_user(client, email="rendercap@example.com")
    user = db.get_user_by_email("rendercap@example.com")
    project = db.create_project(user["id"], "P", "https://youtu.be/x", "youtube")
    db.update_project(project["id"], source_key="projects/p/source.mp4")
    clip_id = db.add_clip(
        project["id"],
        None,
        "C",
        None,
        0.0,
        1.0,
        None,
        "projects/p/thumbs/x.jpg",
    )

    # Fill the user's quota almost to the cap; a 5MB render won't fit.
    storage.add_storage(user["id"], billing.storage_cap(user["id"]) - MB)

    def fake_download(key, dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(b"0")
        return dest

    def fake_cut(*a, **k):
        out = os.path.join(a[4], "clip_01.mp4") if len(a) > 4 else k["out"]
        os.makedirs(out, exist_ok=True)
        path = os.path.join(out, "c.mp4")
        with open(path, "wb") as fh:
            fh.write(b"0" * (5 * MB))
        return path

    monkeypatch.setattr("app.pipeline.s3.download_object", fake_download)
    monkeypatch.setattr("app.pipeline.cutter.cut_clip", fake_cut)
    uploaded = []
    monkeypatch.setattr(
        "app.pipeline.s3.upload_file",
        lambda *a, **k: uploaded.append(a) or (_ for _ in ()).throw(AssertionError("must not upload")),
    )

    job = db.create_job(
        project["id"], {"orientation": "portrait"}, job_type="render", clip_id=clip_id
    )
    pl.run_job(job["id"])

    job_row = db.get_job(job["id"])
    assert job_row["status"] == "failed"
    assert "Storage limit reached" in (job_row["error"] or "")
    assert not uploaded
    assert storage.storage_used(user["id"]) == billing.storage_cap(user["id"]) - MB


def test_upload_thumbnail_skipped_when_no_room(client, tmp_path):
    """At the cap, thumbnails are skipped gracefully (no S3 write, no error)
    so renders still succeed without them."""
    from core import storage
    from core import billing
    from helpers import register_user

    register_user(client, email="thumb@example.com")
    user = db.get_user_by_email("thumb@example.com")
    project = db.create_project(user["id"], "P", "https://youtu.be/x", "youtube")

    thumb = tmp_path / "t.jpg"
    thumb.write_bytes(b"\xff" * 2048)

    storage.add_storage(user["id"], billing.storage_cap(user["id"]))
    assert _upload_thumbnail(project["id"], str(thumb)) is None


def test_build_clip_caption_json_snaps_drifted_llm_window(project_with_timeline):
    """LLM clip timestamps drift. When the requested window catches zero
    timeline words, the builder must clamp into the timeline span and still
    return words instead of silently producing a caption-less render."""
    # Timeline words live at 1000-5200ms; this window is entirely past them.
    words = _build_clip_caption_json(project_with_timeline["id"], 8.0, 10.0)
    assert words is not None
    assert len(words) > 0
    assert all("text" in w and "start_ms" in w and "end_ms" in w for w in words)


def test_build_clip_caption_json_none_without_any_words(project_with_timeline, monkeypatch):
    """With no timeline words at all there is nothing to recover — returns
    None (clip renders without captions)."""
    from app import db as app_db
    app_db.delete_timeline_words(project_with_timeline["id"])
    assert (
        _build_clip_caption_json(project_with_timeline["id"], 1.0, 2.0) is None
    )


def test_build_clip_caption_json_preserves_duration_when_snapping(project_with_timeline):
    """A window drifted entirely past the transcript must snap back with its
    duration intact — recovering the surrounding words, not a sliver."""
    words = _build_clip_caption_json(project_with_timeline["id"], 8.0, 12.0)
    assert words is not None
    # Timeline holds 4 words across 1000-5200ms; a 4s window snapped onto
    # the span must recover more than one of them.
    assert len(words) >= 2
