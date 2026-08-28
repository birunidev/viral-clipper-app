"""Shared pytest fixtures for the ClipZard backend test suite.

API/DB tests run against a *dedicated* test database
(``clipzard_test`` on the same Postgres as ``docker-compose.dev.yml``,
or any ``DATABASE_URL`` already set in the environment). The test DB is
created automatically if missing, so tests never touch the development
database's data. Tables are created directly from the SQLAlchemy metadata
(bypassing Alembic, which is exercised separately in CI/deploy) and
truncated after every test for isolation.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url as make_db_url

DEFAULT_DEV_URL = "postgresql+psycopg://clipzard:clipzard@localhost:5438/clipzard"
# Dedicated throwaway database so running the suite never wipes dev data.
# Runs on its own postgres-test service from docker-compose.dev.yml (:5439).
DEFAULT_TEST_URL = "postgresql+psycopg://clipzard:clipzard@localhost:5439/clipzard_test"


def _ensure_test_database(url: str) -> None:
    """Create the target database of ``url`` if it doesn't exist yet."""
    import time

    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url

    db_url = make_url(url)
    dbname = db_url.database
    admin_url = db_url.set(database="postgres")
    for attempt in range(30):  # wait for the dev postgres container
        try:
            admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
            with admin.connect() as conn:
                exists = conn.execute(
                    text("SELECT 1 FROM pg_database WHERE datname = :d"),
                    {"d": dbname},
                ).scalar()
                if not exists:
                    conn.execute(text(f'CREATE DATABASE "{dbname}"'))
            admin.dispose()
            return
        except Exception:
            if attempt == 29:
                raise
            time.sleep(1)


if not os.environ.get("DATABASE_URL"):
    _ensure_test_database(DEFAULT_TEST_URL)
os.environ.setdefault("DATABASE_URL", DEFAULT_TEST_URL)
os.environ.setdefault("FRONTEND_URLS", "http://testserver")

from app import database  # noqa: E402
from app.caption_presets import BUILTIN_CAPTION_STYLES  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402


def _seed_caption_styles() -> None:
    """Insert the built-in caption presets (mirrors the Alembic migration's
    seed step, which doesn't run here since the test schema is created
    directly from the SQLAlchemy metadata, not via `alembic upgrade`)."""
    import uuid

    engine = database.get_engine()
    with engine.begin() as conn:
        for style in BUILTIN_CAPTION_STYLES:
            conn.execute(
                text(
                    """
                    INSERT INTO caption_styles (id, key, label, config, is_builtin)
                    VALUES (:id, :key, :label, cast(:config as json), true)
                    ON CONFLICT (key) DO NOTHING
                    """
                ),
                {
                    "id": uuid.uuid4().hex,
                    "key": style["key"],
                    "label": style["label"],
                    "config": __import__("json").dumps(style["config"]),
                },
            )


@pytest.fixture(scope="session", autouse=True)
def _create_schema():
    engine = database.get_engine()
    database_url = os.environ.get("DATABASE_URL", DEFAULT_TEST_URL)
    # Only drop the schema on the dedicated *_test database to avoid
    # accidentally destroying a developer's local dev or remote database.
    dbname = (make_db_url(database_url).database or "").lower()
    is_test_db = dbname.endswith("_test")
    if is_test_db:
        Base.metadata.drop_all(engine)
    elif os.environ.get("ALLOW_TEST_SCHEMA_DROP"):
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    _seed_caption_styles()
    yield
    engine.dispose()


@pytest.fixture(autouse=True)
def _truncate_tables():
    from app.ratelimit import limiter

    # Rate-limit counters are process-global; clear them so each test gets
    # a fresh budget for auth endpoints.
    limiter._buckets.clear()
    yield
    engine = database.get_engine()
    # caption_styles is seed/reference data, not per-test state — keep it
    # across truncation so tests can rely on the built-in presets existing.
    # Custom (non-builtin) styles created *during* a test (e.g. via
    # POST /caption-styles) are per-test state though, so those are deleted
    # explicitly to avoid key collisions leaking across tests.
    # Truncate everything in ONE statement (FKs between the listed tables
    # are allowed), then restore built-in caption styles — caption_styles
    # now carries an FK to users so it can't be skipped from the sweep.
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables}"))
    _seed_caption_styles()


@pytest.fixture
def client(monkeypatch):
    # Never actually run the pipeline in API tests; just assert enqueueing
    # happened.
    submitted = []
    monkeypatch.setattr(
        "app.api.projects.pool.submit", lambda job_id: submitted.append(job_id)
    )
    with TestClient(app) as test_client:
        test_client._submitted_jobs = submitted  # type: ignore[attr-defined]
        yield test_client



