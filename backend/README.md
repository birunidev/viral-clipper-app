# ClipForge Backend

FastAPI service for ClipForge. Owns everything server-side: auth
(email/password + httpOnly session cookies), the REST API (`/api/v1/*`),
the database (SQLAlchemy + Alembic), the background clipping pipeline
(download → transcribe → analyze → cut), and S3/R2 presigning.

## Run

```bash
cp .env.example .env   # fill in DATABASE_URL, credentials, FRONTEND_URLS
poetry install
poetry run alembic upgrade head   # create/update the schema
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
# dev with auto-reload on file changes:
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Requires `ffmpeg` on PATH.

## Layout

```
app/            FastAPI app: main, db (SQLAlchemy data access), models,
                security (argon2 + sessions), schemas (pydantic), api/ routers
alembic/        versioned DB migrations (run on boot in Docker)
core/           engine: transcriber (whisper.cpp / AssemblyAI), analyzer (LLM),
                cutter (ffmpeg), youtube (yt-dlp), s3 (R2)
tests/          pytest suite (needs a reachable DATABASE_URL for API tests)
```

## Tests

```bash
poetry run pytest
```

The API/DB tests run against a real Postgres. Set `DATABASE_URL` (defaults
to the docker-compose.dev.yml local DB) and run once:

```bash
poetry run alembic upgrade head
```
