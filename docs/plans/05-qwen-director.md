# 05 — Qwen 2.5 7B Director (local `node-llama-cpp`, deterministic defaults)

**Goal:** Viral `clip ranking / angles / story / layout / zoom` without replacing deterministic engines. Extends `analyzer.ts:341 analyzeLocal` via `LlamaChatSession`.

## Qwen as decision engine (spec split)

* **Inputs** (structured, no frames): `{transcript[ startS-endS], speakers[], silences[], faces[], scenes[], candidate_clips[], editing_style:social, tightness}` — expanded from `analyzer.ts:19` prompt `[startS-endS] 1-8 clips/chunk` to spec expanded prompt.
* **Responsibilities (Qwen):** `viral ranking / false-start / ambiguous filler / intentional pause / editorial angle{class} / story selection / layout / punch-in` (spec Qwen role).
* **Not Qwen:** `face box / per-frame track / audio decode / crop execute / ffmpeg encode`.
* **Structured output** `response_format:json_object` `temperature 0.4 maxTokens 1024` at `analyzer.ts:373` → `editPlan` patches `{angle:contrarian, score:92, reason_codes:[strong_hook,clear_payoff,standalone_context], editing{tightness:"social",preferred_layout:"speaker_focus"}}` with `zod` retry/repair/fallback `original clip boundaries`.

## Files

* **Modify** `electron/src/services/analyzer.ts:19,86,341` expand `SYSTEM_PROMPT` `9k chunk → JSON` to accept `faces/speakers/silences` metadata, output validated `EditPlan` partial `layout/camera/zoom/angle`. Keep `formatTimestampedWords 30s 93 + chunkLines 123`.
* **New** `electron/src/services/clipRanker.ts` `score/angle/reason_codes/diversity` `max 1/angle` + `story non-contiguous Hook 08:21 + Payoff 23:18 → single short` (optional flag, needs `TimelineMapper` concat, never fabricate continuity — spec F12).
* **Modify** `electron/src/services/scorer.ts:82 findBestMoments` kept as fallback when Qwen `parse fail` → `original boundaries`.
* **Modify** `electron/src/worker/jobRunner.ts:404 ensembleScore(0.7/0.3)` extend to `editPlan.capped` `videoDurationSec` clamp (existing `cappedLlm 382`).

## Viral selection upgrade (F10-11)

* Adds `hook strength / standalone / payoff / novelty / emotional / practical value` checks (spec F10) — good short makes sense without full source.
* `angles[ educational, contrarian, story…]` diversity vs `5 identical clips`.

## Tasks

- [ ] Expand `analyzer.ts` prompt + `EditPlan` JSON schema + `retry 2x` + `repair` strip `FENCE_RE 138`.
- [ ] `clipRanker.ts` diversity `inter/shorter >0.5` already in `mergeClips:139` — extend to angle dedup.
- [ ] Tests `editPlan schema valid/invalid`, `Qwen malformed → fallback`, `angle diversity 92/89/86`.

## Acceptance

* Local `qwen2.5-7b` (4.7GB `electron/src/services/system.ts:43`) or `LLM_TIER balanced 1.5b 950MB` still scores without crash; cloud `LLM_API_KEY` still path `analyzer.ts:303 fetch`.
* Manual: `hook → context → payoff` respected, `intentional pause >800ms` kept when `reason=strong claim`.

## Exit

`PROGRESS.md 05 [x]` → `06`. No web/backend changes — web stays transcript-only.

## Instructor

Next: `06-editor.md`. Qwen never writes `ffmpeg -ss` — renderer consumes validated `EditPlan` only.
