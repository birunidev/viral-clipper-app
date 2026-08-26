"""OpenAI-compatible LLM analysis wrapper.

Sends a transcript to any OpenAI-compatible endpoint (OpenAI, Groq,
Ollama, etc.) and parses the returned JSON into structured clip objects.
"""

from __future__ import annotations

import json
import re

SYSTEM_PROMPT = """You are a short-form video analyst. Read the transcript and identify the most
viral-worthy moments that would perform well as short vertical clips (TikTok, Reels,
Shorts). For each clip provide a catchy title, a short one-line viral hook caption,
and the start/end timestamps in seconds measured from the beginning of the source
video. Return ONLY a JSON object matching this exact schema and nothing else:

{"clips": [{"title": "string", "hook": "string", "start": 12.5, "end": 38.0}]}

Rules:
- IMPORTANT: write the title and hook in the SAME language as the transcript. Match
  the language of the transcript and the declared language hint. For example, if the
  transcript is in Bahasa Indonesia, write all titles and hooks in Indonesian.
- The language hint will be provided separately; follow it when given.
- hook is a punchy attention-grabbing line (max ~15 words), separate from the title.
- start and end must be numbers in seconds.
- end must be strictly greater than start.
- Clip length should be between {min_duration} and {max_duration} seconds. This
  range is a hard requirement from the user, not a suggestion.
- Return between 3 and 8 clips. Prefer moments with strong hooks, emotion, or payoff.
"""

JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)
FENCE_RE = re.compile(r"```(?:json)?\s*", re.IGNORECASE)


class AnalysisError(Exception):
    """Raised when the LLM response cannot be parsed into clips."""


# ISO 639-1 -> readable name for a handful of common languages, used to make
# the language hint unambiguous for the LLM. Falls back to the raw code
# for anything not in this table (still a useful hint on its own).
LANGUAGE_NAMES = {
    "en": "English",
    "id": "Indonesian (Bahasa Indonesia)",
    "es": "Spanish",
    "pt": "Portuguese",
    "fr": "French",
    "de": "German",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "hi": "Hindi",
    "ar": "Arabic",
    "vi": "Vietnamese",
    "th": "Thai",
    "tr": "Turkish",
    "ru": "Russian",
    "it": "Italian",
    "nl": "Dutch",
    "ms": "Malay",
    "tl": "Filipino (Tagalog)",
}


def analyze(
    transcript: str,
    api_key: str,
    base_url: str = "https://api.openai.com/v1",
    model: str = "gpt-4o-mini",
    language: str | None = None,
    min_duration: int = 15,
    max_duration: int = 90,
) -> list[dict]:
    """Send the transcript to the configured LLM and return a list of clips.

    ``language`` (optional) is an ISO 639-1 code (e.g. "id") identifying the
    transcript's spoken language — typically detected from the source
    video's metadata or the transcription provider's response. When given,
    it's passed to the model as an explicit instruction so titles/hooks are
    written in that language instead of defaulting to English.

    ``min_duration``/``max_duration`` (seconds) are the user's requested clip
    length range. They're injected into the system prompt as a hard
    requirement, and any returned clip outside the range is clamped to the
    nearest bound.

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

    if min_duration > max_duration:
        min_duration, max_duration = max_duration, min_duration

    system_prompt = SYSTEM_PROMPT.replace(
        "{min_duration}", str(min_duration)
    ).replace("{max_duration}", str(max_duration))
    if language:
        name = LANGUAGE_NAMES.get(language.lower(), language)
        system_prompt += (
            f"\nLanguage hint: the transcript is in {name} (code: {language}). "
            f"Write every title and hook in {name}, not English."
        )

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": transcript[:20000]},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
        )
    except (APIError, APIConnectionError, APITimeoutError) as exc:
        raise AnalysisError(f"LLM request failed: {exc}") from exc

    raw = (response.choices[0].message.content or "").strip()
    clips = parse_clips(raw, min_duration=min_duration, max_duration=max_duration)

    if not clips:
        raise AnalysisError("The model returned no usable clip timestamps.")

    return clips


def parse_clips(
    raw: str,
    min_duration: int = 15,
    max_duration: int = 90,
) -> list[dict]:
    """Robustly parse a JSON response from the LLM into a list of clips.

    Handles markdown fenced blocks (```json ... ```), surrounding prose,
    responses shaped as {"clips": [...]}, bare arrays, and objects missing
    the "clips" wrapper. Clips whose length falls outside
    [min_duration, max_duration] are clamped to the nearest bound.
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
            clip = _coerce_clip(
                item, min_duration=min_duration, max_duration=max_duration
            )
            if clip and _clip_key(clip) not in seen:
                seen.add(_clip_key(clip))
                clips.append(clip)

    return clips


def _coerce_clip(
    item: dict,
    min_duration: int = 15,
    max_duration: int = 90,
) -> dict | None:
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

    if min_duration > max_duration:
        min_duration, max_duration = max_duration, min_duration

    # Clamp the clip length into the user's requested range. The prompt
    # already asks the model to respect it; this enforces it even when the
    # model drifts (e.g. returns a 45s clip for a 20-30s request).
    duration = end - start
    if duration > max_duration:
        end = start + float(max_duration)
    elif duration < min_duration:
        end = start + float(min_duration)

    if start > 100000 or end > 100000:
        return None

    clip = {"title": title, "start": round(start, 2), "end": round(end, 2)}
    hook = str(item.get("hook", "")).strip()
    if hook:
        clip["hook"] = hook
    return clip


def _clip_key(clip: dict) -> tuple:
    return clip["title"], clip["start"], clip["end"]
