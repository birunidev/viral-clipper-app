"""Tests for the YouTube downloader in core.youtube."""

import os

import pytest

from core.youtube import DownloadError, FALLBACK_CLIENTS, download, is_url


class FakeUtils:
    class DownloadError(Exception):
        pass


ytdlp_utils = FakeUtils()


class FakeYDL:
    calls = []

    def __init__(self, opts):
        self.opts = opts
        self.info = {"id": "abc123"}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def _write(self):
        out_path = os.path.join(self.opts["outtmpl"].split("%(")[0].rstrip("/"), "abc123.mp4")
        open(out_path, "wb").write(b"fake video")

    def _hooks(self, *args, **kwargs):
        pass

    def extract_info(self, url, download=True):
        FakeYDL.calls.append(self.opts)
        for hook in self.opts.get("progress_hooks", []):
            hook({"status": "downloading", "downloaded_bytes": 50, "total_bytes": 100})
        for hook in self.opts.get("progress_hooks", []):
            hook({"status": "finished"})
        self._write()
        return self.info


class FakeYDLRetry(FakeYDL):
    _failures_left = 1

    def extract_info(self, url, download=True):
        FakeYDL.calls.append(self.opts)
        if FakeYDLRetry._failures_left > 0:
            FakeYDLRetry._failures_left -= 1
            raise ytdlp_utils.DownloadError("HTTP Error 403: Forbidden")
        self._write()
        return self.info


class FakeYDLFail(FakeYDL):
    def extract_info(self, url, download=True):
        FakeYDL.calls.append(self.opts)
        raise ytdlp_utils.DownloadError("Video unavailable")


class FakeYtdlp:
    utils = ytdlp_utils

    def __init__(self, ydl_cls):
        self._ydl_cls = ydl_cls

    def YoutubeDL(self, opts):
        return self._ydl_cls(opts)


@pytest.fixture(autouse=True)
def _clear_calls(monkeypatch):
    FakeYDL.calls = []
    FakeYDLRetry._failures_left = 1
    # Safe prod defaults to ENABLE_YTDLP=0, but unit tests exercise the
    # legacy yt-dlp path – enable it for the test process.
    monkeypatch.setenv("ENABLE_YTDLP", "1")
    monkeypatch.setenv("YOUTUBE_API_KEY", "")
    # Disable rate limiter and POT for deterministic tests
    monkeypatch.setenv("YTDLP_RATE_INTERVAL", "0")
    monkeypatch.setenv("POT_PROVIDER_URL", "")
    monkeypatch.setenv("YTDLP_ATTEMPT_TIMEOUT", "5")


@pytest.fixture
def fake_ytdlp(monkeypatch):
    def _set(ydl_cls):
        fake = FakeYtdlp(ydl_cls)
        monkeypatch.setattr("core.youtube.yt_dlp", fake, raising=False)
        monkeypatch.setattr("core.downloader.yt_dlp", fake, raising=False)
    return _set


def test_is_url():
    assert is_url("https://www.youtube.com/watch?v=abc")
    assert is_url("http://example.com/video")
    assert not is_url("/home/user/video.mp4")
    assert not is_url("C:\\videos\\clip.mp4")
    assert not is_url("")


def test_download_success(tmp_path, fake_ytdlp):
    fake_ytdlp(FakeYDL)

    out_dir = tmp_path / "dl"
    path = download("https://youtube.com/watch?v=abc", str(out_dir))

    assert path == str(out_dir / "abc123.mp4")
    assert os.path.isfile(path)
    assert len(FakeYDL.calls) == 1
    assert "extractor_args" not in FakeYDL.calls[0]


def test_download_reports_progress(tmp_path, fake_ytdlp):
    fake_ytdlp(FakeYDL)

    steps = []
    download(
        "https://youtube.com/watch?v=abc",
        str(tmp_path / "dl"),
        progress=steps.append,
    )

    assert steps and steps[-1] in (0.3, 1.0)  # resilient path ends at 1.0, legacy at 0.3
    assert all(0.0 <= step <= 1.0 for step in steps)


def test_download_retries_with_fallback_clients(tmp_path, fake_ytdlp):
    fake_ytdlp(FakeYDLRetry)

    out_dir = tmp_path / "dl"
    path = download("https://youtube.com/watch?v=abc", str(out_dir))

    assert path == str(out_dir / "abc123.mp4")
    assert len(FakeYDL.calls) == 2
    fallback_opts = FakeYDL.calls[1]
    clients = fallback_opts["extractor_args"]["youtube"]["player_client"]
    # Resilient chain tries single client per attempt: second attempt is 'android' (first in FALLBACK_CLIENTS)
    assert clients == FALLBACK_CLIENTS[0]


def test_download_failure(tmp_path, fake_ytdlp):
    fake_ytdlp(FakeYDLFail)

    with pytest.raises(DownloadError, match="Download failed"):
        download("https://youtube.com/watch?v=abc", str(tmp_path / "dl"))


def test_download_missing_output(tmp_path, fake_ytdlp):
    class FakeYDLNoFile(FakeYDL):
        def extract_info(self, url, download=True):
            FakeYDL.calls.append(self.opts)
            return {"id": "missing"}

    fake_ytdlp(FakeYDLNoFile)

    with pytest.raises(DownloadError, match="no output file"):
        download("https://youtube.com/watch?v=abc", str(tmp_path / "dl"))


def test_cookiefile_from_env(tmp_path, fake_ytdlp, monkeypatch):
    monkeypatch.setenv("YTDLP_COOKIEFILE", "/tmp/cookies.txt")
    fake_ytdlp(FakeYDL)

    download("https://youtube.com/watch?v=abc", str(tmp_path / "dl"))

    assert FakeYDL.calls[0]["cookiefile"] == "/tmp/cookies.txt"
