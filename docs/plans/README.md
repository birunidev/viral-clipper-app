# Plans — Enhance Clipper: Electron App Only (Local WASM)

> Source spec: `enhance-clipper-spec.md` (1399 lines). **Electron only, no web**. All 15 features refocused to `electron/` (`electron/src/services/*` + `electron/renderer`) local WASM `@mediapipe/tasks-vision` BlazeFace `1 fps` → tracker. **Backend and web are frozen** — `backend/core/*`, `web/src/*` do not change; web stays upload/presign only if present, no video enhance.

## How to use these plans (instructor for next agent — Electron only)

1. **Read `00-architecture.md` first** — electron stack, local pipeline, reusable parts, gaps.
2. **Work phase-by-phase in order `01 → 07`**. Each file is self-contained: Goal, Files to create/modify (absolute paths under `electron/` only), Schema/API contracts, Tasks (checkboxes), Acceptance / Tests, Fallbacks, Exit criteria.
3. **Keep progress in `PROGRESS.md`** — update its checkboxes + `Current phase` + `Next step` after every PR. Do not mark a phase done until its acceptance tests pass (`npm --prefix electron run typecheck`, `npm --prefix electron/renderer run typecheck` if touched, timeline/crop tests, manual horizontal thumbs check).
4. **One phase at a time, small PRs.** Do not jump to `06 Editor` before `01 Foundations` — `TimelineMapper` is required for A/V sync. **DO NOT TOUCH `backend/` or `web/`** — keep `backend/app/pipeline.py:422`, `web/src/app/app/(protected)/projects/[id]/page.tsx:308` green.
5. **Design tokens:** `electron/renderer/src/globals.css` (mirrors `web/src/app/globals.css:37` `canvas #0a0a0b, accent #f6403f`) — reuse, no new palette. All new UI lives in `electron/renderer/src/{components/editor,pages}`.

## Scope lock (user decisions — Electron app only)

* Electron only, local `node-llama-cpp` `qwen2.5-7b-q4_k_m.gguf 4.7GB` default (`electron/src/services/system.ts:43`) stays director; deterministic engines handle precise tasks. **No web changes.**
* WASM Blazeface, sampled `1 fps`, per-clip static fallback is not needed — full `IoU interpolate EMA` tracking is still desired (user: *want face tracking*). Virality beyond face is required (see `05 Qwen Director`).
* Editor refactors to capcut-lite JSON-driven inside `electron/renderer`: explicit **Save** button (not optimistic), subtitle preset **global** (`output.caption_style_id`), dragging **ratio-locked** `9:16|4:5|1:1|16:9` (not free), all clips shown as **horizontal rounded-rect thumbs** in bottom strip `140-160px` (`aspect-[9:16] 108x192`, `rounded-xl overflow-hidden`) — `01-07` encode these.

## Phase index

| Phase | File | Goal | Depends |
|---|---|---|---|
| 0 | `00-architecture.md` | Current architecture map + reusable + gaps | — |
| 1 | `01-foundations.md` | `EditPlan v1` + `TimelineMapper` + `VideoAnalysis` cache — no UX | 0 |
| 2 | `02-wasm-face.md` | WASM face 1 fps → tracker → scene → smooth 9:16 auto-reframe | 1 |
| 3 | `03-vad-filler.md` | `silencedetect` VAD + EN/ID filler + false-start → `removals` with sync | 1 |
| 4 | `04-speaker.md` | Diar `webrtcvad` + face → `speaker_switch` camera `1.5s` guard | 2 |
| 5 | `05-qwen-director.md` | Expanded Qwen prompt → validated `EditPlan` (viral score/angle/layout/zoom) | 3,4 |
| 6 | `06-editor.md` | CapCut-lite shell: big-box + right props (explicit Save, global preset, ratio-locked drag) + horizontal thumbs | 1 |
| 7 | `07-polish.md` | Story non-contiguous + reaction-aware (flag-gated) | 5,6 |

## Quick resume

Current: **M1 not started** → next agent: open `01-foundations.md` (§Tasks), create `editPlan.ts + timeline.ts` stubs + `analysis-cache` migration, keep `Clip.start_time/end_time` green.

## File conventions in plans

* Absolute paths under `/var/www/projects/viral-clipper-app` — **only `electron/` is in scope**; `web/` + `backend/` refs are read-only context.
* Line refs are from audit (may drift — search before edit).
* Brand new files marked **new**, modifies marked with `Lxx`.
