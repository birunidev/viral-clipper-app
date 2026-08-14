"""Tests for the robust LLM JSON parser in core.analyzer."""

import json

import pytest

from core.analyzer import parse_clips


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


@pytest.mark.parametrize("bad", ["null", "42", '"just a string"', "[1, 2, 3]"])
def test_non_object_responses(bad):
    assert parse_clips(bad) == []
