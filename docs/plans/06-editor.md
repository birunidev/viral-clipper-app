# 06 — Editor: CapCut-lite JSON-driven (Electron app only — explicit Save, global preset, ratio-locked drag, horizontal rounded thumbs)

**Goal:** Refactor Electron clipper (`electron/renderer/src/pages/ProjectDetail.tsx:109` `ProjectDetail` `SeekPreview video.currentTime=start`) toward `capcut but not full NLE`: big-box video loads all subtitle, right props patch `EditPlan` JSON, bottom is **not long video** but smart-engine JSON segments — selecting one plays to big box. **No web changes** (`web/src/app/app/(protected)/projects/[id]/page.tsx:308` stays as is).

## Shell (reuse `electron/renderer/src/globals.css` mirrors `web/src/app/globals.css:37 canvas #0a0a0b accent #f6403f`, `renderer/src/lib/providers` `QueryClient stale 5000`)

```
Header 56px [← Project] "60m source" · StatusPill · [Find moments]
Canvas flex:1 centered bg-canvas p-6 │ Props 360px border-l surface-1 p-4 gap-4 y-auto
  ┌─────────────────────┐            │ Ratio [9:16|4:5|1:1|16:9] ← live
  │ Big Box <video src=media:// sourceKey> │ ──
  │  WordCaptionOverlay + CropFrame   │ Subtitle preset [CaptionStylePicker swatches 13] + Customize→modal 591 max-w-3xl
  │  (handles + 12%/20% headroom)     │ ── Tightness [Natural|Social|Aggressive]
  │  ─ AudioWaveform (dimmed removals)│    [✓] Remove filler EN/ID  [✓] Punch-in 1.04→1.08
  │ Transport ◀ 00:42 ▶ 1× Mute       │    Segment inspector (label/speaker/layout)
  │                                  │    [Save primary md]  [Discard] ← explicit, no optimistic
Bottom 140-160px border-t surface-1 p-3 — Horizontal rounded-rect thumbs (this phase)
  Clips: flex gap-3 overflow-x-auto snap-x 108x192 (9:16) / 96x120 (4:5) rounded-xl border  each w 96-112 shrink-0
  Thumb frame rounded-xl overflow-hidden border-line shadow-sm active ring-2 ring-accent + Play hover 1.05, meta under: label 12px + Timestamp 25 + Hook
```

## Source of truth (JS-only validated, Electron only)

* `electron/src/services/editPlan.ts` (zod) `version:1` already at `01` — **no per-segment `caption.style_id`**; `output.caption_style_id` is **global** (`PropsPanel` single `PresetPicker` reusing `CaptionStylePicker swatches` mirrored via `renderer/src/_web/components/project/caption-style-picker.tsx` + `caption-preview-style:13 sizeScale 0.5`). Right `Create` opens `CaptionEditorModal max-w-3xl 591 backdrop-blur` live `WordCaptionOverlay 131`.
* **Explicit Save:** `electron/renderer/src/stores/editPlanStore.ts` `Zustand {editPlan, selectedId, original, dirty, patch(fn:immer)}` **no** `onMutate optimistic`. `useQuery editPlanKey(id) ["projects",id,"edit-plan"] staleTime:Infinity` via `window.clipzard` IPC (`electron/src/preload.ts:67` `projectGet`) loads from `electron/src/services/db.ts:20` sqlite `edit_plan JSON`; `patch` sets `dirty=true`; **Save** → `window.clipzard.projectCreate?` `PUT` via `ipcMain handle edit-plan` (`electron/src/main.ts:500` `deps:status` pattern) → `original=editPlan, dirty=false, qc.invalidate`; **Discard** → `reset(original)`; guard `beforeunload` if dirty.
* **Ratio-locked drag:** `CropFrameOverlay.tsx` inside `preview-stage`: `w=aspectW/srcW, h=aspectH/srcH` locked to `output.aspect_ratio` (`9:16|4:5|1:1|16:9` → `cropDimensions 268` / `renderer.ts:64 outputDimensions evenDown`), `onPointerMove → x=clamp(left/srcW,0,1-w), y=clamp(top/srcH,0,1-h)` uniform handles only, persists `segment.camera{x,y,mode:free}+ratio_frame` on `pointerUp` via `patch` (dirty). Double-click → `mode:face` recompute `target_face_id center - outW/2`.

## Bottom horizontal thumbs (this phase's visual — Electron only)

* **Component** `HorizontalThumbStrip.tsx` `flex gap-3 overflow-x-auto snap-x scroll-smooth scrollbar-thin` + `ThumbCell.tsx` `shrink-0 w-[108px] snap-start`
  * Frame `div aspect-[9/16] overflow-hidden rounded-xl border border-line bg-surface-2 shadow-sm hover:border-line-strong active ring-2` inner `img w-full h-full object-cover src=thumbnail_url` else `FilmReel 64 bg-black`, overlay `Play opacity-0 group-hover:opacity-100 scale-110` + `Captioned badge 412 rounded-full 10px`.
  * Meta under `mt-1` `label truncate 12px medium ink` double-click → `<input autoFocus>` `patch(label)`, `Timestamp start–end 10px muted + fmtDuration 22`.
* Ratio swap `9:16→4:5` just toggles container `aspect-[9/16]→aspect-[4/5]` live (same source image `object-cover` via `cropDimensions` math).

## Wiring (Electron app)

* `activeSegment = timeline.find(t∈[s,e]) ?? selectedId` → `remapped=TimelineMapper(removals).source_to_output(currentTime)`, `crop=cropForAspect(aspect,srcW,srcH,camera)` — preview `ctx.drawImage(video,crop…,0,0,outW,outH)` or cheap CSS `objectPosition`.
* Click thumb `video.currentTime=source_start; play()` + `findIndex start_ms` gap-hold `overlay:49`; aspect button pure `output.aspect_ratio` patch (reuse `faces` cache, no `jobs:start`).

## Files — Electron app only (no web/backend)

* **New** `electron/renderer/src/components/editor/{BigBox, CropFrameOverlay, HorizontalThumbStrip, ThumbCell, PropsPanel, AudioWaveform}.tsx`, `electron/renderer/src/stores/editPlanStore.ts`, `electron/src/services/{editPlan,timeline}.ts` (already at `01`), `electron/src/services/videoAnalysis.ts` cache `userData/analysis-cache/*.json`.
* **Modify** `electron/renderer/src/pages/ProjectDetail.tsx:109` `ClipCard` grid → strip `h-[144px] border-t`, `electron/renderer/src/lib/caption-grouping.ts` (mirrored), `electron/src/services/{cutter.ts:15,captions.ts:102}`, `electron/src/worker/jobRunner.ts:142`, `electron/scripts/prepare-build.mjs:38` mediapipe WASM extraResources.
* **Keep** `web/src/app/app/(protected)/projects/[id]/page.tsx:308` **frozen**, `backend/` **frozen**, `docker-compose.yml:121 whisper_models`.

## Acceptance (Electron)

* Thumbs `rounded-xl overflow-hidden` horizontal `snap-x`, `w 96-112` visible `5-7` before scroll, active ring, dblclick rename, aspect toggle rewraps without encode.
* `npm --prefix electron run typecheck` + `npm --prefix electron/renderer run build` green.

## Instructor

Next: `07-polish.md` (story/reaction). Do not start full-timeline razor — keep `TimelineMapper` canonical. No web changes.
