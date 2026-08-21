"""FFmpeg video trimming and aspect-ratio cropping engine."""

from __future__ import annotations

import os
import re
import shutil
import subprocess

PORTRAIT = "portrait"
LANDSCAPE = "landscape"
ORIGINAL = "original"

PORTRAIT_FILTER = "crop=min(iw\\,ih*9/16):ih:(iw-min(iw\\,ih*9/16))/2:0"
LANDSCAPE_FILTER = "crop=iw:min(ih\\,iw*9/16):0:(ih-min(ih\\,iw*9/16))/2"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".ts"}


class CutterError(Exception):
    """Raised when FFmpeg is unavailable or a cut fails."""


def crop_filter_for(orientation: str) -> str | None:
    """Return the crop filter for ``orientation``, or None for no crop.

    - ``portrait`` crops to a 9:16 vertical window.
    - ``landscape`` crops to a 16:9 horizontal window.
    - ``original`` (or None/empty) leaves the source ratio untouched.
    """
    if orientation in (None, "", PORTRAIT):
        return PORTRAIT_FILTER
    if orientation == LANDSCAPE:
        return LANDSCAPE_FILTER
    if orientation == ORIGINAL:
        return None
    raise CutterError(f"Unknown orientation: {orientation!r}")


def verify_ffmpeg() -> str:
    """Return the path to ffmpeg, or raise CutterError if not found."""
    path = shutil.which("ffmpeg")
    if not path:
        raise CutterError(
            "ffmpeg was not found on the system PATH. Install ffmpeg and add it to PATH."
        )
    return path


def slugify(title: str) -> str:
    """Turn a clip title into a filesystem-safe filename slug."""
    slug = re.sub(r"[^A-Za-z0-9]+", "-", title.strip()).lower().strip("-")
    return slug or "clip"


def _escape_filter_path(path: str) -> str:
    """Escape a filesystem path for use inside an ffmpeg filter argument.

    ffmpeg filtergraph syntax treats ``:``, ``\\``, ``'`` and ``[``/``]`` as
    special; the subtitles filter's own docs show colons in Windows-style
    drive paths escaped as ``\\:``. Backslashes must be escaped first so we
    don't double-escape the backslashes we just inserted.
    """
    return path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def subtitles_filter_for(ass_path: str, fonts_dir: str | None = None) -> str:
    """Build the ``subtitles=`` filter fragment that burns an ASS file in."""
    escaped = _escape_filter_path(ass_path)
    parts = [f"subtitles={escaped}"]
    if fonts_dir:
        parts.append(f"fontsdir={_escape_filter_path(fonts_dir)}")
    return ":".join(parts)


def build_command(
    src: str,
    start: float,
    end: float,
    title: str,
    out_dir: str,
    index: int,
    orientation: str = PORTRAIT,
    subtitles_path: str | None = None,
    fonts_dir: str | None = None,
) -> list[str]:
    """Build the FFmpeg command that trims a clip to the chosen ratio.

    - ``-ss`` appears before ``-i`` for fast seeking, so we pass ``-t``
      (duration) rather than ``-to``.
    - ``orientation`` selects the crop filter: portrait (9:16), landscape
      (16:9), or original (no crop).
    - ``subtitles_path`` (optional): an ASS subtitle file to burn in via
      libass. Combined with the crop filter in one ``-vf`` chain so
      captions are positioned against the already-cropped frame.
    """
    duration = max(end - start, 0.1)
    filename = f"{slugify(title)}_{index:02d}.mp4"
    out_path = os.path.join(out_dir, filename)

    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start:.2f}",
        "-i",
        src,
        "-t",
        f"{duration:.2f}",
    ]

    filters = []
    crop_filter = crop_filter_for(orientation)
    if crop_filter:
        filters.append(crop_filter)
    if subtitles_path:
        filters.append(subtitles_filter_for(subtitles_path, fonts_dir))
    if filters:
        command += ["-vf", ",".join(filters)]

    command += [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        out_path,
    ]
    return command


def cut_clip(
    src: str,
    start: float,
    end: float,
    title: str,
    out_dir: str,
    index: int,
    orientation: str = PORTRAIT,
    subtitles_path: str | None = None,
    fonts_dir: str | None = None,
) -> str:
    """Cut a single clip to out_dir and return the output file path.

    ``subtitles_path`` (optional) is an ASS file burned in via libass;
    ``fonts_dir`` (optional) is a font directory passed to libass.
    """
    if not os.path.isfile(src):
        raise CutterError(f"Source video not found: {src}")

    verify_ffmpeg()

    os.makedirs(out_dir, exist_ok=True)

    command = build_command(
        src,
        start,
        end,
        title,
        out_dir,
        index,
        orientation,
        subtitles_path=subtitles_path,
        fonts_dir=fonts_dir,
    )
    result = subprocess.run(command, capture_output=True, text=True)

    if result.returncode != 0:
        stderr_tail = (result.stderr or result.stdout or "").strip().splitlines()
        detail = stderr_tail[-1] if stderr_tail else "unknown error"
        raise CutterError(f"FFmpeg failed for clip {title!r}: {detail}")

    return command[-1]
