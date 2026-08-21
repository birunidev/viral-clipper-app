"""Shared pytest fixtures for the ClipForge backend test suite.

API/DB tests run against a real Postgres (the same one used by
``docker-compose.dev.yml postgres`` service, or any ``DATABASE_URL``
already set in the environment). Tables are created directly from the
SQLAlchemy metadata (bypassing Alembic, which is exercised separately in
CI/deploy) and truncated after every test for isolation.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault(
    "DATABASE_URL", "postgresql://clipforge:clipforge@localhost:5438/clipforge"
)
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
    Base.metadata.create_all(engine)
    _seed_caption_styles()
    yield
    engine.dispose()


@pytest.fixture(autouse=True)
def _truncate_tables():
    yield
    engine = database.get_engine()
    # caption_styles is seed/reference data, not per-test state — keep it
    # across truncation so tests can rely on the built-in presets existing.
    # Custom (non-builtin) styles created *during* a test (e.g. via
    # POST /caption-styles) are per-test state though, so those are deleted
    # explicitly to avoid key collisions leaking across tests.
    tables = ", ".join(
        f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables) if t.name != "caption_styles"
    )
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} CASCADE"))
        conn.execute(text("DELETE FROM caption_styles WHERE is_builtin = false"))


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



