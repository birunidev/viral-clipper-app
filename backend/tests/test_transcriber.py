"""Tests for the transcription wrappers in core.transcriber.

Covers the cloud AssemblyAI REST path and the local whisper.cpp path.
"""

import json

import pytest
import requests

from core.transcriber import (
    TranscriptionError,
    build_extract_command,
    transcribe,
    BASE_URL,
)


class FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = payload if isinstance(payload, str) else json.dumps(payload)

    def json(self):
        if isinstance(self._payload, str):
            return json.loads(self._payload)
        return self._payload


class FakeSession:
    """Replays a scripted list of (method, url, status, payload) responses."""

    def __init__(self, script):
        self.script = list(script)
        self.headers = {}
        self.calls = []

    def _next(self, method, url, kwargs):
        expected = self.script.pop(0)
        if isinstance(expected, tuple):
            exp_method, exp_url, status, payload = expected
            assert exp_method == method, f"expected {exp_method}, got {method}"
            assert exp_url == url, f"expected {exp_url}, got {url}"
        else:
            status, payload = expected
        self.calls.append((method, url, kwargs))
        return FakeResponse(status, payload)

    def post(self, url, **kwargs):
        return self._next("post", url, kwargs)

    def get(self, url, **kwargs):
        return self._next("get", url, kwargs)


@pytest.fixture
def session(monkeypatch):
    fake = FakeSession([])
    monkeypatch.setattr("core.transcriber.requests.Session", lambda: fake)
    return fake


@pytest.fixture(autouse=True)
def _clear_s3_env(monkeypatch):
    """S3 may be configured via .env (loaded by test_api); isolate these tests."""
    monkeypatch.delenv("S3_BUCKET", raising=False)


@pytest.fixture
def fake_audio(monkeypatch, tmp_path):
    """Skip real FFmpeg extraction; point transcribe() at a fake audio file."""
    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"\xff\xfb\x90\x64")
    monkeypatch.setattr(
        "core.transcriber._extract_audio",
        lambda video_path, progress=None: str(audio),
    )
    return str(audio)


def make_file(tmp_path):
    path = tmp_path / "video.mp4"
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42")
    return str(path)


def test_transcribe_success(session, fake_audio):
    session.script = [
        ("post", BASE_URL + "/v2/upload", 200, {"upload_url": "https://cdn.assemblyai.com/u/xyz"}),
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "processing"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "completed", "text": "Hello world"}),
    ]

    text = transcribe("video.mp4", "test-key")

    assert text == "Hello world"
    assert session.headers["authorization"] == "test-key"
    upload_call = session.calls[0]
    assert upload_call[1] == BASE_URL + "/v2/upload"
    submit_kwargs = session.calls[1][2]
    assert submit_kwargs["json"] == {
        "audio_url": "https://cdn.assemblyai.com/u/xyz",
        "language_detection": True,
    }


def test_transcribe_without_s3_env_uses_assemblyai_upload(session, fake_audio, monkeypatch):
    monkeypatch.delenv("S3_BUCKET", raising=False)
    session.script = [
        ("post", BASE_URL + "/v2/upload", 200, {"upload_url": "https://cdn.example/u"}),
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "completed", "text": "Hello"}),
    ]

    transcribe("video.mp4", "test-key")

    methods = [call[0] for call in session.calls]
    assert methods == ["post", "post", "get"]
    assert session.calls[0][1] == BASE_URL + "/v2/upload"


def test_transcribe_uses_s3_when_configured(session, fake_audio, monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    from core.s3 import S3Upload

    monkeypatch.setattr(
        "core.transcriber.upload_audio",
        lambda file_path, progress=None: S3Upload(
            bucket="my-bucket",
            key="clipforge/abc.mp3",
            url="https://presigned.example/audio.mp3",
        ),
    )
    monkeypatch.setattr("core.transcriber.delete_object", lambda bucket, key: None)
    session.script = [
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "completed", "text": "Hello"}),
    ]

    text = transcribe("video.mp4", "test-key")

    assert text == "Hello"
    methods = [call[0] for call in session.calls]
    assert methods == ["post", "get"]
    submit_kwargs = session.calls[0][2]
    assert submit_kwargs["json"]["audio_url"] == "https://presigned.example/audio.mp3"


