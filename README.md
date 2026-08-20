# ClipForge

Find viral moments in long videos and cut short clips (9:16, 16:9, or original).

A web app where:

- **Next.js** (App Router, TypeScript) serves the SSR marketing pages (no
  server-side data access) and the client-rendered app under `/app/*`.
  Every API call runs in the browser via **React Query** against the
  Python backend — there is no server-side code, no Prisma, no Better Auth
  in the web app anymore.
- **Python FastAPI** owns everything else: auth (email/password + httpOnly
  session cookies), the REST API (`/api/v1/*`), the database
  (**SQLAlchemy + Alembic** on PostgreSQL), the background pipeline
  (download → transcribe → analyze → cut), and S3/R2 presigning.
- **Cloudflare R2** (S3-compatible) stores source videos, rendered clips,
  and thumbnails.

One user has many projects; each project has many clips. Each clip stores its
title, viral hook, start/end timestamps, and video URL.

## Architecture

```
┌─────────────────────────────┐   /api/*   ┌──────────────────────────────────┐
│  Next.js (web)              │───────────▶│  Python FastAPI (backend)       │
│  SSR marketing pages (/)    │  session   │  auth (cookies) · REST API       │
│  client app (/app/*, React  │  cookie    │  SQLAlchemy + Alembic models     │
│  Query)                     │            │  yt-dlp · ffmpeg · whisper/AAI   │
└─────────────┬───────────────┘            └──────────────┬───────────────────┘
              │ Caddy reverse proxy (auto-HTTPS)          │
              ▼                                            ▼
        ┌────────────────────────────────────────────────────────┐
        │  Postgres  — single source of truth                     │
        │  User · Session · Project · Job · Clip                  │
        └────────────────────────────────────────────────────────┘
```

Caddy routes `/api/*` to the FastAPI backend and everything else to
Next.js, so the browser and API share one origin and the httpOnly session
cookie "just works". Starting a job is an in-process call (`pool.submit`)
inside the backend — there is no separate job HTTP service anymore.

## Layout

```
backend/   FastAPI: auth, REST API, SQLAlchemy models, Alembic migrations,
           worker pool, pipeline engine (ffmpeg, yt-dlp, whisper/AssemblyAI, Ollama/LLM)
web/       Next.js: SSR marketing pages at /, client-only app at /app/* (React Query)
Caddyfile  reverse proxy (auto-HTTPS, /api/* → backend)
alembic/   (under backend/) versioned DB migrations
```

## Prerequisites

- Docker + Docker Compose (recommended deployment)
- A Postgres database (Neon or any Postgres 14+)
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
./run.sh migrate          # first time only: create the DB schema (alembic upgrade head)
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
cp .env.example .env          # fill in DATABASE_URL, ASSEMBLYAI_KEY, LLM_*, S3_*, FRONTEND_URLS
poetry install
poetry run alembic upgrade head   # create the schema
poetry run uvicorn app.main:app --port 8000

# Web
cd ../web
cp .env.example .env          # fill in NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1
npm install
npm run dev                   # http://localhost:3000
```

For local dev, CORS must include `http://localhost:3000` (set
`FRONTEND_URLS` in `backend/.env`).

## Deploy to a VPS

1. Set your domain in `Caddyfile`.
2. Fill `backend/.env` and `web/.env`.
3. Create the schema:

   ```bash
   ./run.sh migrate --prod   # runs alembic upgrade head in the backend container
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

Caddy terminates TLS, proxies `/api/*` to the backend and everything else
to the Next.js container. The backend is only reachable inside the Docker
network (and via `/api/*` through Caddy).

## API overview

The backend owns all data and auth. Routes under `/api/v1`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | create user + session cookie |
| POST | `/auth/login` | verify password + session cookie |
| POST | `/auth/logout` | revoke session |
| GET | `/auth/me` | current user |
| GET/POST | `/projects` | list / create projects |
| GET | `/projects/{id}` | project + clips + jobs (with signed R2 URLs) |
| POST | `/projects/{id}/start` | create Job and enqueue the pipeline |
| GET | `/jobs/{id}` | poll job status |
| POST | `/uploads/presign` | presigned PUT URL for direct browser uploads |

Migrations live in `backend/alembic/`; the backend image runs
`alembic upgrade head` on boot.

## How it works

1. **Source** — paste a YouTube URL (downloaded with yt-dlp, capped at 1080p,
   403 retry fallback) or upload a video (presigned PUT straight to R2).
2. **Transcribe** — the backend extracts audio with ffmpeg and transcribes
   with whisper.cpp (local) or AssemblyAI (cloud), then deletes the temporary
   audio.
3. **Analyze** — an OpenAI-compatible LLM (Ollama local, or any hosted
   endpoint) returns viral moments as JSON (title, hook, start, end).
4. **Cut** — ffmpeg trims each moment, crops to the chosen ratio, and the clip
   is uploaded to R2. Thumbnails are extracted and stored too.

Jobs run in the background via a bounded worker pool (`WORKERS`, default 1);
the UI polls progress (stage + %) every couple of seconds with React Query.

## Tests

```bash
cd backend && poetry run pytest
```
