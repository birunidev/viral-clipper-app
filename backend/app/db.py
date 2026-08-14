"""Shared Postgres access for the job pipeline (psycopg3).

Reads/writes the same tables Prisma manages in Next.js (NeonDB). Column
names match the Prisma schema exactly (quoted, case-sensitive).
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import psycopg
from psycopg.rows import dict_row

JOB_STATUS = ("queued", "running", "completed", "failed")
PROJECT_STATUS = ("idle", "queued", "running", "completed", "failed")


def _dsn() -> str:
    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        raise RuntimeError("DATABASE_URL environment variable is required.")
    return dsn


def _connect() -> psycopg.Connection:
    return psycopg.connect(_dsn(), row_factory=dict_row)


# ------------------------------------------------------------------ jobs


def get_job(job_id: str) -> dict[str, Any] | None:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute('SELECT * FROM "Job" WHERE id = %s', (job_id,))
        return cur.fetchone()


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"status", "stage", "progress", "error", "options"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown job fields: {unknown}")
    assignments = ", ".join(f'"{k}" = %s' for k in fields)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f'UPDATE "Job" SET {assignments}, "updatedAt" = now() '
            'WHERE id = %s',
            (*fields.values(), job_id),
        )
        conn.commit()


# --------------------------------------------------------------- projects


def get_project(project_id: str) -> dict[str, Any] | None:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute('SELECT * FROM "Project" WHERE id = %s', (project_id,))
        return cur.fetchone()


def update_project(project_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"title", "source", "sourceType", "status"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown project fields: {unknown}")
    assignments = ", ".join(f'"{k}" = %s' for k in fields)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f'UPDATE "Project" SET {assignments}, "updatedAt" = now() '
            'WHERE id = %s',
            (*fields.values(), project_id),
        )
        conn.commit()


# ----------------------------------------------------------------- clips


def add_clip(
    project_id: str,
    job_id: str,
    title: str,
    viral_hook: str | None,
    start: float,
    end: float,
    video_url: str,
    thumbnail_url: str | None,
) -> str:
    clip_id = uuid.uuid4().hex
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "Clip"
                (id, "projectId", "jobId", title, "viralHook",
                 "startTime", "endTime", "videoUrl", "thumbnailUrl", "createdAt")
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            """,
            (
                clip_id,
                project_id,
                job_id,
                title,
                viral_hook,
                start,
                end,
                video_url,
                thumbnail_url,
            ),
        )
        conn.commit()
    return clip_id
