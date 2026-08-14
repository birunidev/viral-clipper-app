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
- AssemblyAI API key
- An OpenAI-compatible LLM key (e.g. https://ai.sumopod.com/v1)

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

4. Run:

   ```bash
   docker compose up -d --build
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
