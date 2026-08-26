"""Tests for the robust LLM JSON parser in core.analyzer."""

import json

import pytest

from core.analyzer import analyze, parse_clips, LANGUAGE_NAMES


def test_plain_json_object():
    raw = json.dumps({"clips": [
        {"title": "Hook", "start": 1.5, "end": 45.0},
        {"title": "Payoff", "start": 120, "end": 200},
    ]})
    clips = parse_clips(raw)
    assert len(clips) == 2
    assert clips[0] == {"title": "Hook", "start": 1.5, "end": 45.0}


def test_markdown_fenced_json():
    raw = '```json\n{"clips": [{"title": "A", "start": 0, "end": 20}]}\n```'
    clips = parse_clips(raw)
    assert len(clips) == 1
    assert clips[0]["title"] == "A"


def test_prose_around_json():
    raw = 'Here you go!\n{"clips": [{"title": "Best", "start": 5, "end": 35}]}\nHope that helps.'
    clips = parse_clips(raw)
    assert len(clips) == 1
    assert clips[0]["start"] == 5.0


def test_bare_array():
    raw = '[{"title": "X", "start": 10, "end": 30}]'
    clips = parse_clips(raw)
    assert len(clips) == 1


def test_object_without_clips_wrapper():
    raw = '{"title": "Solo", "start": 2, "end": 40}'
    clips = parse_clips(raw)
    assert len(clips) == 1
    assert clips[0]["title"] == "Solo"


def test_malformed_json_returns_empty():
    assert parse_clips("not json at all") == []
    assert parse_clips("") == []


def test_deduplicates():
    raw = json.dumps({"clips": [
        {"title": "Same", "start": 1, "end": 5},
        {"title": "Same", "start": 1, "end": 5},
    ]})
    assert len(parse_clips(raw)) == 1


def test_invalid_ranges_dropped():
    raw = json.dumps({"clips": [
        {"title": "BadOrder", "start": 50, "end": 10},
        {"title": "Negative", "start": -5, "end": 10},
        {"title": "BadTypes", "start": "abc", "end": "def"},
        {"title": "Good", "start": 1, "end": 30},
    ]})
    clips = parse_clips(raw)
    assert len(clips) == 1
    assert clips[0]["title"] == "Good"


def test_missing_start_or_end_dropped():
    raw = json.dumps({"clips": [
        {"title": "NoEnd"},
        {"start": 1, "end": 10},
    ]})
    assert parse_clips(raw) == []


def test_rounds_to_two_decimals():
    raw = '[{"title": "Precision", "start": 1.2345, "end": 30.6789}]'
    clips = parse_clips(raw)
    assert clips[0]["start"] == 1.23
    assert clips[0]["end"] == 30.68


def test_keeps_viral_hook():
    raw = '[{"title": "Hook", "hook": "You won\'t believe this", "start": 1, "end": 30}]'
    clips = parse_clips(raw)
    assert clips[0]["hook"] == "You won't believe this"


def test_missing_hook_is_omitted():
    raw = '[{"title": "NoHook", "start": 1, "end": 30}]'
    clips = parse_clips(raw)
    assert "hook" not in clips[0]


@pytest.mark.parametrize("bad", ["null", "42", '"just a string"', "[1, 2, 3]"])
def test_non_object_responses(bad):
    assert parse_clips(bad) == []


# ------------------------------------------------------- duration range clamp


def test_clamps_too_long_clip_to_max():
    raw = '[{"title": "Long", "start": 10, "end": 80}]'
    clips = parse_clips(raw, min_duration=20, max_duration=30)
    assert clips[0]["start"] == 10.0
    assert clips[0]["end"] == 40.0


def test_clamps_too_short_clip_to_min():
    raw = '[{"title": "Short", "start": 100, "end": 105}]'
    clips = parse_clips(raw, min_duration=20, max_duration=30)
    assert clips[0]["start"] == 100.0
    assert clips[0]["end"] == 120.0


def test_keeps_clip_inside_range_untouched():
    raw = '[{"title": "Fit", "start": 5, "end": 27.5}]'
    clips = parse_clips(raw, min_duration=20, max_duration=30)
    assert clips[0] == {"title": "Fit", "start": 5.0, "end": 27.5}


def test_swapped_range_bounds_are_normalised():
    raw = '[{"title": "X", "start": 0, "end": 60}]'
    clips = parse_clips(raw, min_duration=30, max_duration=20)
    # Bounds are normalised to [20, 30]; a 60s clip clamps to the max.
    assert clips[0]["end"] == 30.0


