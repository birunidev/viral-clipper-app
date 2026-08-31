# 00 — Architecture Map (Electron App Only)

## Stack — Electron only (web/backend frozen)

* **Electron app** `electron/package.json:41` (`ffmpeg-static, ffprobe-static, yt-dlp-exec, sqlite-electron, electron-updater`) + `electron/renderer/package.json:6` `vite 6, react 19, react-router-dom 7, @tanstack/react-query 5.80, mediabunny 1.55` at `electron/renderer/vite.config.ts:9` alias `@→src/_web` (mirrors `web/src/{components,lib,hooks}` for captions grouping only; web itself is out of scope and will not be edited).
* **Local pipeline (the only pipeline we enhance)** `electron/src/worker/jobRunner.ts:142` `handleAnalyze/handleRender` + `electron/src/services/{transcriber.ts:154 spawn whisper-cli -ojf, analyzer.ts:341 node-llama-cpp LlamaChatSession qwen2.5-7b-q4_k_m 4.7GB, scorer.ts:82 ensemble 0.7/0.3, cutter.ts:44 PORTRAIT_FILTER center, captions.ts:102 buildAss, pipeline.ts:48 runAnalyze}` + `electron/src/services/db.ts:20` sqlite + `userDataRoot()` unified `~/.config/clipzard-desktop / ~/.clipzard`.
* **Backend / web — frozen, read-only context** (`backend/app/main.py:62` `WorkerPool`, `backend/app/models.py:611`, `web/src/app/app/(protected)/projects/[id]/page.tsx:91` web clipper) — not touched by plans `01-07`. The single `docker-compose.yml:17` + host Caddy `Caddyfile:122` remain deployment docs (`docs/deploy.md`) but not enhanced.
* **No CV deps today:** `electron/package.json:60` no `opencv/mediapipe` — `ffmpeg` is sole vision engine in app (`resources/bin/linux-x64/ffmpeg 76M` via `ffmpeg-static`).

## Current Electron pipeline (what spec calls “AI clip finder” — the only pipeline we enhance)

```
Long video ─ file picker / yt-dlp → projects/<id>/source.mp4 on disk (no R2 in app) ─ jobs:start → utilityProcess jobRunner.ts:142 handleAnalyze/handleRender
  ── handleAnalyze: ffprobe duration → transcribeWithWords 154 spawn whisper-cli -m ggml-* -f wav -ojf -pp → words[] {start_ms,end_ms} (userData/models/whisper/ggml-*.bin)
     → db timeline_words → analyzer.ts:341 analyzeLocal LlamaChatSession qwen2.5-7b q4_k_m (or cloud via LLM_API_KEY) → format_timestamped_words [0s-30s] + chunk 9k → JSON clips[title,hook,start,end] → add_clip (caption_json clip-relative, video_url=NULL, preview seeks source via media://)
  ── handleRender: cutter.ts:44 ffmpeg -ss -t -vf crop/scale/subtitles/drawtext veryfast crf20 (PORTRAIT_FILTER center)
```

Preview is Electron `renderer/src/pages/ProjectDetail.tsx:109` `SeekPreview` `video.currentTime=start → pause at end` + `word-caption-overlay:24 lastIndexRef gap-hold + groupWords 84`, `captions.ts:102 buildAss` per-word highlight, `scorer.ts:82 ensemble findBestMoments 0.7/0.3` fallback.

## Reusable (keep, don’t rewrite — Electron only)

* `electron/src/services/{transcriber.ts:21 bin helpers, analyzer.ts:86, scorer.ts:47, captions.ts:102 buildAss/cropDimensions, cutter.ts:15, pipeline.ts:48, db.ts:20}` + mirrored `web/src/lib/caption-grouping.ts:24, word-caption-overlay:24, caption-style-editor 338` via `renderer/vite.config.ts:9 @→src/_web` (read-only mirror) + `renderer/src/lib/client-render/renderer.ts:31 mediabunny` fallback.

## Gaps vs spec 15 features

| Spec | Now |
|---|---|
| Face detection/tracking/scene/9:16 | none — center crop only, `grep cv2` 0 |
| EditPlan v1 + TimelineMapper | `Clip.start_time/end_time` + `caption_json` only, no `{segments,camera,removals,visual_events}` spec |
| VAD/filler/false-start | no VAD/filler; duration clamp `analyzer.py:358` only |
| Tightness Natural/Social/Aggressive | no flag |
| Speaker diar + switch | no diar |
| Zoom/layout/reaction | single `orientation 9:16/16:9/original` at `projects:327` |
| Viral ranking/angles/story | LLM prompt `1-8 clips/chunk` but no `score/reason_codes/angle/diversity/non-contiguous` |
| Analysis cache | `timeline_words` reused 632 but no `faces/scenes/silences` cache; changing ratio retriggers render |

## Constraints for remaining plans (Electron app only)

* **DO NOT TOUCH `backend/` or `web/`** — Electron `src/services/*` + `renderer` are the only write targets. Backend/web references below are context only.
* WASM via `@mediapipe/tasks-vision` (15 MB) sampled `1 fps` → user wants full tracking + *more* for virality.
* Tokens `electron/renderer/src/globals.css` (mirrors `web/src/app/globals.css:37 canvas #0a0a0b accent #f6403f`), existing `Card/Skeleton/EmptyState ui/card:3` reused in electron.
