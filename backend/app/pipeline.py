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

import os
import shutil
import subprocess
import tempfile
import uuid
from typing import Callable

from core import analyzer, cutter, s3, transcriber, youtube

from . import db


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


# overall progress ranges per stage (out of 100) — analyze job
ANALYZE_STAGE_RANGES = {
    "downloading": (2, 25),
    "transcribing": (28, 70),
    "analyzing": (72, 99),
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


def _upload_thumbnail(project_id: str, thumb_path: str) -> str | None:
    """Upload a thumbnail to S3 (JPEG, unique key). Returns the S3 key, or
    None if upload fails (the clip just won't have a thumbnail)."""
    try:
        upload = s3.upload_file_as(
            thumb_path,
            f"projects/{project_id}/thumbs/{uuid.uuid4().hex}.jpg",
            "image/jpeg",
        )
        return upload.key
    except Exception:
        return None


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
            db.update_job(job_id, status="failed", stage=None, error=str(exc))
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
    source = project["source"]
    source_type = project.get("source_type", "youtube")

    settings = _settings()
    assemblyai_key = settings["assemblyai_key"]
    transcription_provider = settings["transcription_provider"]
    llm_api_key = settings["llm_api_key"]
    llm_base_url = settings["llm_base_url"]
    llm_model = settings["llm_model"]

    # AssemblyAI key is only required for the cloud transcription provider;
    # the local (whisper.cpp) provider needs no network credentials.
    if transcription_provider == "assemblyai" and not assemblyai_key:
        raise RuntimeError("ASSEMBLYAI_KEY environment variable is not set.")
    # A local Ollama/OpenAI-compatible server generally ignores the API key,
    # but the OpenAI SDK still requires a non-empty string to construct the
    # client, so LLM_API_KEY may be a dummy value (e.g. "ollama") when
    # LLM_BASE_URL points at a local endpoint.
    if not llm_api_key:
        raise RuntimeError(
            "LLM_API_KEY environment variable is not set (use any non-empty "
            "value, e.g. 'ollama', when LLM_BASE_URL points at a local server)."
        )

    db.update_project(project_id, status="running")
    db.update_job(job_id, status="running", stage="downloading", progress=2)

    workdir = tempfile.mkdtemp(prefix="clipforge_analyze_")
    local_video: str | None = None
    try:
        if source_type == "youtube":
            dl_dir = os.path.join(workdir, "src")
            local_video = youtube.download(
                source,
                dl_dir,
                progress=_make_progress(job_id, *ANALYZE_STAGE_RANGES["downloading"]),
            )
        elif source_type == "upload":
            # Already-uploaded source: it's already the canonical source
            # video in S3 under `source` (the presigned-upload key).
            local_video = s3.download_object(
                source, os.path.join(workdir, "src.mp4")
            )
        else:
            raise RuntimeError(f"Unknown sourceType: {source_type!r}")

        # Persist the canonical source video so previews can seek it and
        # render jobs can cut from it later, without re-downloading from
        # YouTube (which can go stale/rate-limited) each time.
        if source_type == "youtube":
            ext = os.path.splitext(local_video)[1] or ".mp4"
            source_key = f"projects/{project_id}/source{ext}"
            s3.upload_file_as(local_video, source_key, "video/mp4")
            db.update_project(project_id, source_key=source_key)
        else:
            db.update_project(project_id, source_key=source)

        db.update_job(job_id, stage="downloading", progress=25)

        db.update_job(job_id, stage="transcribing", progress=28)
        transcript = transcriber.transcribe(
            local_video,
            assemblyai_key,
            progress=_make_progress(job_id, *ANALYZE_STAGE_RANGES["transcribing"]),
            provider=transcription_provider,
        )
        db.update_job(job_id, stage="transcribing", progress=70)

        db.update_job(job_id, stage="analyzing", progress=72)
        clips = analyzer.analyze(transcript, llm_api_key, llm_base_url, llm_model)
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
            )

            lo, hi = ANALYZE_STAGE_RANGES["analyzing"]
            db.update_job(job_id, stage="analyzing", progress=int(lo + (hi - lo) * i / total))

        db.update_job(job_id, status="completed", stage=None, progress=100)
        db.update_project(project_id, status="completed")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


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

    db.update_job(job_id, status="running", stage="downloading", progress=2)

    workdir = tempfile.mkdtemp(prefix="clipforge_render_")
    try:
        ext = os.path.splitext(source_key)[1] or ".mp4"
        local_video = s3.download_object(source_key, os.path.join(workdir, f"src{ext}"))
        db.update_job(job_id, stage="downloading", progress=40)

        db.update_job(job_id, stage="cutting", progress=42)
        out_dir = os.path.join(workdir, "out")
        mp4 = cutter.cut_clip(
            local_video,
            clip["start_time"],
            clip["end_time"],
            clip["title"],
            out_dir,
            1,
            orientation,
        )
        db.update_job(job_id, stage="cutting", progress=90)

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

        db.update_job(job_id, status="completed", stage=None, progress=100)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
