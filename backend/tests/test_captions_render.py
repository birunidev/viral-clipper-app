"""End-to-end render check: burned-in captions must stay within the frame.

Unlike test_captions.py (which only checks the ASS text/structure), this
renders an actual frame through ffmpeg/libass and inspects pixels to make
sure word-wrapping keeps caption text inside the visible frame — especially
for narrow portrait crops, where a fixed per-preset character budget used
to let long lines run off the left/right edges (WrapStyle 2 disabled
libass's own line breaking, and the character budget didn't account for the
actual output width). Regression coverage for that fix: width-aware line
grouping in ``_group_words``/``build_ass`` plus ``WrapStyle: 0``.

Skipped entirely if ffmpeg isn't on PATH (matches the rest of the suite,
which assumes a dev/CI environment with ffmpeg installed for core.cutter).
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from app.caption_presets import builtin_style_by_key
from core import captions

FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None

pytestmark = pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="ffmpeg/ffprobe not on PATH")

# Long words on purpose: this is exactly the case that used to overflow a
# narrow portrait crop when line-wrapping only considered the preset's fixed
# character budget, not the actual output width.
_LONG_LINE_WORDS = [
    "This", "is", "a", "really", "long", "caption", "line", "that", "would",
    "definitely", "overflow", "a", "narrow", "portrait", "frame", "right", "now",
]

# Mid-gray background: far from the (white/near-white) caption text and its
# (black) outline, so any non-background pixel is unambiguously caption ink.
_BG_HEX = "808080"


def _words() -> list[dict]:
    return [
        {"text": w, "start_ms": i * 300, "end_ms": i * 300 + 280}
        for i, w in enumerate(_LONG_LINE_WORDS)
    ]


def _make_source(path: str, width: int, height: int) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=0x{_BG_HEX}:s={width}x{height}:d=1:r=5",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", path,
        ],
        check=True,
        capture_output=True,
    )


def _render_frame_rgb(src: str, ass_path: str, crop_filter: str, out_w: int, out_h: int) -> bytes:
    """Render one frame with the crop + subtitles filter chain and return
    its raw RGB24 bytes (matches core.cutter's filter ordering: crop first,
    then subtitles, so captions position against the cropped frame)."""
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", src,
            "-frames:v", "1",
            "-vf", f"{crop_filter},subtitles={ass_path}",
            "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
        ],
        check=True,
        capture_output=True,
    )
    data = result.stdout
    assert len(data) == out_w * out_h * 3, (
        f"unexpected raw frame size: got {len(data)} bytes, "
        f"expected {out_w * out_h * 3} for {out_w}x{out_h}"
    )
    return data


def _non_background_x_range(rgb: bytes, width: int, height: int, threshold: int = 15) -> tuple[int, int]:
    """Return (min_x, max_x) of any pixel differing from the flat gray
    background by more than ``threshold`` per channel. Returns (width, -1)
    if no such pixel exists (i.e. nothing was drawn)."""
    bg = int(_BG_HEX, 16)
    bg_r, bg_g, bg_b = (bg >> 16) & 0xFF, (bg >> 8) & 0xFF, bg & 0xFF

    min_x, max_x = width, -1
    row_stride = width * 3
    for y in range(height):
        row_off = y * row_stride
        for x in range(width):
            off = row_off + x * 3
            r, g, b = rgb[off], rgb[off + 1], rgb[off + 2]
            if abs(r - bg_r) > threshold or abs(g - bg_g) > threshold or abs(b - bg_b) > threshold:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
    return min_x, max_x


@pytest.fixture
def gray_source_1920x1080(tmp_path):
    src = str(tmp_path / "src.mp4")
    _make_source(src, 1920, 1080)
    return src


def test_portrait_captions_stay_within_frame_bounds(tmp_path, gray_source_1920x1080):
    """The long test line above, burned into a 1920x1080 source cropped to
    portrait (9:16 -> ~607px wide), must not touch the left/right edges."""
    style = builtin_style_by_key("pop")["config"]
    out_w, out_h = captions.crop_dimensions(1920, 1080, "portrait")

    ass = captions.build_ass(_words(), style, out_w, out_h)
    ass_path = str(tmp_path / "captions.ass")
    with open(ass_path, "w", encoding="utf-8") as fh:
        fh.write(ass)

    crop_filter = "crop=min(iw\\,ih*9/16):ih:(iw-min(iw\\,ih*9/16))/2:0"
    rgb = _render_frame_rgb(gray_source_1920x1080, ass_path, crop_filter, out_w, out_h)

    min_x, max_x = _non_background_x_range(rgb, out_w, out_h)
    assert max_x >= 0, "expected caption text to be visible in the rendered frame"

    # Small safety margin: text should stay comfortably inside the frame,
    # not merely avoid the literal edge pixel.
    margin = max(4, out_w // 40)
    assert min_x >= margin, (
        f"caption text touches/overflows the left edge (min_x={min_x}, "
        f"frame width={out_w}, margin={margin})"
    )
    assert max_x <= out_w - 1 - margin, (
        f"caption text touches/overflows the right edge (max_x={max_x}, "
        f"frame width={out_w}, margin={margin})"
    )


def test_landscape_captions_still_render_and_stay_in_bounds(tmp_path, gray_source_1920x1080):
    """Sanity check the fix doesn't regress the (already-fine) wide case."""
    style = builtin_style_by_key("classic")["config"]
    out_w, out_h = captions.crop_dimensions(1920, 1080, "landscape")

    ass = captions.build_ass(_words(), style, out_w, out_h)
    ass_path = str(tmp_path / "captions.ass")
    with open(ass_path, "w", encoding="utf-8") as fh:
        fh.write(ass)

    crop_filter = "crop=iw:min(ih\\,iw*9/16):0:(ih-min(ih\\,iw*9/16))/2"
    rgb = _render_frame_rgb(gray_source_1920x1080, ass_path, crop_filter, out_w, out_h)

    min_x, max_x = _non_background_x_range(rgb, out_w, out_h)
    assert max_x >= 0, "expected caption text to be visible in the rendered frame"
    assert min_x >= 2
    assert max_x <= out_w - 3


