"""Background job orchestrators.

Two job types share the ``Job`` table (``type`` column):

- ``analyze`` — download the source, upload it to S3 as the project's
  canonical source video, transcribe, analyze, and insert ``Clip`` rows
  with timestamps only (no rendered video). This is the expensive,
  model-heavy job and only ever runs once per project (per pipeline run).
- ``render`` — cut exactly one clip from the stored source video with
  ffmpeg and upload the result to S3. Cheap, ffmpeg-only, run on demand
  when a user wants to download a specific clip. Enqueued lazily so
  clips are never rendered until someone actually wants the file.

Splitting these means clip *previews* never touch ffmpeg: the frontend
seeks the stored source video to [start_time, end_time] directly. Only a
real download request pays the cutting cost, and the rendered file is
cached in S3 (video_url) so repeat downloads are free.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from typing import Callable

from core import analyzer, billing, captions, cutter, s3, storage, transcriber, youtube

from . import db

logger = logging.getLogger(__name__)

# Browser capture produces WebM (VP8/9 + Opus) via MediaRecorder – transcode to
# MP4/H.264+AAC before handing to clipper (more compatible for ffmpeg pipeline
# and previews). Keep local; S3 source may stay WebM but pipeline works on MP4.
def _maybe_transcode_to_mp4(src: str) -> str:
    """If src is WebM, transcode to MP4/H.264+AAC via ffmpeg and return new path."""
    lower = src.lower()
    if lower.endswith(".mp4"):
        return src
    # also treat .webm, .mkv, or unknown ext with webm content
    needs = lower.endswith(".webm") or lower.endswith(".mkv") or lower.endswith(".mov")
    # Probe fallback: if ffprobe says not h264, transcode anyway – cheaper to just check ext
    if not needs:
        # check via ffprobe codec? skip – rely on ext for now
        return src
    dst = os.path.splitext(src)[0] + ".mp4"
    if dst == src:
        dst = src + ".mp4"
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", dst],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode == 0 and os.path.isfile(dst) and os.path.getsize(dst) > 0:
            logger.info("Transcoded %s (%s) -> %s for pipeline", src, os.path.splitext(src)[1], dst)
            # Replace original to save temp space; pipeline uses MP4 from here
            try:
                os.remove(src)
            except Exception:
                pass
            return dst
        else:
            logger.warning("WebM -> MP4 transcode failed (%s): %s", result.returncode, (result.stderr or "")[:400])
            return src
    except Exception as exc:
        logger.warning("Transcode error for %s: %s", src, exc)
        return src

# yt-dlp errors embed the full signed CDN URL (and SSRF attempts would embed
# internal ones). Strip URLs before persisting error text that users see.
_URL_IN_TEXT_RE = re.compile(r"https?://\S+")


def _safe_error(exc: Exception) -> str:
    msg = _URL_IN_TEXT_RE.sub("[url removed]", str(exc))
    # For YouTube bot-guard / safe-mode, keep the actionable hint but make it
    # user-friendly – frontend shows this in the job error toast.
    if "bot guard" in msg.lower() or "safe prod mode" in msg.lower() or "upload instead" in msg.lower():
        # No extra URLs to strip beyond _URL_IN_TEXT_RE, just ensure hint survives
        pass
    return msg


def _settings() -> dict:
    """Resolve runtime settings so .env is always read fresh (dotenv may load
    after this module is imported)."""
    return {
        "assemblyai_key": os.environ.get("ASSEMBLYAI_KEY", ""),
        "transcription_provider": os.environ.get("TRANSCRIPTION_PROVIDER", "assemblyai"),
        "llm_api_key": os.environ.get("LLM_API_KEY", ""),
        "llm_base_url": os.environ.get("LLM_BASE_URL", "https://ai.sumopod.com/v1"),
        "llm_model": os.environ.get("LLM_MODEL", "deepseek-v4-flash"),
    }


def _user_settings_for(user_id: str) -> dict:
    """Per-user settings merged over the env defaults.

    When BYOK is disabled (the default) every job runs on the operator's
    managed env keys and per-user keys are ignored. When BYOK is enabled, a
    user who has set their own keys overrides the app's shared env keys;
    anything unset falls back to env. Returns the same shape as
    ``_settings()`` but with keys decrypted from at-rest storage when used.
    """
    from core import secrets

    settings = _settings()
    if not billing.byok_enabled():
        # BYOK is disabled: every job runs on the operator's managed env keys
        # and per-user overrides are ignored.
        return settings

    row = db.get_user_settings(user_id)
    if not row:
        return settings

    llm_key = secrets.decrypt_secret(row.get("llm_api_key"))
    aai_key = secrets.decrypt_secret(row.get("assemblyai_key"))
    provider = row.get("transcription_provider")

    if llm_key:
        settings["llm_api_key"] = llm_key
    if row.get("llm_base_url"):
        settings["llm_base_url"] = row["llm_base_url"]
    if row.get("llm_model"):
        settings["llm_model"] = row["llm_model"]
    if provider in ("assemblyai", "local"):
        settings["transcription_provider"] = provider
    if aai_key:
        settings["assemblyai_key"] = aai_key
    return settings


# overall progress ranges per stage (out of 100) — analyze job
ANALYZE_STAGE_RANGES = {
    "downloading": (2, 25),
    "transcribing": (28, 70),
    "analyzing": (72, 90),  # LLM chunk calls
    "clips": (90, 99),      # thumbnails/caption derivation per clip
}

# overall progress ranges per stage (out of 100) — render job
RENDER_STAGE_RANGES = {
    "downloading": (2, 40),
    "cutting": (42, 99),
}


def _make_progress(job_id: str, lo: float, hi: float) -> Callable[[float], None]:
    def cb(fraction: float) -> None:
        clamped = max(0.0, min(1.0, fraction))
        db.update_job(job_id, progress=int(lo + (hi - lo) * clamped))

    return cb


def _extract_thumbnail(src: str, at: float, dest: str) -> bool:
    """Best-effort frame grab for a clip thumbnail (JPEG, fast).

    Extracts a single frame at ``at`` seconds using ffmpeg's fast seek.
    A single frame can land on a scene cut or black frame, so callers
    should try a few offsets (midpoint, start+1s, end-1s) before giving up.
    """
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{at:.2f}",
                "-i",
                src,
                "-frames:v",
                "1",
                "-q:v",
                "3",
                dest,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        return result.returncode == 0 and os.path.isfile(dest) and os.path.getsize(dest) > 0
    except Exception:
        return False


def _extract_thumbnail_offsets(src: str, start: float, end: float, dest: str) -> bool:
    """Try a few offsets inside the clip and write the first frame that
    succeeds to ``dest``. Prefers the midpoint, then just after the start,
    then just before the end — cheap insurance against landing on a scene
    cut or a black frame."""
    duration = max(end - start, 0.1)
    candidates = [
        start + duration / 2.0,        # midpoint
        start + min(1.0, duration / 4.0),  # near the start
        max(start, end - 1.0),         # near the end
    ]
    for i, ts in enumerate(candidates):
        attempt = dest if i == 0 else f"{dest}.{i}"
        if _extract_thumbnail(src, ts, attempt):
            if i > 0:
                shutil.move(attempt, dest)
            return True
        if os.path.exists(attempt):
            os.remove(attempt)
    return False


def _probe_duration(video_path: str) -> float:
    """Return the video duration in seconds via ffprobe (0.0 on failure).

    Used to meter the plan's monthly managed minutes after a successful
    analyze (the cost of transcription + analysis scales with video length).
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return 0.0
        return float(result.stdout.strip() or 0.0 or 0)
    except Exception:
        return 0.0


