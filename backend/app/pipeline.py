"""Background pipeline orchestrator.

Runs a full clip job for a given ``Job`` row: download/transcribe/analyze/
cut, uploading final assets to S3 and inserting ``Clip`` rows as it goes.
Progress is persisted to the ``Job`` row so Next.js can poll it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
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

# overall progress ranges per stage (out of 100)
STAGE_RANGES = {
    "downloading": (2, 12),
    "transcribing": (15, 50),
    "analyzing": (52, 54),
    "cutting": (55, 99),
}


def _make_progress(job_id: str, lo: float, hi: float) -> Callable[[float], None]:
    def cb(fraction: float) -> None:
        clamped = max(0.0, min(1.0, fraction))
        db.update_job(job_id, progress=int(lo + (hi - lo) * clamped))

    return cb


def _extract_thumbnail(src: str, at: float, dest: str) -> bool:
    """Best-effort frame grab for a clip thumbnail."""
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
                "2",
                dest,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        return result.returncode == 0 and os.path.isfile(dest)
    except Exception:
        return False


def run_job(job_id: str) -> None:
    """Run the pipeline for ``job_id``, never raising (failures go to DB)."""
    try:
        _run(job_id)
    except Exception as exc:
        try:
            db.update_job(job_id, status="failed", stage=None, error=str(exc))
            job = db.get_job(job_id)
            if job:
                db.update_project(job["projectId"], status="failed")
        except Exception:
            pass


def _run(job_id: str) -> None:
    job = db.get_job(job_id)
    if not job:
        return
    project_id = job["projectId"]
    project = db.get_project(project_id)
    if not project:
        raise RuntimeError(f"Project {project_id} not found")

    options = job.get("options") or {}
    orientation = options.get("orientation", "portrait")
    max_clips = int(options.get("max_clips", 10))
    source = project["source"]
    source_type = project.get("sourceType", "youtube")

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

    workdir = tempfile.mkdtemp(prefix="clipforge_job_")
    local_video: str | None = None
    try:
        if source_type == "youtube":
            dl_dir = os.path.join(workdir, "src")
            local_video = youtube.download(
                source,
                dl_dir,
                progress=_make_progress(job_id, *STAGE_RANGES["downloading"]),
            )
        elif source_type == "upload":
            local_video = s3.download_object(
                source, os.path.join(workdir, "src.mp4")
            )
        else:
            raise RuntimeError(f"Unknown sourceType: {source_type!r}")
        db.update_job(job_id, stage="downloading", progress=12)

        db.update_job(job_id, stage="transcribing", progress=15)
        transcript = transcriber.transcribe(
            local_video,
            assemblyai_key,
            progress=_make_progress(job_id, *STAGE_RANGES["transcribing"]),
            provider=transcription_provider,
        )
        db.update_job(job_id, stage="transcribing", progress=50)

        db.update_job(job_id, stage="analyzing", progress=52)
        clips = analyzer.analyze(transcript, llm_api_key, llm_base_url, llm_model)
        if len(clips) > max_clips:
            clips = clips[:max_clips]
        if not clips:
            raise RuntimeError("The model returned no usable clip timestamps.")
        db.update_job(job_id, stage="analyzing", progress=54)

        db.update_job(job_id, stage="cutting", progress=55)
        out_dir = os.path.join(workdir, "clips")
        total = max(len(clips), 1)
        for i, clip in enumerate(clips, start=1):
            mp4 = cutter.cut_clip(
                local_video,
                clip["start"],
                clip["end"],
                clip["title"],
                out_dir,
                i,
                orientation,
            )
            upload = s3.upload_file(
                mp4, f"projects/{project_id}/clips", "video/mp4"
            )

            thumbnail_key = None
            thumb_png = os.path.join(out_dir, f"thumb_{i:02d}.png")
            mid = clip["start"] + (clip["end"] - clip["start"]) / 2.0
            if _extract_thumbnail(local_video, mid, thumb_png):
                try:
                    thumbnail_key = s3.upload_file(
                        thumb_png,
                        f"projects/{project_id}/thumbs",
                        "image/png",
                    ).key
                except Exception:
                    thumbnail_key = None

            db.add_clip(
                project_id,
                job_id,
                clip["title"],
                clip.get("hook"),
                clip["start"],
                clip["end"],
                upload.key,
                thumbnail_key,
            )

            lo, hi = STAGE_RANGES["cutting"]
            db.update_job(job_id, stage="cutting", progress=int(lo + (hi - lo) * i / total))

        db.update_job(job_id, status="completed", stage=None, progress=100)
        db.update_project(project_id, status="completed")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
