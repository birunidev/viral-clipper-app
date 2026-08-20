"""Tests for the pipeline orchestrators' thumbnail helpers."""

from __future__ import annotations

import os

import pytest

from app.pipeline import (
    _extract_thumbnail,
    _extract_thumbnail_offsets,
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
