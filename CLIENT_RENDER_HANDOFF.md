# SnapClip — Client-Side Rendering Handoff Notes

**Purpose:** everything another agent needs to continue the client-side video rendering feature without re-discovering context. Written mid-implementation on 2026-08-26.

---

## 1. Product & stack snapshot

- **SnapClip** (rebranded from ClipForge/BandarClip): paste YouTube link or upload video → backend downloads (yt-dlp), transcribes (AssemblyAI Universal-2 or local whisper.cpp), finds viral moments via LLM (OpenRouter `openrouter/free`), user renders/downloads TikTok-style captioned clips.
- **Backend**: FastAPI (`backend/app`), SQLAlchemy+Postgres, credit-based billing (Paddle global / Midtrans ID). Worker pool = tier-priority queue (`backend/app/worker.py`, `WORKERS=1` default).
- **Frontend**: Next.js 16 App Router (`web/src`), TanStack Query, Tailwind v4 tokens (`globals.css`: `--accent #f6403f` dark theme, ink/line/surface vars).
- **Deploy**: VM `ubuntu@VM-14-117-ubuntu:~/apps/snapclip`, host-level Caddy (`Caddyfile`, domain **snapclip.mysaas.web.id**, ACME email hello@birunidev.com), docker-compose publishes loopback-only: backend `127.0.0.1:8000`, web `127.0.0.1:**3005**→container 3000`... see §6 port note. DB internal-only.
- **Tests**: `cd backend && poetry run pytest` — 285 passing as of this handoff. Web typecheck: `npx tsc --noEmit`.

---

## 2. The feature being built (approved plan)

Client-side clip rendering in the browser (WebCodecs) to offload ffmpeg from the VPS. **Hybrid**: browsers with WebCodecs render locally; anything else falls back to the existing server queue. Rendered file uploads back to R2 and registers exactly like server renders ("store like today"). Driver: cost reduction.

### Already DONE (committed unless noted)

**Backend — complete, tested:**
- `POST /api/v1/projects/{pid}/clips/{cid}/client-render/presign` → presigned PUT into `projects/{pid}/clips/<uuid>.mp4`, ledgered via `uploads` table (`db.record_upload`) — ownership model identical to source uploads.
- `POST .../client-render/complete` body `{key, size_bytes?}` → validates key prefix `projects/{pid}/clips/*.mp4`, single-use claim (`db.claim_upload_for_project`), verifies object exists via HEAD, sets `clip.video_url`, adds storage accounting (`storage.add_project_storage`), returns ClipResponse with `signed_video_url`.
- Feature flag: `CLIENT_RENDER=1` env (default on) surfaced as `client_render: bool` in `GET /billing/status` payload (`core/billing.py`).
- Tests in `tests/test_projects_api.py` (3 new: presign+complete happy path w/ single-use, foreign-key rejection, cross-user 404).
- ⚠️ **Uncommitted at handoff time**: schemas fix + endpoints + tests + GA integration + `.gitignore` fix. Run `git status`, review, commit & push first thing.

**Frontend — partial:**
- `mediabunny@latest` installed (`node_modules/mediabunny`). `mp4box`/`mp4-muxer` were tried and REMOVED (muxer deprecated in favor of mediabunny).

### REMAINING (the actual build)

1. `web/src/lib/client-render/captions.ts` — canvas port of ASS caption styles
2. `web/src/lib/client-render/renderer.ts` — mediabunny decode→canvas overlay→encode pipeline
3. Hook/UI wiring with automatic server fallback + feature-flag gate
4. Commit/push; VM deploy needs `NEXT_PUBLIC_GA_ID` in root `.env` before `docker compose build web`

---

## 3. Mediabunny API cheat-sheet (verified against installed .d.ts)

