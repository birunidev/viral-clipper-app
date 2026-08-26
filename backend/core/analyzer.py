"""OpenAI-compatible LLM analysis wrapper.

Sends a transcript to any OpenAI-compatible endpoint (OpenAI, Groq,
Ollama, OpenRouter free tiers, etc.) and parses the returned JSON into
structured clip objects.

Long-video strategy (map-reduce): raw transcripts easily exceed what
small/free models can ingest in one request, and a single huge prompt is
exactly where cheap providers stall or time out. Instead, the word-level
timeline is grouped into ~30s timestamped blocks ([12s-41s] ...), those
blocks are packed into chunks under ``LLM_CHUNK_CHARS`` characters, each
chunk gets its own small completion call, and the per-chunk clip lists
are merged and de-duplicated at the end. A flaky chunk only costs its own
moments — the job survives as long as any chunk yields clips.

The timestamp labels matter beyond chunking: they let even a weak model
anchor clip boundaries to real seconds instead of guessing from text
position.
"""

from __future__ import annotations

import json
import os
import re

SYSTEM_PROMPT = """You are a short-form video analyst. Read this portion of a video
transcript and identify the most viral-worthy moments that would perform well as short
vertical clips (TikTok, Reels, Shorts). For each clip provide a catchy title, a short
one-line viral hook caption, and the start/end timestamps in seconds measured from the
beginning of the source video. Return ONLY a JSON object matching this exact schema and
nothing else:

{"clips": [{"title": "string", "hook": "string", "start": 12.5, "end": 38.0}]}

Rules:
- Transcript lines are prefixed with their [startS-endS] second offsets into the FULL
  video. Use those markers: clip start/end must fall inside the offsets of the lines
  you picked from.
- IMPORTANT: write the title and hook in the SAME language as the transcript. Match
  the language of the transcript and the declared language hint. For example, if the
  transcript is in Bahasa Indonesia, write all titles and hooks in Indonesian.
- The language hint will be provided separately; follow it when given.
- hook is a punchy attention-grabbing line (max ~15 words), separate from the title.
- start and end must be numbers in seconds.
- end must be strictly greater than start.
- Clip length should be between {min_duration} and {max_duration} seconds. This
  range is a hard requirement from the user, not a suggestion.
- Return between 1 and 8 clips from THIS portion. Prefer moments with strong hooks,
  emotion, or payoff. If nothing here is compelling, return {"clips": []}.
"""

JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)
FENCE_RE = re.compile(r"```(?:json)?\s*", re.IGNORECASE)

# Size of one timestamped block and one LLM request payload. Both small so
# free-tier models (short contexts, aggressive queues) can handle them.
BLOCK_SECONDS = 30
DEFAULT_CHUNK_CHARS = 9000


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


