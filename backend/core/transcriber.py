"""Transcription: AssemblyAI (cloud) or whisper.cpp (local), picked per job.

Two interchangeable providers behind one ``transcribe()`` entry point,
selected via the ``provider`` argument or the ``TRANSCRIPTION_PROVIDER``
env var (``assemblyai`` default, or ``local``):

- ``assemblyai`` — extracts a compressed audio track from the local video
  with FFmpeg, uploads that audio, submits a transcript job, and polls
  until it completes. Talks to the plain HTTP API through ``requests`` so
  the ``assemblyai`` SDK is not required. The audio is uploaded to Amazon
  S3 when ``S3_BUCKET`` is set (credentials come from the standard AWS env
  vars); otherwise it falls back to AssemblyAI's own upload endpoint.
- ``local`` — runs whisper.cpp in-process via ``pywhispercpp``. Works on
  CPU everywhere, and picks up Metal (Apple Silicon) or CUDA acceleration
  automatically if the installed wheel/build supports it. No network
  calls, no S3 round-trip. The model is loaded fresh per call and dropped
  immediately after so it does not stay resident in RAM while the next
  pipeline stage (LLM analysis) loads its own model — important on
  RAM-constrained boxes (e.g. 16GB laptops) where whisper and the LLM
  should not be resident at the same time.

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
from dataclasses import dataclass
from typing import Callable, Iterator

import requests

from core.cutter import CutterError, verify_ffmpeg
from core.s3 import S3Error, S3Upload, delete_object, upload_audio

BASE_URL = "https://api.assemblyai.com"
POLL_INTERVAL = 3.0
MAX_WAIT = 600  # seconds before giving up on a transcript
UPLOAD_CHUNK = 1 << 20  # 1 MiB

PROVIDER_ASSEMBLYAI = "assemblyai"
PROVIDER_LOCAL = "local"
PROVIDERS = (PROVIDER_ASSEMBLYAI, PROVIDER_LOCAL)
DEFAULT_PROVIDER = os.environ.get("TRANSCRIPTION_PROVIDER", PROVIDER_ASSEMBLYAI)
DEFAULT_WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
DEFAULT_WHISPER_THREADS = int(os.environ.get("WHISPER_THREADS", "4"))


@dataclass
class TranscriptResult:
    """A transcription plus per-word timestamps (used for captions).

    ``words`` is a list of ``{"text": str, "start_ms": int, "end_ms": int}``
    in transcript order, with absolute timestamps in milliseconds measured
    from the start of the source audio.

    ``language`` (optional) is the detected/language returned by the
    provider as an ISO 639-1 code (e.g. ``"id"``), used to generate
    titles/hooks in the transcript's own language.
    """

    text: str
    words: list[dict]
    language: str | None = None


class TranscriptionError(Exception):
    """Raised when transcription fails for any reason."""


def transcribe(
    file_path: str,
    api_key: str,
    progress: Callable[[float], None] | None = None,
    provider: str | None = None,
    language: str | None = None,
) -> str:
    """Extract audio from ``file_path`` and return the transcript text.

    Convenience wrapper over :func:`transcribe_with_words` that returns only
    the plain text. ``provider`` selects ``assemblyai`` (cloud, default) or
    ``local`` (whisper.cpp, no network). Falls back to the
    ``TRANSCRIPTION_PROVIDER`` env var, then to ``assemblyai``, if not
    passed explicitly. ``language`` (optional) is an ISO 639-1 hint (e.g.
    ``"id"`` from the source YouTube metadata); providers auto-detect when
    omitted.

    ``progress`` (optional) receives a float in [0, 1] estimating how far
    along the transcription is. Raises TranscriptionError on missing file,
    invalid key/model, or provider failures. This is synchronous
    (blocking), so call it from a worker thread, never the UI thread.
    """
    return transcribe_with_words(file_path, api_key, progress, provider, language).text


def transcribe_with_words(
    file_path: str,
    api_key: str,
    progress: Callable[[float], None] | None = None,
    provider: str | None = None,
    language: str | None = None,
) -> TranscriptResult:
    """Like :func:`transcribe` but returns text + per-word timestamps.

    The returned :class:`TranscriptResult` carries absolute word timings
    (``start_ms``/``end_ms``) which the analyze job stores on the project's
    timeline and re-anchors per clip for TikTok-style captions. ``language``
    is an optional ISO 639-1 hint forwarded to the provider.
    """
    provider = (provider or DEFAULT_PROVIDER or PROVIDER_ASSEMBLYAI).strip().lower()
    if provider == PROVIDER_LOCAL:
        return _transcribe_local(file_path, progress, language)
    if provider != PROVIDER_ASSEMBLYAI:
        raise TranscriptionError(
            f"Unknown TRANSCRIPTION_PROVIDER: {provider!r} (expected one of {PROVIDERS})"
        )
    return _transcribe_assemblyai(file_path, api_key, progress, language)


def _transcribe_assemblyai(
    file_path: str,
    api_key: str,
    progress: Callable[[float], None] | None,
    language: str | None = None,
) -> TranscriptResult:
    if not api_key:
        raise TranscriptionError("AssemblyAI API key is required.")

    session = requests.Session()
    session.headers.update({"authorization": api_key})

    audio_path = _extract_audio(file_path, progress)
    uploaded: S3Upload | None = None
    try:
        audio_url, uploaded = _get_audio_url(session, audio_path, progress)
        transcript_id = _submit(session, audio_url, progress, language)
        return _poll(session, transcript_id, progress)
    finally:
        _quiet_remove(audio_path)
        if uploaded is not None:
            delete_object(uploaded.bucket, uploaded.key)


# --------------------------------------------------------------- local (whisper.cpp)


def _transcribe_local(
    file_path: str,
    progress: Callable[[float], None] | None,
    language: str | None = None,
) -> TranscriptResult:
    """Transcribe fully offline with whisper.cpp via ``pywhispercpp``.

    Loads the model fresh for this call and lets it go out of scope
    immediately after, so it does not stay resident in memory once the
    pipeline moves on to LLM analysis. That matters on RAM-constrained
    machines (e.g. 16GB laptops) where whisper and the LLM should never
    both be loaded at once.

    Word timing: ``token_timestamps=True, max_len=1, split_on_word=True``
    forces whisper.cpp to emit one word per segment with an absolute start
    (``t0``) and end (``t1``), which we convert from whisper.cpp's own time
    units (centiseconds) to milliseconds. ``language`` (ISO 639-1, e.g.
    "id") is forwarded to whisper.cpp so it skips language auto-detection
    and transcribes directly in that language — auto-detect is used when
    omitted.
    """
    if not os.path.isfile(file_path):
        raise TranscriptionError(f"File not found: {file_path}")

    try:
        from pywhispercpp.model import Model
    except ImportError as exc:  # pragma: no cover - defensive
        raise TranscriptionError(
            "pywhispercpp is not installed. Run: pip install pywhispercpp "
            "(or poetry install with the 'local' extra)."
        ) from exc

    audio_path = _extract_audio(file_path, progress, fmt="wav")
    try:
        _report(progress, 0.2)
        try:
            model = Model(DEFAULT_WHISPER_MODEL, n_threads=DEFAULT_WHISPER_THREADS)
        except Exception as exc:
            raise TranscriptionError(
                f"Could not load whisper.cpp model {DEFAULT_WHISPER_MODEL!r}: {exc}"
            ) from exc

        try:
            transcribe_kwargs = {
                "token_timestamps": True,
                "max_len": 1,
                "split_on_word": True,
            }
            if language:
                transcribe_kwargs["language"] = language
            segments = model.transcribe(audio_path, **transcribe_kwargs)
        except Exception as exc:
            raise TranscriptionError(f"whisper.cpp transcription failed: {exc}") from exc
        finally:
            # Drop the model reference explicitly so the (potentially
            # multi-GB) weights are freed before analysis loads the LLM.
            del model

        # whisper.cpp segment times are in its own unit (centiseconds of
        # an internal 100Hz clock); t * 10 == milliseconds (matches the
        # to_timestamp() reference implementation).
        text_parts: list[str] = []
        words: list[dict] = []
        for segment in segments:
            piece = segment.text.strip()
            if not piece:
                continue
            text_parts.append(piece)
            words.append(
                {
                    "text": piece,
                    "start_ms": max(0, int(segment.t0 * 10)),
                    "end_ms": int(segment.t1 * 10),
                }
            )

        _report(progress, 1.0)
        # If a language hint was supplied we forced whisper.cpp to use it,
        # so it's also the "detected" language for downstream consumers.
        # Without a hint, pywhispercpp's transcribe() doesn't surface the
        # auto-detected code without a separate call, so it's left unknown.
        return TranscriptResult(
            text=" ".join(text_parts).strip(), words=words, language=language
        )
    finally:
        _quiet_remove(audio_path)


# ------------------------------------------------------------------ audio


def build_extract_command(video_path: str, out_path: str, fmt: str = "mp3", sample_rate: int = 16000) -> list[str]:
    """Build the FFmpeg command that pulls mono audio out of a video.

    ``fmt`` selects the output container/codec: ``wav`` produces a lossless
    16-bit PCM WAV (best quality for local whisper.cpp transcription),
    ``mp3`` produces a 64kbps MP3 (smaller upload for the cloud AssemblyAI
    path). ``sample_rate`` defaults to 16kHz, which whisper expects.
    """
    if fmt == "wav":
        codec_flags = ["-c:a", "pcm_s16le"]
    else:
        codec_flags = ["-c:a", "libmp3lame", "-b:a", "64k"]
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
        "-ar",
        str(sample_rate),
        *codec_flags,
        out_path,
    ]


def _extract_audio(video_path: str, progress, fmt: str = "mp3") -> str:
    if not os.path.isfile(video_path):
        raise TranscriptionError(f"File not found: {video_path}")

    suffix = ".wav" if fmt == "wav" else ".mp3"
    fd, out_path = tempfile.mkstemp(suffix=suffix)
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
                build_extract_command(video_path, out_path, fmt),
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


def _submit(session: requests.Session, audio_url: str, progress, language: str | None = None) -> str:
    _report(progress, 0.2)
    data: dict = {"audio_url": audio_url}
    if language:
        # Use the known language code (e.g. "id" from YouTube metadata) so
        # AssemblyAI doesn't have to auto-detect.
        data["language_code"] = language
    else:
        data["language_detection"] = True
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


def _poll(session: requests.Session, transcript_id: str, progress) -> TranscriptResult:
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
            lang = result.get("language_code") or result.get("language")
            return TranscriptResult(
                text=result.get("text") or "",
                words=_extract_words_from_payload(result),
                language=lang,
            )
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


def _extract_words_from_payload(payload: dict) -> list[dict]:
    """Normalize an AssemblyAI completed-transcript payload's ``words`` into
    ``[{"text", "start_ms", "end_ms"}, ...]``.

    The API returns a top-level ``words`` array (confirmed from the transcript
    schema). Each entry has ``text`` (str), ``start`` (ms int), ``end`` (ms
    int). Malformed/partial entries are skipped defensively.
    """
    words = payload.get("words") or []
    result: list[dict] = []
    for entry in words:
        if not isinstance(entry, dict):
            continue
        text = str(entry.get("text", "")).strip()
        start = entry.get("start")
        end = entry.get("end")
        if not text or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        result.append(
            {"text": text, "start_ms": int(start), "end_ms": int(end)}
        )
    return result


def _raise_for_status(response: requests.Response, stage: str) -> None:
    if response.status_code >= 400:
        raise TranscriptionError(
            f"AssemblyAI {stage} failed (HTTP {response.status_code}): "
            f"{response.text[:200]}"
        )