```ts
import {
  Input, UrlSource, ALL_FORMATS,
  VideoSampleSink, CanvasSink, AudioSampleSink,
  Output, Mp4OutputFormat, BufferTarget,
  CanvasSource, AudioBufferSource, QUALITY_HIGH,
} from "mediabunny";

// READ: streams over fetch range-requests (no full download)
const input = new Input({ url: presignedUrl, formats: ALL_FORMATS });
const videoTrack = await input.getPrimaryVideoTrack();   // may be null
const audioTrack = await input.getPrimaryAudioTrack();
await videoTrack.canDecode();                            // false → trigger server fallback
await videoTrack.computeDuration();

// VIDEO FRAMES rendered to canvases (handles rotation/resizing):
const sink = new CanvasSink(videoTrack, {
  width: outW, height: outH,        // e.g. 1080x1920 portrait
  fit: "cover",                     // 'fill'|'contain'|'cover'
  crop?: { left, top, width, height }, // display-pixel-space crop (applied pre-resize)
  rotation?: 0|90|180|270,          // defaults to metadata rotation
  poolSize: 4,                      // reuse canvases (constant VRAM)
});
for await (const wrapped of sink.canvases(clipStart, clipEnd)) {
  // wrapped: { canvas: HTMLCanvasElement|OffscreenCanvas, timestamp: sec, duration: sec }
  drawCaptions(ctx, wrapped);       // ← captions/watermark drawn HERE per frame
  await videoSource.add(wrapped.canvas, wrapped.timestamp);
}

// AUDIO: decoded samples in range → assemble AudioBuffer → source
const audioSink = new AudioSampleSink(audioTrack);
for await (const sample of audioSink.samples(clipStart, clipEnd)) { /* sample.buffer */ }

// WRITE:
const output = new Output({
  format: new Mp4OutputFormat(),
  target: new BufferTarget(),
});
output.addVideoTrack(videoSource, { frameRate });   // then videoSource.add(canvas, ts)
output.addAudioTrack(audioSource);
await output.start();
// ... add frames/audio with absolute timestamps starting at 0 (subtract clipStart!)
await output.finalize();
const blob = new Blob(output.target.buffer, { type: "video/mp4" });
```

Key gotchas:
- Timestamps fed to `videoSource.add()` must be **clip-relative (start at 0)** — subtract `clipStart`.
- `CanvasSink` yields canvases sized to `width×height`; draw captions AFTER the frame content is on the canvas.
- If `canDecode()` is false or any step throws → fall back to server render path (do NOT half-fail silently).
- Clips are ≤ ~90s (product cap `max_clip_seconds`), so assembling one AudioBuffer (~35MB float32 stereo @48k) is acceptable memory-wise.

---

## 4. Caption parity spec (port from `core/captions.py`)

Style configs come from `app/caption_presets.py` `BUILTIN_CAPTION_STYLES` and user customs (same shape):

```json
{"font":"Anton","font_size":72,"x":"center","y":0.8,"bold":true,"italic":false,
 "primary_color":"#FFFFFF","highlight_color":"#FFD60A","outline_color":"#000000",
 "outline":4,"shadow":0,"words_per_line":4,"max_chars_per_line":32,
 "boxed":false,"box_opacity":0.0}
```