def format_timestamped_words(
    words: list[dict], block_seconds: int = BLOCK_SECONDS
) -> list[str]:
    """Group word timings into ``[startS-endS] text`` lines of ~block_seconds."""
    lines: list[str] = []
    block_start: float | None = None
    block_end = 0.0
    buf: list[str] = []
    for w in words:
        try:
            start_ms = float(w["start_ms"])
            end_ms = float(w["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        text = str(w.get("text", "")).strip()
        if not text:
            continue
        s, e = start_ms / 1000.0, max(start_ms / 1000.0, end_ms / 1000.0)
        if block_start is None:
            block_start = s
        buf.append(text)
        block_end = e
        if block_end - block_start >= block_seconds:
            lines.append(f"[{int(block_start)}s-{int(block_end)}s] {' '.join(buf)}")
            buf, block_start = [], None
    if buf:
        lines.append(f"[{int(block_start or 0)}s-{int(block_end)}s] {' '.join(buf)}")
    return lines


def chunk_lines(lines: list[str], max_chars: int) -> list[str]:
    """Pack whole lines into chunks of at most ~max_chars characters."""
    chunks: list[str] = []
    cur: list[str] = []
    size = 0
    for line in lines:
        if cur and size + len(line) + 1 > max_chars:
            chunks.append("\n".join(cur))
            cur, size = [], 0
        cur.append(line)
        size += len(line) + 1
    if cur:
        chunks.append("\n".join(cur))
    return chunks


def merge_clips(clips: list[dict]) -> list[dict]:
    """Sort by start time and drop clips that heavily overlap an earlier one
    (same moment found by adjacent chunks)."""
    ordered = sorted(clips, key=lambda c: c["start"])
    result: list[dict] = []
    for clip in ordered:
        dup = False
        for kept in result:
            inter = min(kept["end"], clip["end"]) - max(kept["start"], clip["start"])
            shorter = min(kept["end"] - kept["start"], clip["end"] - clip["start"])
            if shorter > 0 and inter / shorter > 0.5:
                dup = True
                break
        if not dup:
            result.append(clip)
    return result


def analyze(
    transcript: str,
    api_key: str,
    base_url: str = "https://api.openai.com/v1",
    model: str = "gpt-4o-mini",
    language: str | None = None,
    min_duration: int = 15,
    max_duration: int = 90,
    words: list[dict] | None = None,
    progress=None,
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

    ``words`` (optional) is the word-level timeline
    (``[{"text", "start_ms", "end_ms"}, ...]``). When given, the transcript
    is rendered with absolute-second markers and split into small chunks so
    long videos work on short-context / free-tier models; each chunk is
    analysed separately and the results merged. Without ``words`` the plain
    text is sent in a single (truncated) request.

    ``progress`` (optional) receives floats in [0, 1] as chunk calls finish.

    Each clip is a dict with keys ``title``, ``start``, ``end``. Raises
    AnalysisError if no chunk yields usable clips.
    """
    if not transcript.strip() and not words:
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

    # Hard timeout so a slow/queued provider (free tiers routinely stall on
    # large prompts) fails the call instead of blocking for the SDK's
    # 10-minute default x retries. Env-tunable for slower local models.
    try:
        timeout = float(os.environ.get("LLM_TIMEOUT", "180"))
    except ValueError:
        timeout = 180.0
    client = OpenAI(base_url=base_url or None, api_key=api_key, timeout=timeout, max_retries=2)

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

    # Build the request payloads: small timestamped chunks when we have the
    # word timeline, one truncated plain-text request otherwise.
    try:
        chunk_chars = int(os.environ.get("LLM_CHUNK_CHARS", str(DEFAULT_CHUNK_CHARS)))
    except ValueError:
        chunk_chars = DEFAULT_CHUNK_CHARS
    if words:
        payloads = chunk_lines(format_timestamped_words(words), chunk_chars) or [""]
    else:
        payloads = [transcript[:20000]]

    collected: list[dict] = []
    total = max(len(payloads), 1)
    for i, payload in enumerate(payloads):
        try:
            collected.extend(
                _analyze_chunk(
                    client,
                    system_prompt,
                    payload,
                    model,
                    min_duration=min_duration,
                    max_duration=max_duration,
                )
            )
        except (APIError, APIConnectionError, APITimeoutError) as exc:
            # One dead chunk shouldn't kill hours of transcription on a long
            # video — but a single-chunk analysis has nothing to fall back
            # to, so surface the error there.
            if len(payloads) == 1:
                raise AnalysisError(f"LLM request failed: {exc}") from exc
        if progress is not None:
            progress((i + 1) / total)

    merged = merge_clips(collected)
    if not merged:
        raise AnalysisError("The model returned no usable clip timestamps.")

    return merged


def _analyze_chunk(
    client,
    system_prompt: str,
    transcript_chunk: str,
    model: str,
    min_duration: int,
    max_duration: int,
) -> list[dict]:
    """One LLM call over one transcript chunk → parsed clips."""
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": transcript_chunk[:20000]},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
        )
    except Exception as exc:
        # Normalize SDK/network errors so callers can treat all provider
        # failures uniformly (callers catch APIError family + this).
        from openai import APIError

        if isinstance(exc, APIError):
            raise
        raise AnalysisError(f"LLM request failed: {exc}") from exc

    raw = (response.choices[0].message.content or "").strip()
    return parse_clips(raw, min_duration=min_duration, max_duration=max_duration)


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
