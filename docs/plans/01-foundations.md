# 01 — Foundations: EditPlan v1 + TimelineMapper + VideoAnalysis cache

**Goal:** No visible UX change. Introduce canonical `EditPlan` JSON, canonical `TimelineMapper`, and `VideoAnalysis` cache so `02-06` can change `aspect/tightness` without re-whisper or re-Qwen. All existing `Clip.start_time/end_time` + `timeline_words` flows stay green.

## Files

* **New** `electron/src/services/editPlan.ts` — `zod` `EditPlan` schema + validator/normalizer. Port spec `142` example:
  ```json
  {"version":1,"source":{"project_id":"uuid","duration":1842.3,"srcW":1920,"srcH":1080},
   "output":{"aspect_ratio":"9:16","tightness":"social","removeFiller":true,"punchIn":true,"blur":false,"caption_style_id":"classic"},
   "timeline":[{"id":"seg_1","source_start":120.2,"source_end":132.5,"label":"Hook","speaker_id":"spk_1","layout":"speaker_focus","camera":{"mode":"face","target_face_id":"f1","x":0.5,"y":0.35,"zoom":1.05,"pan":{"from_x":0.21,"to_x":0.27,"easing":"smooth","duration":0.5}},"caption":{"style_id":"classic","words":[]},"removals":[{"start":124.1,"end":124.7,"type":"filler","text":"um","confidence":0.96}],"ratio_frame":{"x":0.1,"y":0.05,"w":0.56,"h":1.0}}],
   "removals":[],"visual_events":[{"time":130.2,"type":"speaker_switch","target":"spk_2"}],"meta":{"angles":[{"type":"contrarian","score":92}],"reason_codes":["strong_hook"]}}
  ```
  Rules: reject invalid ops, clamp `crop x/y/zoom 0-1` inside source, normalize overlapping `removals` (sort+merge), `evenDown` H264 guard.

* **New** `electron/src/services/timeline.ts` — `TimelineMapper(removals:{start,end,type}[])`:
  ```
  source_to_output(t) -> t' | null (inside removal = null)
  output_to_source(t') -> t
  mapWords(words:{start_ms,end_ms}[]) -> filtered + re-anchored (clip-relative)
  mapCameraEvents(events[]) -> shifted
  total_removed(), output_duration()
  ```
  Electron only — no `web/src/lib/*` mirror, no `backend/core/*` mirror (web/backend frozen).

* **New** `electron/src/services/videoAnalysis.ts` — facade `analyzeSource(sourcePath, words[]) → {faces, scenes, silences, fillers}` cached at `userData/analysis-cache/{projectId}.json` (or `electron/src/services/db.ts:20` sqlite `analysis_cache` table `project_id PK, faces_json, scenes_json, silences_json, fillers_json, created_at`). Changing `aspect/tightness` reuses cache; new upload invalidates.

* **Modify** `electron/src/services/db.ts:20` migration `analysis_cache`, `electron/src/worker/jobRunner.ts:142` import cache helpers (no behavior change yet). **DO NOT TOUCH `backend/` or `web/`**.

## Tasks

- [ ] `editPlan.ts` zod (electron only) — export `parseEditPlan/validate/normalize`.
- [ ] `timeline.ts` implement + unit tests `tests/electron/test_timeline: remap 12→11 after 12-13 removal, captions sync, camera sync, evenDown`.
- [ ] `videoAnalysis.ts` skeleton (cache read/write/invalidate, no CV yet).
- [ ] Migration `analysis_cache`, no `electron-builder` extraResources yet.
- [ ] `npm --prefix electron run typecheck` + `vitest` green; keep `ClipCard SeekPreview` green.

## Acceptance

* `npm --prefix electron run typecheck` passes.
* Tests: `overlapping removals normalized`, `invalid ops rejected`, `TimelineMapper remap loop` green.
* `word-caption-overlay 135 + caption-grouping 24 + cutter 44` still use old `Clip` path (no regression).

## Exit

Update `PROGRESS.md` checkbox `01` → `02`. Do not start face WASM before `TimelineMapper` lands — A/V sync depends on it.

## Instructor

Next agent: start `01` (§Tasks), small PR `editPlan+timetable` only in `electron/`. Keep `backend/` + `web/` frozen. After merge, mark `01 [x]` in `PROGRESS.md` and set `Current phase: 02-wasm-face`.
