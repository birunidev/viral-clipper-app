"""Tests for the S3 audio upload in core.s3."""

import os

import pytest

from core.s3 import S3Error, delete_object, upload_audio


class FakeS3Client:
    def __init__(self, fail_upload=False):
        self.fail_upload = fail_upload
        self.uploaded = []
        self.deleted = []
        self.url = "https://presigned.example/audio.mp3"

    def upload_file(self, filename, bucket, key, ExtraArgs=None, Callback=None):
        if self.fail_upload:
            raise RuntimeError("access denied")
        self.uploaded.append((filename, bucket, key, ExtraArgs))
        if Callback is not None:
            Callback(os.path.getsize(filename))

    def generate_presigned_url(self, method, Params, ExpiresIn=None):
        assert method == "get_object"
        return self.url

    def delete_object(self, Bucket=None, Key=None):
        self.deleted.append((Bucket, Key))


@pytest.fixture
def fake_client(monkeypatch):
    def _make(fail_upload=False):
        client = FakeS3Client(fail_upload=fail_upload)
        monkeypatch.setattr("core.s3.boto3.client", lambda *args, **kwargs: client)
        return client

    return _make


def test_upload_audio_requires_bucket(monkeypatch, tmp_path):
    monkeypatch.delenv("S3_BUCKET", raising=False)
    with pytest.raises(S3Error, match="S3_BUCKET"):
        upload_audio(str(tmp_path / "a.mp3"))


def test_upload_audio_success(monkeypatch, tmp_path, fake_client):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    client = fake_client()

    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"x" * 1024)

    upload = upload_audio(str(audio))

    assert upload.url == client.url
    assert upload.bucket == "my-bucket"
    assert upload.key.startswith("clipzard/")
    assert upload.key.endswith(".mp3")
    assert len(client.uploaded) == 1
    _, bucket, key, extra = client.uploaded[0]
    assert bucket == "my-bucket"
    assert key == upload.key
    assert extra == {"ContentType": "audio/mpeg"}


def test_upload_audio_reports_progress(monkeypatch, tmp_path, fake_client):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    fake_client()

    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"x" * 2048)

    steps = []
    upload_audio(str(audio), progress=steps.append)

    assert steps
    assert all(0.06 <= step <= 0.15 for step in steps)


def test_upload_audio_s3_failure(monkeypatch, tmp_path, fake_client):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    fake_client(fail_upload=True)

    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"x" * 64)

    with pytest.raises(S3Error, match="S3 upload failed"):
        upload_audio(str(audio))


def test_delete_object_uses_bucket_and_key(monkeypatch, tmp_path, fake_client):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    client = fake_client()

    delete_object("my-bucket", "clipzard/abc.mp3")

    assert client.deleted == [("my-bucket", "clipzard/abc.mp3")]


def test_delete_object_ignores_errors(monkeypatch, tmp_path):
    class BoomClient:
        def delete_object(self, **kwargs):
            raise RuntimeError("nope")

    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    monkeypatch.setattr(
        "core.s3.boto3.client", lambda *args, **kwargs: BoomClient()
    )

    delete_object("my-bucket", "clipzard/abc.mp3")  # must not raise
