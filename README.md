# ClipForge

Find viral moments in long videos and cut short clips (9:16, 16:9, or original).

A web app where:

- **Next.js** (App Router, TypeScript) is the fullstack framework — auth via
  [Better Auth](https://better-auth.com) (email/password), data via
  [Prisma](https://prisma.io) on **NeonDB** (PostgreSQL).
- **Python** is the viral clipping engine — a **FastAPI** job service runs the
  pipeline in the background: download → transcribe → analyze → cut.
- **Cloudflare R2** (S3-compatible) stores source videos, rendered clips, and
  thumbnails.

One user has many projects; each project has many clips. Each clip stores its
title, viral hook, start/end timestamps, and video URL.

## Architecture

```
┌─────────────────────────────┐      ┌─────────────────────────────────┐
│  Next.js (web)              │      │  Python FastAPI (backend)      │
│  Better Auth · Prisma       │ HTTP │  yt-dlp · ffmpeg · AssemblyAI  │
│  pages + API routes         │─────▶│  /jobs, /jobs/{id}             │
└─────────────┬───────────────┘      └──────────────┬──────────────────┘
              │                                     │
              ▼                                     ▼
        ┌────────────────────────────────────────────────┐
        │  Postgres (NeonDB)  — single source of truth   │
        │  User · Project · Job · Clip                    │
        └────────────────────────────────────────────────┘
```

Next.js creates project/job rows and polls job progress (Prisma). The Python
service picks up the job, updates progress/stage on the `Job` row as it works,
uploads clips to R2, and inserts `Clip` rows.

## Layout

```
backend/   Python FastAPI job service + core engine (ffmpeg, yt-dlp, AssemblyAI, LLM)
web/       Next.js app (auth, dashboard, project page, API routes)
Caddyfile  reverse proxy (auto-HTTPS)
```

## Prerequisites

- Docker + Docker Compose (recommended deployment)
- A Neon Postgres database
- Cloudflare R2 (or S3) bucket + credentials
- Either a cloud transcription/LLM key, or local models (see below) —
  ClipForge supports both, chosen per deployment via env vars.

## Quick start

`run.sh` wraps the compose files below into one command — creates the
`.env` files on first run, picks the right compose overlay for cloud vs.
local models, and detects an NVIDIA GPU automatically:

```bash
./run.sh up              # dev stack, cloud providers (AssemblyAI + hosted LLM)
./run.sh up --local       # dev stack, fully local models (whisper.cpp + Ollama)
./run.sh prisma           # first time only: create the DB schema
./run.sh up --prod --local   # production stack, fully local models
./run.sh logs             # tail logs
./run.sh down             # stop everything
```

Edit `backend/.env` and `web/.env` (created from the `.env.example` files)
before starting — cloud mode needs real API keys, local mode does not.
See `./run.sh help` for every option. The rest of this README documents
what each compose file does if you want to run the commands manually.

## Cloud vs. local models

Both the transcription and analysis stages can run against a cloud API or
a fully local model, selected independently:

| Stage | `assemblyai` / `cloud` (default) | `local` |
|---|---|---|
| Transcription | AssemblyAI REST API | whisper.cpp (`pywhispercpp`), fully offline |
| Analysis | Any OpenAI-compatible endpoint (OpenAI, Groq, etc.) | Ollama, same OpenAI-compatible client |

Set in `backend/.env`:

```bash
TRANSCRIPTION_PROVIDER=assemblyai   # or "local"
LLM_BASE_URL=https://ai.sumopod.com/v1   # or http://localhost:11434/v1 for Ollama
LLM_API_KEY=your-key                 # any non-empty string for local (e.g. "ollama")
WORKERS=1                            # keep at 1 whenever a local model is in play
```

`analyzer.py` already speaks the OpenAI-compatible protocol, so switching
the LLM to local is just pointing `LLM_BASE_URL` at Ollama — no code
changes. The transcription provider needs the `local` extra installed:

```bash
poetry install --extras local   # or: pip install pywhispercpp
```

### Why WORKERS=1 for local models

Cloud APIs scale themselves; local models don't. whisper.cpp and Ollama
both compete for the same machine's CPU/GPU/RAM, so running two jobs at
once will thrash memory instead of going faster. `WORKERS` controls how
many jobs the backend processes concurrently (`app/worker.py`) — leave it
at `1` for any local-model deployment. Cloud-only deployments can raise it.

### Hardware tiers

| Tier | Spec | Transcription | LLM | Notes |
|---|---|---|---|---|
| **Baseline** | 16GB RAM, any OS, GPU optional | whisper.cpp `base`/`small` | Ollama, Qwen2.5-7B-Instruct Q4_K_M | Runs on a laptop (Mac/Linux/Windows). Sequential model loading keeps peak RAM to one model at a time. Several minutes per 10-min video. |
| **Linux GPU (throughput)** | 12GB+ VRAM (e.g. RTX 4070) | whisper.cpp/faster-whisper, CUDA | Ollama, 7B-14B model, GPU | `docker-compose.local.yml` GPU passthrough. Faster, can raise `WORKERS` slightly if VRAM allows. |
| **Cloud** | No local hardware requirement | AssemblyAI | Any OpenAI-compatible API | Original default. Scales independently of your hardware; per-request cost. |

Model quality tradeoff: a local 7B model judges "viral-worthiness"
noticeably behind GPT-4o-class cloud models. Position local mode as the
private/zero-per-video-cost tier, not a drop-in quality replacement.
Qwen2.5 (Apache-2.0) and whisper.cpp (MIT) are both safe to bundle and
resell; avoid Llama-licensed models if you want to skip its
acceptable-use clause.

### Running with local models

```bash
# Linux, with or without an NVIDIA GPU (falls back to CPU automatically):
docker compose -f docker-compose.dev.yml -f docker-compose.local.yml up -d --build

# macOS: Docker Desktop can't pass the GPU (Metal) into containers, so run
# Ollama natively for GPU acceleration, and point the backend at it:
brew install ollama && ollama serve
ollama pull qwen2.5:7b-instruct-q4_K_M
# In backend/.env: LLM_BASE_URL=http://host.docker.internal:11434/v1
docker compose -f docker-compose.dev.yml up -d --build
```

See `docker-compose.local.yml` for details on both paths.

## Setup (local)

```bash
# Backend
cd backend
cp .env.example .env          # fill in DATABASE_URL, ASSEMBLYAI_KEY, LLM_*, S3_*, INTERNAL_API_KEY
poetry install
poetry run uvicorn app.main:app --port 8000

# Web
cd ../web
cp .env.example .env          # fill in DATABASE_URL, BETTER_AUTH_SECRET, S3_*, BACKEND_URL, INTERNAL_API_KEY
npx prisma generate
npx prisma db push            # create the schema in Neon
npm install
npm run dev                   # http://localhost:3000
```

For local dev set `BACKEND_URL=http://localhost:8000`.

## Deploy to a VPS

1. Set your domain in `Caddyfile`.
2. Fill `backend/.env` and `web/.env` (all values, including matching
   `INTERNAL_API_KEY` and the same `DATABASE_URL`).
3. Create the schema in Neon:

   ```bash
   cd web
   npx prisma db push
   ```

4. Run (cloud providers):

   ```bash
   ./run.sh up --prod
   # or manually: docker compose -f docker-compose.yml up -d --build
   ```

   For fully local models on the VPS (needs a GPU or decent CPU):

   ```bash
   ./run.sh up --prod --local
   # or manually: docker compose -f docker-compose.yml -f docker-compose.local-prod.yml \
   #              -f docker-compose.gpu.yml up -d --build   (add the gpu overlay on NVIDIA hosts)
   ```

Caddy terminates TLS and proxies to the Next.js container. The backend is only
reachable inside the Docker network.

## How it works

1. **Source** — paste a YouTube URL (downloaded with yt-dlp, capped at 1080p,
   403 retry fallback) or upload a video (presigned PUT straight to R2).
2. **Transcribe** — the backend extracts audio with ffmpeg, uploads it to R2,
   transcribes with AssemblyAI, then deletes the temporary audio.
3. **Analyze** — an OpenAI-compatible LLM returns viral moments as JSON
   (title, hook, start, end).
4. **Cut** — ffmpeg trims each moment, crops to the chosen ratio, and the clip
   is uploaded to R2. Thumbnails are extracted and stored too.

Jobs run in the background; the UI polls progress (stage + %) every couple of
seconds.

## Tests

```bash
cd backend && poetry run pytest
```
