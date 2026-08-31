# 04 — Speaker-Aware Reframing (local)

**Goal:** `Speaker A talks → show A; Speaker B → B` with `faceTracker 02` `x`.

## Files

* **New** `electron/src/services/speakerAnalyzer.ts` — reuse `transcriber.ts:154` diar if `whisper-cli` ever emits `speaker_id`, else lightweight `webrtcvad + resemblyzer 256-dim` embedding (no `ASSEMBLYAI_KEY`). Input `speaker timestamps + tracked faces`, output `speaker_id per second + confidence`. Map by nearest `face.x` + headroom, fallback `most prominent face` when diar low.
* **New** `electron/src/services/camera.ts` — `follow/hold/smoothPan/speakerSwitch/punch-in 1.00→1.08` with guards `min shot 1.5s, ignore <300ms interjection, avoid switch when confidence low, keep both when appropriate` (spec F5). Easing `smooth 0.5s from_x 0.21→to_x 0.27`.
* **Modify** `electron/src/services/editPlan.ts:01` emit `visual_events[{time,type:speaker_switch,target:spk_2}]`, `electron/src/worker/jobRunner.ts:404` `ensembleScore` now also branches on `speaker_id` for `camera.target_face_id`.
* **No web/backend change** — electron only.

## Tasks

- [ ] `speakerAnalyzer` `webrtcvad` word-aligned diar, distance to `faceTracker` centers, `confidence`.
- [ ] `camera` `follow/hold/pan/switch` smoothing `0.2` + `punch-in` trigger hooks (strong claim/number).
- [ ] Add `visual_events` to `EditPlan` validator `evenDown`.
- [ ] Tests `speaker switch not excessive`, `hold when both visible`, `fallback most prominent`.

## Acceptance

* Demo clip with `00:00 A, 00:08 B, 00:15 A` → camera `A→B→A` with `≥1.5s` holds, no flutter on `uh` interjection.
* Manual: `timeline words + speaker` → big-box crop moves, no jitter.

## Exit

`PROGRESS.md 04 [x]` → `05`. Instructor: needs `02` faces done.

## Instructor

Next: `05-qwen-director.md`. Keep `ASSEMBLYAI_KEY` path untouched; local vad only.