Rules to mirror exactly:
- **Font size scaling**: `_scaled_font_size` scales `font_size` by `height / REFERENCE_HEIGHT` (check constant in core/captions.py), clamped [10, 511].
- **Line grouping**: greedy — append word while `current_chars + len(word)+1 <= max_chars_per_line`, else start new line. Also `words_per_line` cap exists.
- **Highlight**: each event highlights ONE active word (`\c` color swap); active word's window runs from its `start_ms` to the NEXT word's `start_ms`; last word ends at own `end_ms`; clamp ≥1ms.
- **Sanitize word text**: strip `{ } \` and `\n\r` before drawing (parity + safety).
- Colors are `#RRGGBB`; outline width float; shadow int.
- `y` fraction of height → margin from bottom (`margin_v = (1-y)*h`, clamp [8, h//2]).
- Watermark: server draws "SnapClip" text bottom-right-ish (see `core/cutter.py` drawtext) — replicate position/opacity.
- Reference: `tests/test_captions.py` documents expected behavior; screenshot-diff against server-rendered clips during tuning.

Fonts: Anton + Space Grotesk live in `backend/assets/fonts` and must be served to the browser — copy into `web/public/fonts/` and load via `FontFace` API before first draw (`document.fonts.add`).

---

## 5. Frontend wiring plan

- **Feature detect** (`lib/client-render/support.ts`):
  `"VideoEncoder" in window && "VideoDecoder" in window && typeof OffscreenCanvas !== "undefined"` AND `billing?.client_render === true` (from `useBilling()`).
- **Hook** `useRenderClip(projectId)` currently posts to server job. New flow:
  1. If supported+flag: run client renderer with progress UI (local %, no polling).
  2. On success blob: `URL.createObjectURL` → auto-download anchor; then presign→PUT blob to R2→POST complete→invalidate project query.
  3. On ANY throw (decode unsupported codec like HEVC, mux error, network): log + transparently call existing server mutation (unchanged code path).
- **UI**: download button shows progress bar during client render; server path keeps its current polling UX.
- Types: extend `ClipDetail` usage — `caption_json` already present on clips.

---

## 6. Hard-won environment facts (don't relearn these)

- **Ports**: VPS host port **3005** for web (host 3000 runs ANOTHER app). Container internally listens 3000; compose maps `127.0.0.1:3005:3000`; Caddy upstreams: `127.0.0.1:8000` (backend `/health`) and `127.0.0.1:3005` (web `/`).
- **Healthchecks probe unauthenticated endpoints only** — auth'd routes 401 and read as failure (this broke deploy once). Use `/health`.
- **NEXT_PUBLIC_* are BUILD-TIME baked**: pass as compose build args (`NEXT_PUBLIC_API_URL=https://snapclip.mysaas.web.id/api/v1`, `NEXT_PUBLIC_GA_ID`), rebuild web after changes.
- **Session tokens hashed** sha256 at rest; cookie `Secure` auto-on when FRONTEND_URLS https.
- **Queue**: tier priority Studio>Creator>Starter>Free; `MAX_QUEUE_DEPTH` backpressure → 429; startup recovers queued/stale-running jobs.
- **Soft delete/trash**: `deleted_at`, restore + purge endpoints, 30-day lazy sweep.
- **Local whisper**: `WHISPER_MODEL="small"` ≈ AssemblyAI quality on clear speech; models persist in named volume `whisper_models`; pywhispercpp now installed in prod image via requirements.txt.
- **Known broken env var**: dev `backend/.env` `S3_BUCKET=testing-bucket` → NoSuchBucket on R2; cloud transcribe falls back only if var removed.
- **pyproject gotcha**: pywhispercpp is an optional extra → `poetry install --extras local` locally.
- **Edit schemas carefully**: an earlier sed-style insert landed mid-class and swallowed fields; always read the class after editing.

---

## 7. Verification checklist when resuming

1. `git status` → commit whatever is pending (GA + schemas + client-render endpoints + tests).
2. `cd backend && poetry run pytest -q` → expect 285+ green.
3. `cd web && npx tsc --noEmit` clean.
4. Build order on VM after merge: set `NEXT_PUBLIC_GA_ID` in root `.env` → `docker compose build web backend` → `up -d` → curl checks:
   - `curl -sI http://127.0.0.1:3005` → 200
   - `curl -si http://127.0.0.1:8000/health | head -1` → 200
   - `https://snapclip.mysaas.web.id` → HTTP/2 200 (was verified working 2026-08-26).
5. Manual E2E for client render: Chrome desktop → project page → Download → observe local progress → downloaded mp4 has burned captions; clip card shows rendered state; storage_used increases.


---

## 8. Feasibility: client-side YouTube download + audio conversion

Question explored 2026-08-26: could the SOURCE DOWNLOAD and AUDIO EXTRACTION also move to the browser?

### Verdict table

| Step | Pure client possible? | Why |
|---|---|---|
| Resolve YouTube -> stream URLs | No - not from a normal website | youtube.com endpoints are SOP/CORS-blocked; extraction = yt-dlp-grade arms race (signature deciphering, PO tokens/BotGuard, consent walls), maintained full-time by the yt-dlp team |
| Download the video bytes | Partially | `<video src>` plays googlevideo URLs fine (media elements skip CORS), but *fetching bytes* for decode/mux needs CORS - googlevideo sends none. Works only via a CORS-stripping proxy or a browser extension |
| Audio extract/convert | Yes, easily | Once bytes are reachable: mediabunny demux -> AudioSampleSink -> AudioEncoder (AAC/m4a) or lame.wasm (mp3). Same primitives as the render pipeline |

### Realistic architectures (ranked)

**A. Thin-resolver + CORS proxy (recommended if pursuing):**
1. Backend keeps ONLY yt-dlp resolution (`get_info`) - kilobytes of JSON; no video ever touches the VPS.
2. Backend returns signed googlevideo URL(s) to the client.
3. Client fetches media bytes through a Cloudflare Worker proxy whose only job is forwarding + adding Access-Control-Allow-Origin (Cloudflare has zero egress fees; free tier ample).
4. Browser: mediabunny demuxes -> extracts audio -> uploads audio (R2 or straight to AssemblyAI) -> analyze continues server-side minus all video handling.

Wins: VPS stops ingesting every source video entirely (ingress bandwidth + the 100-200MB transient RAM gone); user upload path parallelizes.
Costs: one Worker to maintain; googlevideo URLs can be IP-bound with short TTL - the Worker/proxy pairing must be prototyped and tested.

**B. Browser extension:** host permissions bypass page CORS entirely; true client-only downloads become possible. Different product surface (install friction, store review) - far-future option only.

**C. Status quo:** backend yt-dlp download stays. At current scale it costs nothing but caps scaling (VPS bandwidth quota, downloads serialize behind WORKERS=1).

### Recommendation
Not now. Ship client-side RENDERING first (sections 2-5). Revisit architecture A when VPS ingress bandwidth becomes the measured bottleneck - it composes cleanly with the render work (same mediabunny primitives, same presign patterns).

### Open technical risks if pursued
- googlevideo URL-to-IP binding: URLs resolved by the backend may be rejected when fetched from Worker egress IPs. Mitigation is unproven - prototype required (resolve from the Worker itself, or test referer/header games).
- SABR / PO-token enforcement keeps tightening; any client-download design inherits yt-dlp's breakage cadence.
