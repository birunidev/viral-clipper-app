"""Tests for the TikTok-style caption ASS builder (core/captions.py)."""

from __future__ import annotations

import pytest

from core.captions import (
    CaptionBuildError,
    _ass_time,
    _group_words,
    _line_events,
    ass_alpha,
    ass_color,
    build_ass,
    crop_dimensions,
)

CLASSIC = {
    "font": "Anton",
    "font_size": 72,
    "x": "center",
    "y": 0.8,
    "bold": True,
    "italic": False,
    "primary_color": "#FFFFFF",
    "highlight_color": "#FFD60A",
    "outline_color": "#000000",
    "outline": 4,
    "shadow": 0,
    "words_per_line": 4,
    "max_chars_per_line": 32,
    "boxed": False,
    "box_opacity": 0.0,
}


def _words():
    return [
        {"text": "Hello", "start_ms": 0, "end_ms": 400},
        {"text": "world", "start_ms": 450, "end_ms": 800},
        {"text": "again", "start_ms": 900, "end_ms": 1300},
    ]


# -------------------------------------------------------------- colors / time


def test_ass_color_conversion():
    assert ass_color("#FFFFFF") == "&HFFFFFF&"
    assert ass_color("FF0000") == "&H0000FF&"  # red -> BGR 0000FF
    assert ass_color("#00FF00") == "&H00FF00&"  # green -> BGR 00FF00
    assert ass_color("#0000FF") == "&HFF0000&"  # blue -> BGR FF0000
    with pytest.raises(CaptionBuildError):
        ass_color("#12345")


def test_ass_alpha_opacity_fraction():
    assert ass_alpha(1.0) == "&H00&"   # fully opaque
    assert ass_alpha(0.0) == "&HFF&"   # fully transparent
    assert ass_alpha(0.5) == "&H80&"   # 50% opacity -> alpha 0x80


def test_ass_time():
    assert _ass_time(0) == "0:00:00.00"
    assert _ass_time(450) == "0:00:00.45"
    assert _ass_time(61000) == "0:01:01.00"
    assert _ass_time(3661000) == "1:01:01.00"


# -------------------------------------------------------------- grouping


def test_group_words_respects_max_chars():
    grouped = _group_words(
        [
            {"text": "a", "start_ms": 0, "end_ms": 100},
            {"text": "bbbbbbbbbbbbbbbbbbbb", "start_ms": 100, "end_ms": 200},
            {"text": "c", "start_ms": 200, "end_ms": 300},
        ],
        max_chars=10,
    )
    # "a bbbbbbbbbbbbbbbbbbbb" exceeds 10 chars -> new line; "c" new line
    assert len(grouped) == 3


def test_line_events_highlights_each_word_in_turn():
    words = _words()
    events = _line_events(words, "&H0AD6FF&", "&HFFFFFF&")
    assert len(events) == 3
    # first event highlights only "Hello"
    assert events[0][2] == "{\\c&H0AD6FF&}Hello {\\c&HFFFFFF&}world {\\c&HFFFFFF&}again"


def test_line_events_times_are_back_to_back():
    words = _words()
    events = _line_events(words, "&HAAAA&", "&HBBBB&")
    assert [e[0] for e in events] == [0, 450, 900]
    assert [e[1] for e in events] == [450, 900, 1300]


# ------------------------------------------------------------ build_ass


def test_build_ass_structure():
    ass = build_ass(_words(), CLASSIC, 720, 1280)
    assert ass.startswith("[Script Info]")
    assert "PlayResX: 720" in ass
    assert "PlayResY: 1280" in ass
    assert "[V4+ Styles]" in ass
    assert "Style: Caption,Anton," in ass
    assert "[Events]" in ass
    # three words -> three events
    assert ass.count("Dialogue:") == 3
    # karaoke inline colors present
    assert "\\c&H0AD6FF&" in ass  # highlight (#FFD60A -> BGR)
    assert "\\c&HFFFFFF&" in ass  # idle


def test_build_ass_no_words_raises():
    with pytest.raises(CaptionBuildError, match="no words"):
        build_ass([], CLASSIC, 720, 1280)


def test_build_ass_no_style_raises():
    with pytest.raises(CaptionBuildError, match="no style"):
        build_ass(_words(), {}, 720, 1280)


def test_build_ass_scales_font_to_output_height():
    # small output -> smaller font, proportionally
    ass_large = build_ass(_words(), CLASSIC, 720, 1280)
    ass_small = build_ass(_words(), CLASSIC, 360, 640)
    # 72 * 640/1280 = 36
    assert "Style: Caption,Anton,72," in ass_large
    assert "Style: Caption,Anton,36," in ass_small


def test_build_ass_boxed_uses_border_style_3():
    boxed = dict(CLASSIC, boxed=True, box_opacity=0.45)
    ass = build_ass(_words(), boxed, 720, 1280)
    assert ",3," in ass  # border-style 3 = boxed backdrop
    assert "&H8C000000&" in ass  # 0.45 opacity -> alpha 8C


# ------------------------------------------------------------ crop dims


def test_crop_dimensions_portrait():
    # 1920x1080 source -> portrait crop width is min(iw, ih*9/16).
    # ih*9/16 = 1080*9/16 = 607.5, and ffmpeg's expression evaluator rounds
    # this to the *nearest* integer (608), not truncated (confirmed against
    # real ffmpeg crop filter output) -> min(1920, 608) = 608. So 608x1080.
    w, h = crop_dimensions(1920, 1080, "portrait")
    assert w == 608 and h == 1080


def test_crop_dimensions_landscape():
    # 1080x1920 portrait source -> landscape crop height is min(ih, iw*9/16).
    # iw*9/16 = 1080*9/16 = 607.5 -> rounds to 608 (see note above) ->
    # min(1920, 608) = 608. So 1080x608.
    w, h = crop_dimensions(1080, 1920, "landscape")
    assert w == 1080 and h == 608


def test_crop_dimensions_original():
    assert crop_dimensions(1920, 1080, "original") == (1920, 1080)