def test_transcribe_deletes_uploaded_audio(session, fake_audio, monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    from core.s3 import S3Upload

    monkeypatch.setattr(
        "core.transcriber.upload_audio",
        lambda file_path, progress=None: S3Upload(
            bucket="my-bucket",
            key="clipforge/abc.mp3",
            url="https://presigned.example/audio.mp3",
        ),
    )
    deleted = []
    monkeypatch.setattr(
        "core.transcriber.delete_object", lambda bucket, key: deleted.append((bucket, key))
    )
    session.script = [
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "completed", "text": "Hello"}),
    ]

    transcribe("video.mp4", "test-key")

    assert deleted == [("my-bucket", "clipforge/abc.mp3")]


def test_transcribe_deletes_audio_on_error(session, fake_audio, monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")
    from core.s3 import S3Upload

    monkeypatch.setattr(
        "core.transcriber.upload_audio",
        lambda file_path, progress=None: S3Upload(
            bucket="my-bucket",
            key="clipforge/abc.mp3",
            url="https://presigned.example/audio.mp3",
        ),
    )
    deleted = []
    monkeypatch.setattr(
        "core.transcriber.delete_object", lambda bucket, key: deleted.append((bucket, key))
    )
    session.script = [
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "error", "error": "boom"}),
    ]

    with pytest.raises(TranscriptionError, match="boom"):
        transcribe("video.mp4", "test-key")

    assert deleted == [("my-bucket", "clipforge/abc.mp3")]


def test_transcribe_s3_failure_is_transcription_error(session, fake_audio, monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "my-bucket")

    def boom(*args, **kwargs):
        from core.s3 import S3Error
        raise S3Error("S3 upload failed: access denied")

    monkeypatch.setattr("core.transcriber.upload_audio", boom)

    with pytest.raises(TranscriptionError, match="access denied"):
        transcribe("video.mp4", "test-key")


def test_transcribe_error_status(session, fake_audio):
    session.script = [
        ("post", BASE_URL + "/v2/upload", 200, {"upload_url": "https://cdn.example/u"}),
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "error", "error": "boom"}),
    ]

    with pytest.raises(TranscriptionError, match="boom"):
        transcribe("video.mp4", "test-key")


def test_transcribe_http_error(session, fake_audio):
    session.script = [
        ("post", BASE_URL + "/v2/upload", 401, {"error": "Invalid API key"}),
    ]

    with pytest.raises(TranscriptionError, match="401"):
        transcribe("video.mp4", "bad-key")


def test_transcribe_missing_key(session, tmp_path):
    session.script = []
    with pytest.raises(TranscriptionError, match="API key is required"):
        transcribe(make_file(tmp_path), "")


def test_transcribe_missing_file(session, tmp_path):
    session.script = []
    with pytest.raises(TranscriptionError, match="File not found"):
        transcribe(str(tmp_path / "nope.mp4"), "test-key")


def test_transcribe_network_error(session, fake_audio):
    def boom(*args, **kwargs):
        raise requests.exceptions.ConnectionError("no route")
    session.post = boom

    with pytest.raises(TranscriptionError, match="Network error"):
        transcribe("video.mp4", "test-key")


def test_progress_callback(session, fake_audio):
    session.script = [
        ("post", BASE_URL + "/v2/upload", 200, {"upload_url": "https://cdn.example/u"}),
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "processing"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "completed", "text": "done"}),
    ]

    steps = []
    transcribe("video.mp4", "test-key", progress=steps.append)

    assert steps and steps[0] >= 0.0
    assert steps[-1] == 1.0
    assert all(0.0 <= step <= 1.0 for step in steps)


def test_build_extract_command():
    cmd = build_extract_command("/vids/src.mp4", "/tmp/audio.mp3")
    assert cmd[0] == "ffmpeg"
    assert cmd[cmd.index("-i") + 1] == "/vids/src.mp4"
    assert cmd[cmd.index("-c:a") + 1] == "libmp3lame"
    assert cmd[-1] == "/tmp/audio.mp3"


