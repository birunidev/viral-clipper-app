"""Tests for the FFmpeg command builder in core.cutter."""

import pytest

from core.cutter import (
    build_command,
    crop_filter_for,
    slugify,
    verify_ffmpeg,
    LANDSCAPE,
    ORIGINAL,
    PORTRAIT,
)


def test_basic_command_structure():
    cmd = build_command("/vids/src.mp4", 12.5, 45.0, "Best Moment", "/out", 1)
    assert cmd[0] == "ffmpeg"
    assert cmd[-1] == "/out/best-moment_01.mp4"
    assert cmd[cmd.index("-ss") + 1] == "12.50"
    assert cmd[cmd.index("-t") + 1] == "32.50"
    assert cmd[cmd.index("-i") + 1] == "/vids/src.mp4"


def test_start_zero():
    cmd = build_command("src.mp4", 0, 30, "Intro", "out", 1)
    assert cmd[cmd.index("-ss") + 1] == "0.00"
    assert cmd[cmd.index("-t") + 1] == "30.00"


def test_long_duration_clip():
    cmd = build_command("src.mp4", 600.0, 900.0, "Hour One", "out", 3)
    assert cmd[cmd.index("-t") + 1] == "300.00"
    assert cmd[-1] == "out/hour-one_03.mp4"


def test_portrait_source_still_has_crop_filter():
    cmd = build_command("portrait.mp4", 0, 20, "P", "out", 1)
    filter_index = cmd.index("-vf")
    assert "9/16" in cmd[filter_index + 1]
    assert "min(iw\\,ih*9/16)" in cmd[filter_index + 1]


def test_landscape_crop_filter():
    cmd = build_command("clip.mp4", 0, 20, "L", "out", 1, orientation=LANDSCAPE)
    filter_index = cmd.index("-vf")
    assert "min(ih\\,iw*9/16)" in cmd[filter_index + 1]


def test_original_has_no_crop_filter():
    cmd = build_command("clip.mp4", 0, 20, "O", "out", 1, orientation=ORIGINAL)
    assert "-vf" not in cmd


def test_default_orientation_is_portrait():
    cmd = build_command("clip.mp4", 0, 20, "D", "out", 1)
    assert cmd[cmd.index("-vf") + 1] == crop_filter_for(PORTRAIT)


def test_unknown_orientation_raises():
    from core.cutter import CutterError

    with pytest.raises(CutterError):
        build_command("clip.mp4", 0, 20, "X", "out", 1, orientation="diagonal")


def test_output_extension_is_mp4():
    cmd = build_command("clip.mov", 5, 25, "Convert Me", "out", 7)
    assert cmd[-1].endswith(".mp4")


def test_slugify():
    assert slugify("Best Moment!! of the Show") == "best-moment-of-the-show"
    assert slugify("---") == "clip"
    assert slugify("Already-Kebab") == "already-kebab"
    assert slugify("  spaces  ") == "spaces"


def test_verify_ffmpeg_on_host():
    path = verify_ffmpeg()
    assert path
    assert "ffmpeg" in path.lower()
