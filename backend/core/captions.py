"""TikTok-style word-by-word caption builder (ASS subtitles).

Turns a clip's word timings plus a caption-style preset into an Advanced
SubStation Alpha (ASS) subtitle file that ffmpeg/libass can burn into the
rendered clip with the ``subtitles=`` filter.

Technique: rather than relying on ASS's ``\\k`` karaoke tags (which, per
the spec, make a syllable turn primary-colored *permanently* once its turn
starts — i.e. all already-spoken words stay highlighted, not just the
current one), each caption line is emitted as **one Dialogue event per
word**. Every event shows the full line text, with only the
currently-active word colored in ``highlight_color`` (via an inline
``\\c`` override) and the rest in ``primary_color``. Consecutive words'
events are back-to-back in time, so exactly one event is visible at any
instant and the highlight appears to move from word to word — the
standard TikTok/CapCut caption look. This avoids relying on ``\\k``'s
cumulative-duration semantics, which are easy to get subtly wrong.
"""

from __future__ import annotations

import re

# Reference output height the preset font sizes are tuned for (9:16 720x1280).
REFERENCE_HEIGHT = 1280

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")


class CaptionBuildError(Exception):
    """Raised when a caption style is invalid or cannot be built."""


def ass_color(hex_color: str) -> str:
    """Convert ``#RRGGBB`` (or ``RRGGBB``) to ASS ``&HBBGGRR&``."""
    match = _HEX_RE.match(hex_color.strip())
    if not match:
        raise CaptionBuildError(f"Invalid color: {hex_color!r} (expected #RRGGBB)")
    value = match.group(1)
    r, g, b = value[0:2], value[2:4], value[4:6]
    return f"&H{b}{g}{r}&"


def ass_alpha(fraction: float) -> str:
    """Convert an opacity fraction [0,1] to an ASS alpha byte string."""
    fraction = max(0.0, min(1.0, float(fraction)))
    alpha = int(round((1.0 - fraction) * 255))
    return f"&H{alpha:02X}&"


def _sanitize_text(text: str) -> str:
    """Strip characters that would break ASS parsing out of word text."""
    return text.replace("{", "").replace("}", "").replace("\\", "")


def _group_words(words: list[dict], max_chars: int) -> list[list[dict]]:
    """Greedily group words into caption lines by a max character budget.

    Keeps each line a contiguous run of words in transcript order. A
    single over-long word still gets its own line.
    """
    lines: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    for word in words:
        length = len(word["text"])
        if current and current_chars + length + 1 > max_chars:
            lines.append(current)
            current = []
            current_chars = 0
        current.append(word)
        current_chars += length + 1
    if current:
        lines.append(current)
    return lines


def _line_events(line: list[dict], highlight: str, idle: str) -> list[tuple[int, int, str]]:
    """Build (start_ms, end_ms, ass_text) for every word-highlight state of
    one caption line.

    Each event covers the active word's own time window. A word's window
    runs from its own ``start_ms`` to the next word's ``start_ms`` (so the
    highlight holds through any small gap/pause before the next word),
    except the last word, which ends at its own ``end_ms``.

    Windows are clamped to at least 1 centisecond rather than skipped:
    providers occasionally emit overlapping or zero-length word timings,
    and skipping used to punch holes in the highlight sequence — moments
    where no event was active and the caption vanished mid-line.
    """
    events: list[tuple[int, int, str]] = []
    for i, active in enumerate(line):
        start_ms = active["start_ms"]
        raw_end = line[i + 1]["start_ms"] if i + 1 < len(line) else active["end_ms"]
        end_ms = max(int(raw_end), start_ms + 1)
        rendered = " ".join(
            f"{{\\c{highlight if j == i else idle}}}{_sanitize_text(w['text'])}"
            for j, w in enumerate(line)
        )
        events.append((start_ms, end_ms, rendered))
    return events


def _scaled_font_size(style: dict, height: int) -> int:
    """Scale a preset's reference font size to the actual output height."""
    font_size = int(round(float(style.get("font_size", 64)) * height / REFERENCE_HEIGHT))
    return max(10, min(font_size, 511))


# Conservative average glyph-width-to-font-size ratio used to estimate how
# many characters fit on one line at a given font size. Bold/condensed
# display fonts (Anton, Space Grotesk) run narrower than this on average;
# erring high keeps the estimate conservative so lines wrap a bit early
# rather than overflow the frame. WrapStyle 0 (see build_ass) is the actual
# safety net if this estimate is ever too generous.
_AVG_CHAR_WIDTH_RATIO = 0.62
_LINE_HORIZONTAL_MARGIN_PX = 40  # matches MarginL=20 + MarginR=20 below


