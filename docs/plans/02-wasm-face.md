# 02 — WASM Face → Tracker → Scene → 9:16 Auto-Reframe (smooth)

**Goal:** `podcast → face-following vertical` reliably. WASM `1 fps` (user choice: Plan Option 1) — not 30 fps.

## Why WASM (over native opencv)

* `@mediapipe/tasks-vision` BlazeFace `15 MB` vs `opencv4nodejs 300 MB + cmake` on `windows-latest/macos-14` (`release.yml:38`). No `cap_add` needed (`docker-compose.yml:36` irrelevant for desktop). Throttled `60 min × 1 fps = 3.6k` → cheap; only `10 candidate clips` re-run at `30 fps` high-detail per spec Performance.

## Files

* **New** `electron/src/services/faceDetector.ts` — `ffmpeg -ss <t> -i src -frames:v 1 -q:v 3 thumb` at `1 fps` → `TasksVision FaceDetector(WASM)` from `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision` → normalized `{id:"f1",x:0.22,y:0.14,w:0.2,h:0.39,conf:0.97, timestamp:14.2}` per spec Feature 1 example. Strip `electronscripts/prepare-build.mjs:38` copy `node_modules/@mediapipe/tasks-vision/wasm + blazeface.tflite → resources/models/mediapipe` `extraResources`.
* **New** `electron/src/services/faceTracker.ts` — IoU `>0.35` + `interpolate` linear + `occlusion 0.6s` hold + EMA `α=0.6` smoothing + `camera path {x,y,zoom}`. Reset IDs on scene cut.
* **New** `electron/src/services/sceneDetector.ts` — `ffmpeg lavfi select='gt(scene,0.4)'` parsed from `ffprobe select` stderr or frame diff histogram via WASM; emits `scenes:[{time, confidence}]`.
* **Modify** `electron/src/services/cutter.ts:15` `cropFilterFor` → `crop=w:h:x:y` from tracker (`x = clamp(faceCenterX - outW/2,0,srcW-outW)`, `y = clamp(faceY - 0.35*outH, …)` headroom 7 % → clamp inside source, `zoom 1.00-1.05`). `electron/src/services/captions.ts:102` `cropDimensions` already round-aware. `electron/src/worker/jobRunner.ts:142` wire `VideoAnalysis → faceTracker → cutter`. **No web/backend changes.**

## Config (explicit)

* `sampling: 1 fps` (not 30/60), `scene threshold 0.4`, `IoU 0.35`, `smoothing 0.2`, `zoom punch base 1.05`, `safe crop clamp`.

## Tasks

- [ ] Add `mediapipe` dep `electron/package.json:60` optional, `prepare-build.mjs` wasm copy, `.gitignore` `*mediapipe*`.
- [ ] `faceDetector.ts` sampled 0.5-1 fps, normalized boxes, multi-face, cache in `videoAnalysis` (`faces_json`).
- [ ] `faceTracker.ts` stable IDs, interpolate, occlusion, no jitter; `sceneDetector.ts` reset tracking.
- [ ] `cutter.ts` face-aware `crop` vs center `PORTRAIT_FILTER:10` fallback `center crop` when detection fails.
- [ ] `electron/renderer` preview uses same `crop` via `client-render/renderer.ts:64 outputDimensions`.

## Acceptance

* `npm --prefix electron run typecheck` green.
* Manual: `60 min source → seek still works (remapped at 01), 1080x1920 keeps face in safe frame (12%/20% headroom guides), no jitter on hold, scene cut resets ID`.
* Tests: `face metadata valid`, `output crop inside source`, `aspect ratio correct`, `fallback center when no face`.

## Exit

`PROGRESS.md` `02 [x]` → `03`. Backend untouched (`backend/core/cutter.py:10` stays center — Electron is repurposer).

## Instructor

Next: open `03-vad-filler.md`. WASM model download is ~15 MB — lazy-download to `userData/models/mediapipe` on first `face` use, smoke test `blazeface.tflite` exists like `whisper large-v3`.