def _probe_dimensions(video_path: str) -> tuple[int, int] | None:
    """Return (width, height) of a video via ffprobe, or None on failure.

    Uses ffprobe (ships with ffmpeg) to read the first video stream's
    dimensions — needed to size the ASS ``PlayRes`` to the cropped frame.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return None
        csv = result.stdout.strip()
        w, h = csv.split("x")
        return int(w), int(h)
    except Exception:
        return None


def _build_caption_file(
    clip: dict, style: dict, local_video: str, orientation: str, out_dir: str
) -> str | None:
    """Write an ASS caption file for ``clip`` and return its path, or None if
    captions can't be built (no words or invalid style). Failures are logged
    — a silent None here used to produce renders with no subtitles and no
    trace of why."""
    caption_words = clip.get("caption_json")
    if not caption_words:
        logger.warning(
            "Clip %s has no caption words; rendering without burned captions. "
            "This usually means the transcript had no word timings for this "
            "clip's time window.",
            clip.get("id"),
        )
        return None

    dims = _probe_dimensions(local_video)
    if not dims:
        logger.warning(
            "Could not probe video dimensions for clip %s; rendering without "
            "burned captions.",
            clip.get("id"),
        )
        return None
    out_w, out_h = captions.crop_dimensions(dims[0], dims[1], orientation)

    try:
        ass = captions.build_ass(caption_words, style, out_w, out_h)
    except captions.CaptionBuildError as exc:
        logger.warning(
            "Invalid caption style for clip %s (%s); rendering without "
            "burned captions.",
            clip.get("id"),
            exc,
        )
        return None
    os.makedirs(out_dir, exist_ok=True)
    ass_path = os.path.join(out_dir, "captions.ass")
    with open(ass_path, "w", encoding="utf-8") as fh:
        fh.write(ass)
    return ass_path


def _upload_thumbnail(project_id: str, thumb_path: str) -> str | None:
    """Upload a thumbnail to S3 (JPEG, unique key). Returns the S3 key, or
    None if upload fails (the clip just won't have a thumbnail)."""
    project = db.get_project(project_id)
    user_id = project.get("user_id", "") if project else ""
    thumb_size = os.path.getsize(thumb_path)
    # Gracefully skip thumbnail upload when the user is at their cap — the
    # clip still renders and downloads fine without it.
    if not storage.has_storage_room(user_id, thumb_size):
        return None
    try:
        upload = s3.upload_file_as(
            thumb_path,
            f"projects/{project_id}/thumbs/{uuid.uuid4().hex}.jpg",
            "image/jpeg",
        )
        storage.add_project_storage(project_id, user_id, upload.size_bytes)
        return upload.key
    except Exception:
        return None


def _build_clip_caption_json(project_id: str, start: float, end: float) -> list[dict] | None:
    """Words within a clip's [start, end] (seconds), re-anchored to
    clip-relative milliseconds for TikTok-style word-by-word captions.

    Returns None (no captions) when the project has no timeline words at
    all (e.g. the active transcription provider doesn't return word
    timings). Words that straddle the clip boundary are clamped to the
    clip's own duration so the caption never runs past the trimmed video.

    The clip bounds come from the LLM, whose timestamps routinely drift by
    a second or more. When its window catches zero timeline words we clamp
    the window into the timeline's actual span and retry once, so a drifted
    clip still gets captions instead of silently rendering with none.
    """
    start_ms = int(start * 1000)
    end_ms = int(end * 1000)
    words = db.get_timeline_words_in_range(project_id, start_ms, end_ms)
    if not words:
        # LLM window missed every word — snap it back onto the timeline,
        # preserving the window's duration so it still covers a sensible
        # stretch of speech instead of collapsing onto one word.
        timeline = db.get_timeline_words(project_id)
        if timeline:
            lo = timeline[0]["start_ms"]
            hi = max(w["end_ms"] for w in timeline)
            duration = max(end_ms - start_ms, 1)
            if start_ms > hi:
                # Drifted past the end of the transcript.
                end_ms = hi
                start_ms = max(lo, hi - duration)
            elif end_ms < lo:
                # Drifted before the start of the transcript.
                start_ms = lo
                end_ms = min(hi, lo + duration)
            else:
                # Inside the span but in a gap between words — clamp.
                start_ms = min(max(start_ms, lo), hi - 1)
                end_ms = min(max(end_ms, start_ms + 1), hi)
            words = db.get_timeline_words_in_range(project_id, start_ms, end_ms)
    if not words:
        return None

    duration_ms = max(end_ms - start_ms, 1)
    caption_words = []
    for word in words:
        rel_start = max(0, word["start_ms"] - start_ms)
        rel_end = min(duration_ms, word["end_ms"] - start_ms)
        rel_end = max(rel_end, rel_start + 1)
        caption_words.append({"text": word["text"], "start_ms": rel_start, "end_ms": rel_end})
    return caption_words or None


def run_job(job_id: str) -> None:
    """Dispatch a job to the right runner by its ``type``, never raising."""
    job = db.get_job(job_id)
    if not job:
        return
    job_type = job.get("type") or "analyze"
    try:
        if job_type == "render":
            _run_render(job_id)
        else:
            _run_analyze(job_id)
    except Exception as exc:
        try:
            db.update_job(job_id, status="failed", stage=None, error=_safe_error(exc))
            job = db.get_job(job_id)
            if job and job_type == "analyze":
                db.update_project(job["project_id"], status="failed")
        except Exception:
            pass


# ------------------------------------------------------------------ analyze


def _run_analyze(job_id: str) -> None:
    job = db.get_job(job_id)
    if not job:
        return
    project_id = job["project_id"]
    project = db.get_project(project_id)
    if not project:
        raise RuntimeError(f"Project {project_id} not found")

    options = job.get("options") or {}
    max_clips = int(options.get("max_clips", 10))
    min_clip_seconds = int(options.get("min_clip_seconds", 15))
    max_clip_seconds = int(options.get("max_clip_seconds", 90))
    source = project["source"]
    source_type = project.get("source_type", "youtube")

    settings = _user_settings_for(project.get("user_id", ""))
    assemblyai_key = settings["assemblyai_key"]
    transcription_provider = settings["transcription_provider"]
    llm_api_key = settings["llm_api_key"]
    llm_base_url = settings["llm_base_url"]
    llm_model = settings["llm_model"]

    # AssemblyAI key is only required for the cloud transcription provider;
    # the local (whisper.cpp) provider needs no network credentials. The key
    # can come from the user's own BYOK settings or the app's env config.
    if transcription_provider == "assemblyai" and not assemblyai_key:
        raise RuntimeError(
            "No AssemblyAI API key set. Add one in Settings, or set "
            "ASSEMBLYAI_KEY in the backend environment."
        )
    # A local Ollama/OpenAI-compatible server generally ignores the API key,
    # but the OpenAI SDK still requires a non-empty string to construct the
    # client, so LLM_API_KEY may be a dummy value (e.g. "ollama") when
    # LLM_BASE_URL points at a local endpoint.
    if not llm_api_key:
        raise RuntimeError(
            "No LLM API key set. Add one in Settings, or set LLM_API_KEY in "
            "the backend environment (any non-empty value, e.g. 'ollama', "
            "works when LLM_BASE_URL points at a local server)."
        )

    db.update_project(project_id, status="running")
    db.update_job(job_id, status="running", stage="downloading", progress=2)

    workdir = tempfile.mkdtemp(prefix="clipforge_analyze_")
    local_video: str | None = None
    # True when we pulled a fresh copy from YouTube this run (vs reusing
    # the canonical source already stored in S3 from an earlier attempt).
    downloaded_fresh = False
    # Spoken-language hint, ISO 639-1. Preferred source: the source video's
    # own metadata (yt-dlp exposes `language` for many YouTube videos, e.g.
    # "id" for Bahasa Indonesia). If unavailable, transcription auto-detects.
    source_language: str | None = None
    try:
        if source_type == "youtube":
            existing_key = (project.get("source_key") or "").strip()
            if existing_key and s3.head_object_size_default_bucket(existing_key) is not None:
                # A previous run already downloaded and stored the canonical
                # source video (e.g. transcription/analysis failed after the
                # download stage). Reuse it instead of hitting YouTube again
                # — the download is the slowest, most fragile stage and the
                # video can go stale or get rate-limited between attempts.
                # Reported as "preparing", not "downloading": no YouTube hit.
                ext = os.path.splitext(existing_key)[1] or ".mp4"
                db.update_job(job_id, status="running", stage="preparing", progress=2)

                def _store_progress(t: tuple[int, int]) -> None:
                    sent, total = t
                    if total:
                        db.update_job(
                            job_id, progress=int(2 + 20 * min(1.0, sent / total))
                        )

                local_video = s3.download_object(
                    existing_key,
                    os.path.join(workdir, f"src{ext}"),
                    progress=_store_progress,
                )
            else:
                downloaded_fresh = True
                dl_dir = os.path.join(workdir, "src")
                # Fetch metadata first so we can pass the video's spoken language
                # down to the transcription provider as a hint. Persist it right
                # away (not after a later stage) so it survives even if the
                # download itself fails afterwards.
                try:
                    # Pass per-request client cookies if opted in (ephemeral file)
                    _cookies_path = f"/tmp/youtube_cookies_{project_id}.txt"
                    _has_cookies = os.path.isfile(_cookies_path)
                    # get_info prefers official API, but may fallback to yt-dlp
                    # which benefits from cookies on bot-guarded videos
                    info = youtube.get_info(source)
                    source_language = info.get("language") or info.get("original_language")
                    if source_language:
                        db.update_project(project_id, language=source_language)
                except Exception:
                    source_language = None
                    _has_cookies = os.path.isfile(f"/tmp/youtube_cookies_{project_id}.txt")
                # Resilient download via clean abstraction: download_video(url) -> {video_path, method_used, format}
                # Delegates to core.downloader with fallback chain (android,ios,tv,tv_embedded,web_embedded,web),
                # timeout, bot-signature detection, PO token sidecar, pacing & rate limiter.
                try:
                    from core.downloader import download_video as _download_video

                    _dl_result = _download_video(
                        source,
                        dl_dir,
                        progress=_make_progress(job_id, *ANALYZE_STAGE_RANGES["downloading"]),
                        project_id=project_id,
                    )
                    local_video = _dl_result.video_path
                    logger.info(
                        "YouTube download succeeded via %s (pot=%s format=%s) for project %s",
                        _dl_result.method_used,
                        _dl_result.with_pot,
                        _dl_result.format,
                        project_id,
                    )
                    # Persist method for per-job observability (visible via GET /jobs/{id})
                    try:
                        existing_opts = (job.get("options") or {}).copy()
                        existing_opts["download_method"] = _dl_result.method_used
                        existing_opts["download_pot"] = _dl_result.with_pot
                        existing_opts["download_format"] = _dl_result.format
                        db.update_job(job_id, options=existing_opts)
                    except Exception:
                        pass
                except Exception as _dl_exc:
                    # If downloader abstraction fails, surface directly (it already wraps DownloadError)
                    # Fallback to legacy wrapper only for import errors
                    if "DownloadError" in type(_dl_exc).__name__ or "download" in str(_dl_exc).lower():
                        raise
                    local_video = youtube.download(
                        source,
                        dl_dir,
                        progress=_make_progress(job_id, *ANALYZE_STAGE_RANGES["downloading"]),
                        project_id=project_id,
                    )
                # Clean up ephemeral client cookies after successful download
                try:
                    if os.path.isfile(f"/tmp/youtube_cookies_{project_id}.txt"):
                        os.remove(f"/tmp/youtube_cookies_{project_id}.txt")
                except Exception:
                    pass
                # Ensure MP4 for downstream pipeline (covers rare webm/**)
                local_video = _maybe_transcode_to_mp4(local_video)
        elif source_type == "upload":
            # Already-uploaded source: it's already the canonical source
            # video in S3 under `source` (the presigned-upload key).
            # Preserve original extension so WebM from tab capture keeps its suffix
            # for correct probe, then transcode to MP4 if needed.
            orig_ext = os.path.splitext(source)[1] or ".mp4"
            if orig_ext.lower() not in (".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"):
                orig_ext = ".mp4"
            local_video = s3.download_object(
                source, os.path.join(workdir, f"src{orig_ext}")
            )
            # Capture path yields WebM – convert before clipper pipeline
            local_video = _maybe_transcode_to_mp4(local_video)
        else:
            raise RuntimeError(f"Unknown sourceType: {source_type!r}")

        # Persist the canonical source video (only for a freshly downloaded
        # copy — a reused stored source is already uploaded and accounted)
        # so previews can seek it and render jobs can cut from it later,
        # without re-downloading from YouTube (which can go stale/rate-
        # limited) each time.
        if source_type == "youtube" and downloaded_fresh:
            ext = os.path.splitext(local_video)[1] or ".mp4"
            source_key = f"projects/{project_id}/source{ext}"

            # Previously accounted source size (0 for a brand-new project).
            prev_source_size = int(project.get("source_size_bytes") or 0)

            # Remove old accounting so we can re-add with the correct net
            # delta. add_project_storage uses atomic increments, so this is
            # safe under concurrent workers. Re-analysis of the same video
            # must be net-zero, not a double count.
            if prev_source_size:
                storage.add_project_storage(
                    project_id, project.get("user_id", ""), -prev_source_size
                )

            source_size = os.path.getsize(local_video)
            delta = source_size - prev_source_size

            # Enforce the cap on the *net additional* bytes only (negative
            # when the replacement source is smaller — nothing to enforce).
            if delta > 0:
                storage.enforce_cap(project.get("user_id", ""), delta)

            s3.upload_file_as(local_video, source_key, "video/mp4")
            db.update_project(project_id, source_key=source_key, source_size_bytes=source_size)
            storage.add_project_storage(project_id, project.get("user_id", ""), source_size)
        elif source_type == "upload":
            # Uploads: the presigned key IS the canonical source location.
            db.update_project(project_id, source_key=source)

        db.update_job(job_id, stage="downloading", progress=25)

        db.update_job(job_id, stage="transcribing", progress=28)

        # Authoritative credit enforcement, right before the expensive
        # transcription (the real API cost) runs. The API pre-checks at
        # enqueue, but a user can queue several jobs across projects; checking
        # here against the *actual* video length prevents spending operator
        # credits past the balance before it is deducted. Managed users (the
        # default) always pay; BYOK users (flag opt-in) are unmetered.
        user_id = project.get("user_id", "")
        cached_words = db.get_timeline_words(project_id)
        if cached_words:
            # A previous attempt already transcribed this exact source (e.g.
            # analysis/LLM failed afterwards). Resume from the stored word
            # timeline instead of paying for — and waiting on — a second
            # transcription pass.
            transcript_result = transcriber.TranscriptResult(
                text=" ".join(w["text"] for w in cached_words),
                words=cached_words,
                language=project.get("language"),
            )
        else:
            if user_id and billing.uses_managed(user_id):
                billing.enforce_credits(user_id, _probe_duration(local_video))

            transcript_result = transcriber.transcribe_with_words(
                local_video,
                assemblyai_key,
                progress=_make_progress(job_id, *ANALYZE_STAGE_RANGES["transcribing"]),
                provider=transcription_provider,
                language=source_language,
            )

            # Deduct credits (1 = 1 source minute) for a *managed* job (operator keys)
            # as soon as transcription completes — the bulk of the cost. Deducting
            # here (not after analysis) means a job that fails analysis still
            # costs its source length, since the expensive transcription ran.
            if user_id and billing.uses_managed(user_id):
                billing.record_credits(user_id, _probe_duration(local_video))

        # Prefer the transcription provider's detected language (ground
        # truth) over the source metadata hint.
        detected_language = transcript_result.language or source_language
        if detected_language:
            db.update_project(project_id, language=detected_language)

        # Persist the absolute-timed word timeline once per project. Every
        # clip reuses it to derive its own caption timings (no re-transcribe).
        db.add_timeline_words(project_id, transcript_result.words)

        db.update_job(job_id, stage="analyzing", progress=72)
        clips = analyzer.analyze(
            transcript_result.text,
            llm_api_key,
            llm_base_url,
            llm_model,
            language=detected_language,
            min_duration=min_clip_seconds,
            max_duration=max_clip_seconds,
            words=transcript_result.words,
            progress=_make_progress(job_id, *ANALYZE_STAGE_RANGES["analyzing"]),
        )
        if len(clips) > max_clips:
            clips = clips[:max_clips]
        if not clips:
            raise RuntimeError("The model returned no usable clip timestamps.")

        thumb_dir = os.path.join(workdir, "thumbs")
        os.makedirs(thumb_dir, exist_ok=True)
        total = max(len(clips), 1)
        for i, clip in enumerate(clips, start=1):
            # Capture a thumbnail from the source video now that we know
            # the timestamps. Try a few offsets inside the clip so a scene
            # cut at the exact midpoint doesn't leave the clip thumbnailless.
            thumbnail_key = None
            thumb_jpg = os.path.join(thumb_dir, f"thumb_{i:02d}.jpg")
            if _extract_thumbnail_offsets(local_video, clip["start"], clip["end"], thumb_jpg):
                thumbnail_key = _upload_thumbnail(project_id, thumb_jpg)

            # Derive clip-relative caption timings for TikTok-style
            # word-by-word captions. Empty when the provider returned no
            # word timings (the clip simply renders without captions).
            caption_json = _build_clip_caption_json(project_id, clip["start"], clip["end"])

            # video_url is intentionally left unset — clips preview by
            # seeking the source video, and only get their own rendered
            # file once a render job is requested (see _run_render).
            db.add_clip(
                project_id,
                job_id,
                clip["title"],
                clip.get("hook"),
                clip["start"],
                clip["end"],
                None,
                thumbnail_key,
                caption_json=caption_json,
            )

            lo, hi = ANALYZE_STAGE_RANGES["clips"]
            db.update_job(job_id, stage="analyzing", progress=int(lo + (hi - lo) * i / total))

        db.update_job(job_id, status="completed", stage=None, progress=100)
        db.update_project(project_id, status="completed")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        # Ephemeral client cookies (consent opt-in) — always delete after job
        try:
            _ck = f"/tmp/youtube_cookies_{project_id}.txt"
            if os.path.isfile(_ck):
                os.remove(_ck)
        except Exception:
            pass


# ------------------------------------------------------------------- render


def _run_render(job_id: str) -> None:
    """Cut a single clip on demand and upload it to S3.

    Downloads the project's stored source video (never re-downloads from
    YouTube), cuts the clip's [start_time, end_time] with the requested
    orientation, uploads the result, and stamps ``clip.video_url``. The
    rendered file persists in S3, so a second download of the same clip
    is instant (no re-render).
    """
    job = db.get_job(job_id)
    if not job:
        return
    clip_id = job.get("clip_id")
    if not clip_id:
        raise RuntimeError("Render job is missing clip_id")

    clip = db.get_clip(clip_id)
    if not clip:
        raise RuntimeError(f"Clip {clip_id} not found")

    project_id = job["project_id"]
    project = db.get_project(project_id)
    if not project:
        raise RuntimeError(f"Project {project_id} not found")

    source_key = project.get("source_key")
    if not source_key:
        raise RuntimeError("Project has no stored source video to render from")

    options = job.get("options") or {}
    orientation = options.get("orientation", "portrait")
    caption_style_id = options.get("caption_style_id")

    # Plan entitlements: cap resolution and stamp watermark on constrained
    # tiers (e.g. trial). Always allowed, just constrained.
    _allow, max_resolution, watermark = billing.render_allowed(project.get("user_id", ""))
    _ = _allow  # rendering is always allowed; only constrained below

    # Resolve the caption style preset (if requested) so we can burn it in.
    caption_style = None
    if caption_style_id:
        caption_style = db.get_caption_style_visible_to(
            caption_style_id, project.get("user_id", "")
        )
        if caption_style is None:
            raise RuntimeError(f"Caption style {caption_style_id!r} not found")

    db.update_job(job_id, status="running", stage="downloading", progress=2)

    workdir = tempfile.mkdtemp(prefix="clipforge_render_")
    try:
        ext = os.path.splitext(source_key)[1] or ".mp4"
        local_video = s3.download_object(source_key, os.path.join(workdir, f"src{ext}"))
        db.update_job(job_id, stage="downloading", progress=40)

        db.update_job(job_id, stage="cutting", progress=42)
        out_dir = os.path.join(workdir, "out")
        os.makedirs(out_dir, exist_ok=True)

        ass_path = None
        if caption_style is not None:
            ass_path = _build_caption_file(
                clip, caption_style.get("config") or {}, local_video, orientation, out_dir
            )

        mp4 = cutter.cut_clip(
            local_video,
            clip["start_time"],
            clip["end_time"],
            clip["title"],
            out_dir,
            1,
            orientation,
            subtitles_path=ass_path,
            fonts_dir=os.environ.get("CAPTION_FONTS_DIR", "/app/fonts"),
            max_resolution=max_resolution,
            watermark=watermark,
        )
        db.update_job(job_id, stage="cutting", progress=90)

        # Pre-check the rendered clip size against the user's storage cap;
        # if the user is already at their limit the render fails fast with a
        # clear error rather than silently uploading an unbounded file.
        render_size = os.path.getsize(mp4)
        user_id = project.get("user_id", "")
        if user_id:
            storage.enforce_cap(user_id, render_size)

        # If the clip never got a thumbnail during analysis (scene cut at
        # the midpoint, transient failure, or an older clip), backfill one
        # now that we have the source video locally — it's nearly free.
        if not clip.get("thumbnail_url"):
            thumb_jpg = os.path.join(out_dir, "thumb.jpg")
            if _extract_thumbnail_offsets(local_video, clip["start_time"], clip["end_time"], thumb_jpg):
                thumb_key = _upload_thumbnail(project_id, thumb_jpg)
                if thumb_key:
                    db.set_clip_thumbnail_url(clip_id, thumb_key)

        upload = s3.upload_file(mp4, f"projects/{project_id}/clips", "video/mp4")
        db.set_clip_video_url(clip_id, upload.key)
        storage.add_project_storage(project_id, project.get("user_id", ""), upload.size_bytes)

        db.update_job(job_id, status="completed", stage=None, progress=100)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
