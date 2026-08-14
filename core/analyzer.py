"""OpenAI-compatible LLM analysis wrapper.

Sends a transcript to any OpenAI-compatible endpoint (OpenAI, Groq,
Ollama, etc.) and parses the returned JSON into structured clip objects.
"""

from __future__ import annotations

import json
import re

SYSTEM_PROMPT = """You are a short-form video analyst. Read the transcript and identify the most
viral-worthy moments that would perform well as short vertical clips (TikTok, Reels,
Shorts). For each clip provide a catchy title and the start/end timestamps in seconds,
measured from the beginning of the source video. Return ONLY a JSON object matching this
exact schema and nothing else:

{"clips": [{"title": "string", "start": 12.5, "end": 38.0}]}

Rules:
- start and end must be numbers in seconds.
- end must be strictly greater than start.
- Clip length should be between 15 and 90 seconds.
- Return between 3 and 8 clips. Prefer moments with strong hooks, emotion, or payoff.
"""

JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)
FENCE_RE = re.compile(r"```(?:json)?\s*", re.IGNORECASE)


class AnalysisError(Exception):
    """Raised when the LLM response cannot be parsed into clips."""


def analyze(
    transcript: str,
    api_key: str,
    base_url: str = "https://api.openai.com/v1",
    model: str = "gpt-4o-mini",
) -> list[dict]:
    """Send the transcript to the configured LLM and return a list of clips.

    Each clip is a dict with keys ``title``, ``start``, ``end``. Raises
    AnalysisError if the model output cannot be parsed.
    """
    if not transcript.strip():
        raise AnalysisError("Transcript is empty; nothing to analyze.")
    if not api_key:
        raise AnalysisError("LLM API key is required.")

    try:
        from openai import OpenAI
        from openai import APIError, APIConnectionError, APITimeoutError
    except ImportError as exc:  # pragma: no cover - defensive
        raise AnalysisError(
            "openai package is not installed. Run: poetry install"
        ) from exc

    client = OpenAI(base_url=base_url or None, api_key=api_key)

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": transcript[:20000]},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
        )
    except (APIError, APIConnectionError, APITimeoutError) as exc:
        raise AnalysisError(f"LLM request failed: {exc}") from exc

    raw = (response.choices[0].message.content or "").strip()
    clips = parse_clips(raw)

    if not clips:
        raise AnalysisError("The model returned no usable clip timestamps.")

    return clips


def parse_clips(raw: str) -> list[dict]:
    """Robustly parse a JSON response from the LLM into a list of clips.

    Handles markdown fenced blocks (```json ... ```), surrounding prose,
    responses shaped as {"clips": [...]}, bare arrays, and objects missing
    the "clips" wrapper.
    """
    if not raw:
        return []

    text = FENCE_RE.sub("", raw).strip()

    candidates = []

    object_match = JSON_OBJECT_RE.search(text)
    if object_match:
        candidates.append(object_match.group(0))

    array_match = JSON_ARRAY_RE.search(text)
    if array_match:
        candidates.append(array_match.group(0))

    clips = []
    seen = set()

    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        if isinstance(data, dict):
            if isinstance(data.get("clips"), list):
                data = data["clips"]
            else:
                data = [data]
        if not isinstance(data, list):
            continue

        for item in data:
            if not isinstance(item, dict):
                continue
            clip = _coerce_clip(item)
            if clip and _clip_key(clip) not in seen:
                seen.add(_clip_key(clip))
                clips.append(clip)

    return clips


def _coerce_clip(item: dict) -> dict | None:
    title = str(item.get("title", "")).strip()
    if not title:
        return None
    try:
        start = float(item.get("start"))
        end = float(item.get("end"))
    except (TypeError, ValueError):
        return None

    if not (end > start >= 0):
        return None

    if start > 100000 or end > 100000:
        return None

    return {"title": title, "start": round(start, 2), "end": round(end, 2)}


def _clip_key(clip: dict) -> tuple:
    return clip["title"], clip["start"], clip["end"]