# ------------------------------------------------------------ duration prompt


def test_analyze_injects_duration_range_into_prompt(monkeypatch):
    calls = []
    _install_fake_openai(monkeypatch, calls)

    analyze("some transcript text", "fake-key", min_duration=20, max_duration=30)

    system_content = calls[0]["messages"][0]["content"]
    assert "between 20 and 30 seconds" in system_content
    assert "15 and 90" not in system_content


def test_analyze_clamps_out_of_range_response(monkeypatch):
    class _RangeCompletions:
        def create(self, **kwargs):
            return _FakeCompletion(
                '{"clips": [{"title": "Big", "start": 3, "end": 48}]}'
            )

    class _RangeChat:
        def __init__(self):
            self.completions = _RangeCompletions()

    class _RangeOpenAI:
        def __init__(self, *args, **kwargs):
            self.chat = _RangeChat()

    import openai

    monkeypatch.setattr(openai, "OpenAI", _RangeOpenAI)

    clips = analyze("t", "fake-key", min_duration=20, max_duration=30)
    assert clips[0]["end"] - clips[0]["start"] == 30.0


# ------------------------------------------------------------ language hint


class _FakeMessage:
    def __init__(self, content):
        self.content = content


class _FakeChoice:
    def __init__(self, content):
        self.message = _FakeMessage(content)


class _FakeCompletion:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, capture):
        self._capture = capture

    def create(self, **kwargs):
        self._capture.append(kwargs)
        return _FakeCompletion(
            '{"clips": [{"title": "Judul", "hook": "Ini hook", "start": 1, "end": 20}]}'
        )


class _FakeChat:
    def __init__(self, capture):
        self.completions = _FakeCompletions(capture)


def _install_fake_openai(monkeypatch, capture):
    """Patch the `openai` module's OpenAI class (resolved via the local
    `from openai import OpenAI` import inside analyzer.analyze)."""
    import openai

    class _FakeOpenAI:
        def __init__(self, *args, **kwargs):
            self.chat = _FakeChat(capture)

    monkeypatch.setattr(openai, "OpenAI", _FakeOpenAI)


def test_analyze_injects_language_hint(monkeypatch):
    calls = []
    _install_fake_openai(monkeypatch, calls)

    clips = analyze("some transcript text", "fake-key", language="id")

    assert len(clips) == 1
    assert clips[0]["title"] == "Judul"
    system_content = calls[0]["messages"][0]["content"]
    assert "Indonesian" in system_content
    assert "id" in system_content


def test_analyze_no_language_hint_omits_instruction(monkeypatch):
    calls = []
    _install_fake_openai(monkeypatch, calls)

    analyze("some transcript text", "fake-key")

    system_content = calls[0]["messages"][0]["content"]
    assert "Language hint" not in system_content


def test_analyze_unknown_language_code_falls_back_to_raw_code(monkeypatch):
    calls = []
    _install_fake_openai(monkeypatch, calls)

    analyze("some transcript text", "fake-key", language="xx")

    system_content = calls[0]["messages"][0]["content"]
    assert "xx" in system_content


def test_language_names_table_has_indonesian():
    assert LANGUAGE_NAMES["id"] == "Indonesian (Bahasa Indonesia)"


# ------------------------------------------------- long-video chunking


def _make_words(seconds=300, words_per_second=2):
    """A synthetic word timeline spanning ``seconds`` seconds."""
    words = []
    for i in range(seconds * words_per_second):
        start_ms = int(i * 1000 / words_per_second)
        end_ms = start_ms + int(1000 / words_per_second) - 1
        words.append({"text": f"w{i}", "start_ms": start_ms, "end_ms": end_ms})
    return words


def test_format_timestamped_words_groups_into_blocks():
    from core.analyzer import format_timestamped_words

    words = [
        {"text": "hello", "start_ms": 0, "end_ms": 500},
        {"text": "world", "start_ms": 500, "end_ms": 1000},
    ]
    lines = format_timestamped_words(words, block_seconds=30)
    assert lines == ["[0s-1s] hello world"]


def test_format_timestamped_words_splits_long_timeline():
    from core.analyzer import format_timestamped_words

    lines = format_timestamped_words(_make_words(seconds=90), block_seconds=30)
    assert len(lines) == 3
    assert lines[0].startswith("[0s-")
    # Last block covers the tail of the timeline.
    assert "89s]" in lines[2]
    assert "w179" in lines[2]


