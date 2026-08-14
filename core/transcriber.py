"""AssemblyAI transcription wrapper using the REST API directly.

Extracts a compressed audio track from the local video with FFmpeg, then
uploads that audio, submits a transcript job, and polls until it
completes. Talks to the plain HTTP API through ``requests`` so the
``assemblyai`` SDK is not required.

The audio is uploaded to Amazon S3 when ``S3_BUCKET`` is set in the
environment (credentials come from the standard AWS env vars); otherwise
it falls back to AssemblyAI's own upload endpoint.

The transcription progress is reported via an optional callback that
receives floats in [0, 1]. Because AssemblyAI exposes statuses rather than
a granular percentage, the polling progress is estimated from elapsed
time up to a cap.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from typing import Callable, Iterator

import requests

from core.cutter import CutterError, verify_ffmpeg
from core.s3 import S3Error, S3Upload, delete_object, upload_audio

BASE_URL = "https://api.assemblyai.com"
POLL_INTERVAL = 3.0
MAX_WAIT = 600  # seconds before giving up on a transcript
UPLOAD_CHUNK = 1 << 20  # 1 MiB


class TranscriptionError(Exception):
    """Raised when transcription fails for any reason."""


def transcribe(
    file_path: str,
    api_key: str,
    progress: Callable[[float], None] | None = None,
) -> str:
    """Extract audio from ``file_path`` and return the transcript text.

    ``progress`` (optional) receives a float in [0, 1] estimating how far
    along the transcription is. Raises TranscriptionError on missing file,
    invalid key, network failures, or API errors. This is synchronous
    (blocking), so call it from a worker thread, never the UI thread.
    """
    if not api_key:
        raise TranscriptionError("AssemblyAI API key is required.")

    session = requests.Session()
    session.headers.update({"authorization": api_key})

    audio_path = _extract_audio(file_path, progress)
    uploaded: S3Upload | None = None
    try:
        audio_url, uploaded = _get_audio_url(session, audio_path, progress)
        transcript_id = _submit(session, audio_url, progress)
        return _poll(session, transcript_id, progress)
    finally:
        _quiet_remove(audio_path)
        if uploaded is not None:
            delete_object(uploaded.bucket, uploaded.key)


# ------------------------------------------------------------------ audio


def build_extract_command(video_path: str, out_path: str) -> list[str]:
    """Build the FFmpeg command that pulls a mono MP3 out of a video."""
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        out_path,
    ]


def _extract_audio(video_path: str, progress) -> str:
    if not os.path.isfile(video_path):
        raise TranscriptionError(f"File not found: {video_path}")

    fd, out_path = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    try:
        os.remove(out_path)
    except OSError:
        pass

    try:
        _report(progress, 0.02)
        try:
            ffmpeg = verify_ffmpeg()
        except CutterError as exc:
            raise TranscriptionError(str(exc)) from exc

        try:
            result = subprocess.run(
                build_extract_command(video_path, out_path),
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            raise TranscriptionError(f"Could not run ffmpeg: {exc}") from exc

        if result.returncode != 0 or not os.path.isfile(out_path):
            detail = (result.stderr or "").strip() or "unknown ffmpeg error"
            raise TranscriptionError(
                f"Could not extract audio from video: {detail}"
            )
    except Exception:
        _quiet_remove(out_path)
        raise

    _report(progress, 0.05)
    return out_path


def _quiet_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


# ------------------------------------------------------------ HTTP upload


def _report(progress: Callable[[float], None] | None, value: float) -> None:
    if progress is not None:
        progress(value)


def _get_audio_url(
    session: requests.Session, audio_path: str, progress
) -> tuple[str, S3Upload | None]:
    """Return (fetchable URL, upload handle) for the extracted audio.

    Uses S3 when ``S3_BUCKET`` is configured, otherwise falls back to
    AssemblyAI's own upload endpoint (upload handle stays None).
    """
    if os.environ.get("S3_BUCKET", "").strip():
        try:
            uploaded = upload_audio(audio_path, progress)
        except S3Error as exc:
            raise TranscriptionError(str(exc)) from exc
        _report(progress, 0.15)
        return uploaded.url, uploaded
    url = _upload(session, audio_path, progress)
    return url, None


def _upload_iter(
    file_path: str, total: int, progress
) -> Iterator[bytes]:
    sent = 0
    with open(file_path, "rb") as fh:
        while True:
            chunk = fh.read(UPLOAD_CHUNK)
            if not chunk:
                break
            sent += len(chunk)
            _report(progress, 0.05 + 0.10 * (sent / max(total, 1)))
            yield chunk


def _upload(session: requests.Session, file_path: str, progress) -> str:
    if not os.path.isfile(file_path):
        raise TranscriptionError(f"File not found: {file_path}")

    _report(progress, 0.05)
    try:
        total = os.path.getsize(file_path)
        response = session.post(
            BASE_URL + "/v2/upload",
            data=_upload_iter(file_path, total, progress),
            timeout=600,
        )
    except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
        raise TranscriptionError(f"Network error while uploading to AssemblyAI: {exc}") from exc
    except OSError as exc:
        raise TranscriptionError(f"Could not read file: {exc}") from exc

    _raise_for_status(response, "upload")
    try:
        upload_url = response.json()["upload_url"]
    except (ValueError, KeyError) as exc:
        raise TranscriptionError(
            f"Unexpected upload response: {response.text[:200]}"
        ) from exc

    _report(progress, 0.15)
    return upload_url


def _submit(session: requests.Session, audio_url: str, progress) -> str:
    _report(progress, 0.2)
    data = {"audio_url": audio_url, "language_detection": True}
    try:
        response = session.post(BASE_URL + "/v2/transcript", json=data, timeout=60)
    except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
        raise TranscriptionError(
            f"Network error while submitting transcription: {exc}"
        ) from exc

    _raise_for_status(response, "submit")
    try:
        return response.json()["id"]
    except (ValueError, KeyError) as exc:
        raise TranscriptionError(
            f"Unexpected transcript response: {response.text[:200]}"
        ) from exc


def _poll(session: requests.Session, transcript_id: str, progress) -> str:
    endpoint = f"{BASE_URL}/v2/transcript/{transcript_id}"
    deadline = time.monotonic() + MAX_WAIT

    while True:
        try:
            response = session.get(endpoint, timeout=60)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
            raise TranscriptionError(f"Network error while polling AssemblyAI: {exc}") from exc

        _raise_for_status(response, "poll")
        try:
            result = response.json()
        except ValueError as exc:
            raise TranscriptionError("Unexpected polling response from AssemblyAI.") from exc

        status = result.get("status")
        if status == "completed":
            _report(progress, 1.0)
            return result.get("text") or ""
        if status == "error":
            raise TranscriptionError(
                f"AssemblyAI transcription failed: {result.get('error')}"
            )

        if time.monotonic() >= deadline:
            raise TranscriptionError(
                f"Transcription timed out after {MAX_WAIT // 60} minutes."
            )

        elapsed = deadline - time.monotonic()
        _report(progress, min(0.95, 0.2 + 0.75 * (MAX_WAIT - elapsed) / MAX_WAIT))
        time.sleep(POLL_INTERVAL)


def _raise_for_status(response: requests.Response, stage: str) -> None:
    if response.status_code >= 400:
        raise TranscriptionError(
            f"AssemblyAI {stage} failed (HTTP {response.status_code}): "
            f"{response.text[:200]}"
        )