def test_extract_audio_failure_raises(monkeypatch, tmp_path):
    class FakeResult:
        returncode = 1
        stderr = "no audio stream"

    def fake_run(*args, **kwargs):
        return FakeResult()

    monkeypatch.setattr("core.transcriber.subprocess.run", fake_run)
    video = make_file(tmp_path)

    with pytest.raises(TranscriptionError, match="Could not extract audio"):
        from core.transcriber import _extract_audio
        _extract_audio(video, None)


def test_build_extract_command_wav_uses_pcm():
    cmd = build_extract_command("/vids/src.mp4", "/tmp/audio.wav", fmt="wav")
    assert cmd[cmd.index("-c:a") + 1] == "pcm_s16le"
    assert cmd[cmd.index("-ar") + 1] == "16000"
    assert cmd[-1] == "/tmp/audio.wav"


# --------------------------------------------------------------- provider dispatch


def test_transcribe_defaults_to_assemblyai(session, fake_audio):
    session.script = [
        ("post", BASE_URL + "/v2/upload", 200, {"upload_url": "https://cdn.example/u"}),
        ("post", BASE_URL + "/v2/transcript", 200, {"id": "abc123"}),
        ("get", BASE_URL + "/v2/transcript/abc123", 200, {"status": "completed", "text": "Hello"}),
    ]
    text = transcribe("video.mp4", "test-key")
    assert text == "Hello"


def test_transcribe_unknown_provider_raises(session, fake_audio):
    with pytest.raises(TranscriptionError, match="Unknown TRANSCRIPTION_PROVIDER"):
        transcribe("video.mp4", "test-key", provider="bogus")


def _install_fake_whisper(monkeypatch, model_class):
    """Inject a fake ``pywhispercpp`` package into sys.modules so the local
    path can be tested without the native binding installed."""
    import sys

    package = type("pywhispercpp", (), {})
    model_module = type("model", (), {"Model": model_class})
    monkeypatch.setitem(sys.modules, "pywhispercpp", package)
    monkeypatch.setitem(sys.modules, "pywhispercpp.model", model_module)


def test_transcribe_local_missing_file(tmp_path):
    with pytest.raises(TranscriptionError, match="File not found"):
        transcribe(str(tmp_path / "nope.mp4"), "", provider="local")


def test_transcribe_local_success(monkeypatch, tmp_path):
    """The local (whisper.cpp) path never touches the network."""
    video = make_file(tmp_path)

    monkeypatch.setattr(
        "core.transcriber._extract_audio",
        lambda video_path, progress=None, fmt="mp3": video_path,
    )

    class FakeSegment:
        def __init__(self, text):
            self.text = text

    class FakeModel:
        def __init__(self, model_name, n_threads=4):
            self.model_name = model_name
            self.n_threads = n_threads

        def transcribe(self, audio_path):
            return [FakeSegment(" Hello"), FakeSegment(" world ")]

    _install_fake_whisper(monkeypatch, FakeModel)

    steps = []
    text = transcribe(video, "", progress=steps.append, provider="local")

    assert text == "Hello world"
    assert steps[-1] == 1.0


def test_transcribe_local_missing_dependency(monkeypatch, tmp_path):
    import builtins
    import sys

    video = make_file(tmp_path)
    monkeypatch.setattr(
        "core.transcriber._extract_audio",
        lambda video_path, progress=None, fmt="mp3": video_path,
    )

    monkeypatch.setitem(sys.modules, "pywhispercpp", None)
    monkeypatch.setitem(sys.modules, "pywhispercpp.model", None)
    monkeypatch.delitem(sys.modules, "pywhispercpp.model", raising=False)
    monkeypatch.delitem(sys.modules, "pywhispercpp", raising=False)

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name.startswith("pywhispercpp"):
            raise ImportError("no module named pywhispercpp")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(TranscriptionError, match="pywhispercpp is not installed"):
        transcribe(video, "", provider="local")


def test_transcribe_local_model_load_failure(monkeypatch, tmp_path):
    video = make_file(tmp_path)
    monkeypatch.setattr(
        "core.transcriber._extract_audio",
        lambda video_path, progress=None, fmt="mp3": video_path,
    )

    class FakeModel:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("model file not found")

    _install_fake_whisper(monkeypatch, FakeModel)

    with pytest.raises(TranscriptionError, match="Could not load whisper.cpp model"):
        transcribe(video, "", provider="local")
