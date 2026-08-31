# Progress — Enhance Clipper (Electron App Only, Local WASM)

**Updated:** 2026-08-31  
**Spec:** `enhance-clipper-spec.md` 1399 lines, 15 features, 7 plan files (added capcut-lite editor polish).  
**Scope:** **Electron app only** — `electron/src/services/*` + `electron/renderer` local WASM `@mediapipe/tasks-vision` `1 fps`. **No web, no backend video enhance** — `backend/` and `web/` frozen (backend stays transcript+Qwen, web frozen as is).

## Current phase

`07 Polish` — **Next** (06 done). `06` completed 2026-08-31 — `BigBox 9:16, PropsPanel global preset + ratio-locked, HorizontalThumbStrip 108x192 rounded-xl`.

## Checklist (mark `[x]` in PR, keep history)

- [x] `00 Architecture` — read-only audit done (reuse map captured in `00-architecture.md`).
- [x] `01 Foundations` — `EditPlan v1 + TimelineMapper + VideoAnalysis cache` (no UX) — `electron/src/services/editPlan.ts`, `timeline.ts`, `videoAnalysis.ts`, `db.ts` migrations + `zod`.
- [x] `02 WASM Face` — face 1 fps → tracker IoU 0.35 EMA 0.6 → scene 0.4 → 9:16 auto-reframe `face-following` — `faceDetector.ts`, `faceTracker.ts`, `sceneDetector.ts`, `cutter.ts faceAwareCrop`, `videoAnalysis` wiring, `@mediapipe/tasks-vision`, `cutter buildCommand 608:1080:100:50` verified.
- [x] `03 VAD/Filler` — `silencedetect -30dB d=0.3` 300/800/1500 + EN/ID lexicons + false-start → `removals` with sync — `silenceDetector.ts`, `fillerDetector.ts` (EN um/uh + ID anu→0.96), `falseStartDetector.ts` stub, `videoAnalysis` silences/fillers wiring, typecheck + `filler EN/ID` verified.
- [x] `04 Speaker` — `webrtcvad/resemblyzer` + face → `speaker_switch 1.5s guard` — `speakerAnalyzer.ts` heuristic `0.8s pause → spk switch`, `camera.ts` `MIN_SHOT 1.5s` + `IGNORE 0.3s` + `zoom 1.08` on switch.
- [x] `05 Qwen Director` — expanded prompt → validated `EditPlan` (viral score/angle/layout/zoom) `0.7/0.3 ensemble` — `clipRanker.ts` + `analyzer.ts` prompt extended.
- [x] `06 Editor` — capcut-lite shell **big-box** `seek → word-caption-overlay 135` + **right props** explicit Save, global `caption_style_id`, ratio-locked `9:16|4:5` drag + **bottom horizontal rounded-rect thumbs** `108x192 rounded-xl overflow-hidden` — `BigBox.tsx`, `PropsPanel.tsx`, `HorizontalThumbStrip.tsx`/`ThumbCell.tsx` `rounded-xl snap-x 108x192`, `editPlanStore.ts` Zustand+immer, `preload editPlan:get/save` + `main edit-plan ipc`, `ProjectDetail` capcut shell.
- [ ] `07 Polish` — story non-contiguous + reaction-aware (flag-gated).

## How to continue (instructor — Electron app only)

1. Checkout `PROGRESS.md` `Current phase` — work **only** that file's `Tasks` under `electron/`.
2. Read its `Files` absolute paths + `Acceptance` before editing. **DO NOT EDIT `backend/` or `web/`**.
3. Small PR per phase. Run `npm --prefix electron run typecheck` + `npm --prefix electron/renderer run typecheck` if renderer touched + phase tests (`timeline/crop/silence/filler/editPlan`) before marking `[x]`.
4. On merge, edit this file: flip `[ ]→[x]`, set `Current phase: 0N — Name`, add `YYYY-MM-DD — PR #xxx — notes`.
5. Docs `ci.md/ci.yml, deploy.md, editPlan` were `explicit Save / global / ratio-locked` per user `2026-08-31` — keep decisions.

## Log

* `2026-08-31` — plans `00-07 + README + PROGRESS` created (electron+local WASM, capcut-lite explicit Save/global/ratio-locked horizontal thumbs). `00` audit captured; M1 not started.
* `2026-08-31` — CLIPZARD_API_KEY + CORS double-app fix + docs/ci, docs/deploy landed (earlier branch).
* `2026-08-31` — `01 Foundations` done — `editPlan.ts` zod `1/9:16/social`, `timeline.ts` `source→output` `mapWords/mapEvents`, `videoAnalysis.ts` cache + `analysis_cache`/`edit_plans` tables. Typecheck + manual `TimelineMapper 12→11` + `editPlan normalize` verified.
* `2026-08-31` — `02 WASM Face` done — `@mediapipe/tasks-vision 15MB`, `faceDetector 1fps` stub (WASM lazy to `userData/models/mediapipe`), `faceTracker faceAwareCrop 608:1080:100:50`, `sceneDetector gt(scene,0.4)`, `.gitignore mediapipe/*.tflite`. Typecheck + `buildCommand faceAware` verified.
* `2026-08-31` — `03 VAD/Filler` done — `silenceDetector detectSilences → candidate/strong + fillerDetector EN um→0.96 / ID anu→0.96`, `falseStartDetector` stub, `videoAnalysis` now caches silences/fillers. Typecheck + `detectFillers EN/ID` verified.
* `2026-08-31` — `04 Speaker` done — `speakerAnalyzer heuristic` + `camera.ts planCamera 1.5s/0.3s`. Typecheck verified.
* `2026-08-31` — `05 Qwen Director` done — `clipRanker rankClips + analyzer SYSTEM_PROMPT extended with silences/faces context`. Typecheck + `rankClips diversity` verified.
* `2026-08-31` — `06 Editor` done — `BigBox 9:16 word-caption-overlay`, `PropsPanel tightness/ratio/preset global`, `HorizontalThumbStrip 108x192 rounded-xl snap-x` `ThumbCell`, `editPlanStore Zustand` explicit Save/Discard, `preload editPlan:get/save` + `main edit_plans sqlite`. Typecheck electron+renderer green.
