"""SQLAlchemy engine/session setup.

Replaces the previous raw-psycopg3 connection helper. ``DATABASE_URL`` is
the same env var used before (and by Alembic); SQLAlchemy needs the
``postgresql+psycopg://`` driver prefix, which :func:`_normalize_dsn`
adds automatically if a plain ``postgresql://`` URL is supplied (Neon,
docker-compose, etc. all use the plain form).
"""

from __future__ import annotations

import os
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.orm import sessionmaker

_engine = None
_SessionLocal: sessionmaker | None = None


def _normalize_dsn(dsn: str) -> str:
    if dsn.startswith("postgresql://"):
        return "postgresql+psycopg://" + dsn[len("postgresql://") :]
    if dsn.startswith("postgres://"):
        return "postgresql+psycopg://" + dsn[len("postgres://") :]
    return dsn


def get_dsn() -> str:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        raise RuntimeError("DATABASE_URL environment variable is required.")
    return _normalize_dsn(dsn)


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(get_dsn(), pool_pre_ping=True, future=True)
    return _engine


def get_session_factory() -> sessionmaker:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False, class_=OrmSession)
    return _SessionLocal


def reset_engine() -> None:
    """Drop the cached engine/session factory (used by tests to rebind DATABASE_URL)."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None


@contextmanager
def session_scope() -> Generator[OrmSession, None, None]:
    """Context manager for a transactional unit of work (used by the worker/pipeline)."""
    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Generator[OrmSession, None, None]:
    """FastAPI dependency yielding a request-scoped session."""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()