def _max_chars_for_width(width: int, font_size: int) -> int:
    """Estimate how many characters fit on one line at ``font_size`` within
    ``width`` pixels, after accounting for the style's side margins."""
    available = max(10, int(width) - _LINE_HORIZONTAL_MARGIN_PX)
    char_width = max(1.0, font_size * _AVG_CHAR_WIDTH_RATIO)
    return max(4, int(available // char_width))


def _style_section(style: dict, width: int, height: int) -> str:
    """Build the ``[V4+ Styles]`` section for a preset at a given frame size."""
    font_size = _scaled_font_size(style, height)

    bold = -1 if style.get("bold") else 0
    italic = -1 if style.get("italic") else 0
    outline = float(style.get("outline", 3))
    shadow = float(style.get("shadow", 0))

    idle = ass_color(str(style.get("primary_color", "#FFFFFF")))
    outline_color = ass_color(str(style.get("outline_color", "#000000")))
    back_color = "&H00000000&"

    border_style = 3 if style.get("boxed") else 1
    if style.get("boxed"):
        opacity = max(0.0, min(1.0, float(style.get("box_opacity", 0.0))))
        alpha = int(round((1.0 - opacity) * 255))
        back_color = f"&H{alpha:02X}000000&"
        outline = min(outline, 2)

    # y is a fraction from the top; for bottom alignment (an2), MarginV is
    # measured in pixels up from the bottom edge.
    y_frac = float(style.get("y", 0.8))
    margin_v = int(round((1.0 - y_frac) * height))
    margin_v = max(8, min(margin_v, height // 2))

    header = (
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding"
    )
    style_line = (
        "Style: Caption,{font},{size},{primary},{primary},"
        "{outline},{back},{bold},{italic},0,0,100,100,0,0,"
        "{border_style},{outline_w},{shadow_w},2,20,20,{margin_v},1"
    ).format(
        font=str(style.get("font", "Arial")),
        size=font_size,
        primary=idle,
        outline=outline_color,
        back=back_color,
        bold=bold,
        italic=italic,
        border_style=border_style,
        outline_w=outline,
        shadow_w=shadow,
        margin_v=margin_v,
    )
    return f"[V4+ Styles]\n{header}\n{style_line}"


def build_ass(
    words: list[dict],
    style: dict,
    width: int,
    height: int,
    max_chars_per_line: int = 32,
) -> str:
    """Build a complete ASS subtitle string for a clip.

    ``words`` is the clip-relative word list (``{"text", "start_ms",
    "end_ms"}``). ``width``/``height`` are the *output* frame dimensions
    (after cropping) so libass positions text against the burned frame.
    """
    if not words:
        raise CaptionBuildError("Cannot build captions: no words provided")
    if not style:
        raise CaptionBuildError("Cannot build captions: no style provided")

    preset_max_chars = int(style.get("max_chars_per_line", max_chars_per_line))
    font_size = _scaled_font_size(style, height)
    width_max_chars = _max_chars_for_width(width, font_size)
    # Use whichever budget is tighter: the preset's stylistic preference, or
    # what actually fits the output frame's width at this font size. This
    # keeps narrow (portrait) crops from overflowing while leaving wider
    # frames free to use the preset's intended line length.
    max_chars = min(preset_max_chars, width_max_chars)
    highlight = ass_color(str(style.get("highlight_color", "#FFD60A")))
    idle = ass_color(str(style.get("primary_color", "#FFFFFF")))

    script_info = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {int(width)}\n"
        f"PlayResY: {int(height)}\n"
        "ScaledBorderAndShadow: yes\n"
        "WrapStyle: 0"
    )
    styles_section = _style_section(style, width, height)

    lines = _group_words(words, max_chars)

    event_lines: list[str] = [
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for line in lines:
        for start_ms, end_ms, text in _line_events(line, highlight, idle):
            event_lines.append(
                f"Dialogue: 0,{_ass_time(start_ms)},{_ass_time(end_ms)},Caption,,0,0,0,,{text}"
            )

    events_section = "\n".join(event_lines)
    return "\n\n".join([script_info, styles_section, events_section]) + "\n"


def _ass_time(ms: int) -> str:
    """Format milliseconds as ASS ``h:mm:ss.cc`` (centiseconds)."""
    ms = max(0, int(ms))
    total_cs = int(round(ms / 10.0))
    hours, rem = divmod(total_cs, 360000)
    minutes, rem = divmod(rem, 6000)
    seconds, centis = divmod(rem, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centis:02d}"


def crop_dimensions(src_width: int, src_height: int, orientation: str) -> tuple[int, int]:
    """Output frame dimensions after the cutter's crop for ``orientation``.

    Mirrors ``core.cutter``'s crop math so ASS ``PlayRes`` matches the
    actual burned frame. ffmpeg's expression evaluator rounds
    ``ih*9/16``/``iw*9/16`` to the *nearest* integer (not truncated), so we
    use ``round()`` here to match — confirmed against real ffmpeg output
    (e.g. a 1080-tall source's ``ih*9/16`` = 607.5 crops to 608px wide, not
    607). Using ``int()`` truncation here would under-count the true output
    width by a pixel in exactly-.5 cases, which previously threw off the
    width-aware caption line wrapping in ``build_ass``.
    """
    src_width = max(1, int(src_width))
    src_height = max(1, int(src_height))
    if orientation == "landscape":
        out_w = src_width
        out_h = min(src_height, round(src_width * 9 / 16))
    elif orientation in ("original", None, ""):
        out_w = src_width
        out_h = src_height
    else:  # portrait (default)
        out_w = min(src_width, round(src_height * 9 / 16))
        out_h = src_height
    return out_w, out_h
