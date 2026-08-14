# ClipForge Backend

FastAPI job service for the ClipForge viral clipping engine. Runs the
pipeline (download → transcribe → analyze → cut) in the background and
persists job progress and clips to the shared Postgres (Neon) database.

## Run

```bash
cp .env.example .env   # fill in credentials
poetry install
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Requires `ffmpeg` on PATH.
