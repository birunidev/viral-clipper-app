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
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _create_schema():
    engine = database.get_engine()
    Base.metadata.create_all(engine)
    yield
    engine.dispose()


@pytest.fixture(autouse=True)
def _truncate_tables():
    yield
    engine = database.get_engine()
    tables = ", ".join(f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables))
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} CASCADE"))


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