# Pop's highlight is #FF5A52 (red). Detection thresholds are generous enough
# for libass antialiasing but far from the white idle text and gray bg.
def _count_red_pixels(rgb: bytes) -> int:
    count = 0
    for i in range(0, len(rgb), 3):
        r, g, b = rgb[i], rgb[i + 1], rgb[i + 2]
        if r > 180 and g < 140 and b < 140 and (r - g) > 60 and (r - b) > 60:
            count += 1
    return count


_POP_WORDS = [
    {"text": "first", "start_ms": i * 400, "end_ms": i * 400 + 380}
    for i, w in enumerate(["first", "second", "third", "fourth"])
]


def test_word_highlight_moves_word_to_word(tmp_path, gray_source_1920x1080):
    """The whole point of TikTok captions: exactly one word is highlighted at
    a time, and WHICH word is highlighted changes as playback advances. We
    render one frame mid-word-1 and one mid-word-2 and assert both contain
    highlight-colored ink and that the highlighted regions differ."""
    style = builtin_style_by_key("pop")["config"]
    out_w, out_h = captions.crop_dimensions(1920, 1080, "portrait")

    ass = captions.build_ass(_POP_WORDS, style, out_w, out_h)
    ass_path = str(tmp_path / "captions.ass")
    with open(ass_path, "w", encoding="utf-8") as fh:
        fh.write(ass)

    crop_filter = "crop=min(iw\\,ih*9/16):ih:(iw-min(iw\\,ih*9/16))/2:0"

    # Burn the whole clip to a file first (like core.cutter does), then
    # sample frames from the OUTPUT at their real timestamps. Extracting a
    # single frame with -ss before -i resets PTS to ~0, which would always
    # show the first caption event.
    burned = str(tmp_path / "burned.mp4")
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", gray_source_1920x1080,
            "-t", "1.6",
            "-vf", f"{crop_filter},subtitles={ass_path}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            burned,
        ],
        check=True, capture_output=True,
    )

    def frame_at(seconds: float) -> bytes:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-ss", f"{seconds:.2f}", "-i", burned,
                "-frames:v", "1",
                "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
            ],
            check=True, capture_output=True,
        )
        assert len(result.stdout) == out_w * out_h * 3
        return result.stdout

    frame1 = frame_at(0.2)   # inside "first" [0, 380ms)
    frame2 = frame_at(0.6)   # inside "second" [400, 780ms)

    red1 = _count_red_pixels(frame1)
    red2 = _count_red_pixels(frame2)

    assert red1 > 50, (
        "expected highlight-colored pixels on the active word in frame 1 "
        f"(got {red1}) — word-by-word highlighting is not rendering"
    )
    assert red2 > 50, (
        "expected highlight-colored pixels on the active word in frame 2 "
        f"(got {red2}) — word-by-word highlighting is not rendering"
    )

    # The highlighted word occupies a different x-range in each frame.
    def red_x_range(rgb: bytes) -> tuple[int, int]:
        min_x, max_x = out_w, -1
        stride = out_w * 3
        for y in range(out_h):
            for x in range(out_w):
                off = y * stride + x * 3
                r, g, b = rgb[off], rgb[off + 1], rgb[off + 2]
                if r > 180 and g < 140 and b < 140 and (r - g) > 60 and (r - b) > 60:
                    min_x, max_x = min(min_x, x), max(max_x, x)
        return min_x, max_x

    r1_min, r1_max = red_x_range(frame1)
    r2_min, r2_max = red_x_range(frame2)
    assert abs(r1_min - r2_min) > 5 or abs(r1_max - r2_max) > 5, (
        "highlight did not move between words — captions render but are not "
        "word-by-word"
    )
