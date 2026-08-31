# 07 — Polish: Story Non-contiguous + Reaction-aware (flag-gated)

**Goal:** Explore differentiation after core `JSON→preview→render` is reliable (spec Milestone 6). Keep optional flags so Phase 1-6 clip `start_time/end_time` contiguous fallback still produces usable output when polish fails.

## Features (spec F12, F15)

* **Story reconstruction:** allow Qwen to stitch `Hook 08:21 + Conflict 12:42 + Insight 17:05 + Payoff 23:18` non-contiguous moments **only when** `semantically consistent + pronouns still make sense + truthful + speaker meaning preserved, never fabricate continuity`. `EditPlan` already supports `segments[]` concat; renderer `renderer.ts:98 concat via Output add timestamp+offset` (no intermediate encode) + ffmpeg `concat demuxer` + `TimelineMapper` keeps captions/camera synced across joins.
* **Reaction-aware:** `Speaker A "I lost our entire budget."` → hold B surprised face `0.8s` → back to A. Needs `silence/filler` + `faceTracker size/position` + `speaker timestamps` overlap → `layout: split/pip` behind `enableReaction:true` flag.

## Qwen as director (spec Qwen role)

* Inputs already include `{silences,fillers,faces,scenes}`; polish just adds `story:true` flag to prompt → outputs `visual_events[{type:speaker_switch/react}]` + `layout choices`. Deterministic fallback `speaker_focus` when confidence low.

## Files

* `electron/src/services/{storyBuilder,reactionDetector}.ts` **new**, `clipRanker.ts: diversity` already dedup `inter/shorter >0.5`.
* `electron/src/services/editPlan.ts` `story: boolean` optional flag, `electron/renderer` preview adds `reaction` highlight. **No web.**

## Tasks

- [ ] Guard polish behind `editPlan.output.story / reaction` booleans (default off), `cutter.ts:44` concat tested `total_removed` loop.
- [ ] Tests `non-contiguous remap 08:21→12:42 keeps captions`, `reaction shot inserted only when face confidence>0.85`.

## Acceptance

* `story off` → single `segment[source_start,source_end]` as before; `story on` → 2-4 segments concatenated file playable `1080x1920` `crf20`.
* No `chain-of-thought` exposed — only `reason_codes` + `angle` (`Global design quality`).

## Exit

Mark `PROGRESS.md 07 [x]` — product now `AI clip finder → AI short-form editor` (capcut-lite, not full NLE). Next: A/B `tightness` presets with real creators.

## Instructor

Keep small changes, typed structures, cacheable analysis (spec Development Rules). Do not introduce cloud LLM requirement — local `qwen2.5-7b` remains first-class (`electron/src/services/system.ts:43`). Electron app only.