def test_chunk_lines_packs_within_budget():
    from core.analyzer import chunk_lines

    lines = [f"[{i * 30}s-{i * 30 + 30}s] {'x' * 80}" for i in range(10)]
    chunks = chunk_lines(lines, max_chars=400)  # ~4 lines per chunk
    assert len(chunks) == 3
    for chunk in chunks:
        assert len(chunk) <= 400
    # No lines lost.
    assert sum(c.count("[") for c in chunks) == 10


def test_merge_clips_drops_overlapping_duplicates():
    from core.analyzer import merge_clips

    clips = [
        {"title": "B", "start": 100.0, "end": 130.0},
        {"title": "A", "start": 10.0, "end": 40.0},
        {"title": "dup", "start": 110.0, "end": 140.0},  # overlaps B heavily
        {"title": "far", "start": 500.0, "end": 530.0},  # disjoint, kept
    ]
    merged = merge_clips(clips)
    assert [c["title"] for c in merged] == ["A", "B", "far"]


def test_analyze_with_words_chunks_long_transcript(monkeypatch):
    calls = []

    class _PerChunkCompletions:
        def create(self, **kwargs):
            # Distinct, non-overlapping clip per chunk (30s at the chunk's
            # own start region) so merge keeps all of them.
            idx = len(calls)
            calls.append(kwargs)
            start = 120 * idx
            return _FakeCompletion(
                json.dumps(
                    {"clips": [{"title": f"C{idx}", "start": start, "end": start + 60}]}
                )
            )

    class _PerChunkChat:
        def __init__(self):
            self.completions = _PerChunkCompletions()

    class _PerChunkOpenAI:
        def __init__(self, *args, **kwargs):
            self.chat = _PerChunkChat()

    import openai

    monkeypatch.setattr(openai, "OpenAI", _PerChunkOpenAI)

    # Tiny chunk budget → several requests over a 5-minute timeline.
    monkeypatch.setenv("LLM_CHUNK_CHARS", "1500")
    progresses = []
    clips = analyze(
        "irrelevant",
        "fake-key",
        min_duration=15,
        max_duration=90,
        words=_make_words(seconds=300),
        progress=progresses.append,
    )

    assert len(calls) > 1
    # Early chunks carry the video's opening; later chunks its tail.
    assert any("[0s-" in c["messages"][1]["content"] for c in calls)
    import re

    max_label = max(
        int(m)
        for c in calls
        for m in re.findall(r"\[(\d+)s-", c["messages"][1]["content"])
    )
    assert max_label > 200
    # Progress fired once per chunk.
    assert len(progresses) == len(calls)
    assert progresses[-1] == 1.0
    # One kept clip per chunk.
    assert len(clips) == len(calls)


def test_analyze_with_words_survives_one_failed_chunk(monkeypatch):
    import openai

    calls = []

    class _FlakyCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise openai.APIConnectionError(request=None)
            return _FakeCompletion(
                '{"clips": [{"title": "C1", "start": 30, "end": 60}]}'
            )

    class _FlakyChat:
        def __init__(self):
            self.completions = _FlakyCompletions()

    class _FlakyOpenAI:
        def __init__(self, *args, **kwargs):
            self.chat = _FlakyChat()

    monkeypatch.setattr(openai, "OpenAI", _FlakyOpenAI)
    monkeypatch.setenv("LLM_CHUNK_CHARS", "1500")

    clips = analyze(
        "irrelevant",
        "fake-key",
        min_duration=15,
        max_duration=90,
        words=_make_words(seconds=180),
    )

    assert len(calls) >= 2
    assert clips and clips[0]["title"] == "C1"


def test_analyze_single_chunk_still_raises_on_failure(monkeypatch):
    import openai
    from core.analyzer import AnalysisError

    class _DeadCompletions:
        def create(self, **kwargs):
            raise openai.APIConnectionError(request=None)

    class _DeadChat:
        def __init__(self):
            self.completions = _DeadCompletions()

    class _DeadOpenAI:
        def __init__(self, *args, **kwargs):
            self.chat = _DeadChat()

    monkeypatch.setattr(openai, "OpenAI", _DeadOpenAI)

    with pytest.raises(AnalysisError):
        analyze("some transcript text", "fake-key")
