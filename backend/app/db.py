"""Data-access layer for ClipForge (SQLAlchemy).

Used by both the job pipeline/worker (``get_job``, ``update_job``,
``get_project``, ``update_project``, ``add_clip`` — signatures preserved
from the previous psycopg3 implementation) and the REST API routers
(users, sessions, projects, jobs, clips CRUD).

Each function opens its own short-lived session via
``database.session_scope()`` so callers (background threads, request
handlers) don't need to manage sessions themselves.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import select

from .database import session_scope
from .models import Account, Clip, Job, Project, Session, User, Verification

JOB_STATUS = ("queued", "running", "completed", "failed")
PROJECT_STATUS = ("idle", "queued", "running", "completed", "failed")


def _new_id() -> str:
    return uuid.uuid4().hex


def _row(obj) -> dict[str, Any] | None:
    """Shallow-serialize a mapped ORM object's own columns to a dict."""
    if obj is None:
        return None
    return {c.key: getattr(obj, c.key) for c in obj.__table__.columns}


# -------------------------------------------------------------------- users


def create_user(email: str, password_hash: str, name: str | None = None) -> dict:
    with session_scope() as db:
        user = User(id=_new_id(), email=email.lower().strip(), password_hash=password_hash, name=name)
        db.add(user)
        db.flush()
        return _row(user)


def get_user(user_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        return _row(db.get(User, user_id))


def get_user_by_email(email: str) -> dict[str, Any] | None:
    with session_scope() as db:
        stmt = select(User).where(User.email == email.lower().strip())
        return _row(db.execute(stmt).scalar_one_or_none())


# ----------------------------------------------------------------- sessions


def create_session_row(user_id: str, token: str, expires_at: dt.datetime) -> str:
    with session_scope() as db:
        session_id = _new_id()
        db.add(Session(id=session_id, token=token, user_id=user_id, expires_at=expires_at))
        return session_id


def get_session_by_token(token: str) -> dict[str, Any] | None:
    with session_scope() as db:
        stmt = select(Session).where(Session.token == token)
        return _row(db.execute(stmt).scalar_one_or_none())


def delete_session(session_id: str) -> None:
    with session_scope() as db:
        row = db.get(Session, session_id)
        if row is not None:
            db.delete(row)


def delete_session_by_token(token: str) -> None:
    with session_scope() as db:
        stmt = select(Session).where(Session.token == token)
        row = db.execute(stmt).scalar_one_or_none()
        if row is not None:
            db.delete(row)


# ------------------------------------------------------------------ jobs


def get_job(job_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        return _row(db.get(Job, job_id))


def get_job_with_project(job_id: str) -> dict[str, Any] | None:
    """Job row plus a nested ``project`` summary, for ownership checks / API responses."""
    with session_scope() as db:
        job = db.get(Job, job_id)
        if job is None:
            return None
        data = _row(job)
        data["project"] = {
            "id": job.project.id,
            "title": job.project.title,
            "status": job.project.status,
            "user_id": job.project.user_id,
        }
        return data


def create_job(
    project_id: str,
    options: dict | None = None,
    job_type: str = "analyze",
    clip_id: str | None = None,
) -> dict:
    with session_scope() as db:
        job = Job(id=_new_id(), project_id=project_id, options=options or {}, type=job_type, clip_id=clip_id)
        db.add(job)
        db.flush()
        return _row(job)


def find_active_job(project_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        stmt = select(Job).where(
            Job.project_id == project_id, Job.status.in_(("queued", "running"))
        )
        return _row(db.execute(stmt).scalars().first())


def find_active_render_job(clip_id: str) -> dict[str, Any] | None:
    """A render job for ``clip_id`` that is queued or running."""
    with session_scope() as db:
        stmt = select(Job).where(
            Job.clip_id == clip_id, Job.status.in_(("queued", "running"))
        )
        return _row(db.execute(stmt).scalars().first())


def get_clip(clip_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        return _row(db.get(Clip, clip_id))


def get_clip_for_user(clip_id: str, user_id: str) -> dict[str, Any] | None:
    """Clip row scoped by ownership through its project."""
    with session_scope() as db:
        stmt = (
            select(Clip)
            .join(Project, Project.id == Clip.project_id)
            .where(Clip.id == clip_id, Project.user_id == user_id)
        )
        return _row(db.execute(stmt).scalar_one_or_none())


def set_clip_video_url(clip_id: str, video_url: str) -> None:
    with session_scope() as db:
        clip = db.get(Clip, clip_id)
        if clip is not None:
            clip.video_url = video_url


def set_clip_thumbnail_url(clip_id: str, thumbnail_url: str) -> None:
    with session_scope() as db:
        clip = db.get(Clip, clip_id)
        if clip is not None:
            clip.thumbnail_url = thumbnail_url


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"status", "stage", "progress", "error", "options"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown job fields: {unknown}")
    with session_scope() as db:
        job = db.get(Job, job_id)
        if job is None:
            return
        for key, value in fields.items():
            setattr(job, key, value)


# --------------------------------------------------------------- projects


def get_project(project_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        return _row(db.get(Project, project_id))


def get_project_for_user(project_id: str, user_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        stmt = select(Project).where(Project.id == project_id, Project.user_id == user_id)
        return _row(db.execute(stmt).scalar_one_or_none())


def list_projects_for_user(user_id: str) -> list[dict[str, Any]]:
    """Projects for a user, newest first, each with clip_count and latest_job."""
    with session_scope() as db:
        stmt = (
            select(Project)
            .where(Project.user_id == user_id)
            .order_by(Project.created_at.desc())
        )
        projects = db.execute(stmt).scalars().all()
        results = []
        for project in projects:
            data = _row(project)
            data["clip_count"] = len(project.clips)
            latest_job = max(project.jobs, key=lambda j: j.created_at, default=None)
            data["latest_job"] = (
                {"id": latest_job.id, "status": latest_job.status, "progress": latest_job.progress}
                if latest_job
                else None
            )
            results.append(data)
        return results


def get_project_detail(project_id: str, user_id: str) -> dict[str, Any] | None:
    """Project with its clips (oldest first) and jobs (newest first), scoped to ``user_id``."""
    with session_scope() as db:
        stmt = select(Project).where(Project.id == project_id, Project.user_id == user_id)
        project = db.execute(stmt).scalar_one_or_none()
        if project is None:
            return None
        data = _row(project)
        data["clips"] = [
            _row(c) for c in sorted(project.clips, key=lambda c: c.created_at)
        ]
        data["jobs"] = [
            _row(j) for j in sorted(project.jobs, key=lambda j: j.created_at, reverse=True)
        ]
        return data


def create_project(user_id: str, title: str, source: str, source_type: str) -> dict:
    with session_scope() as db:
        project = Project(
            id=_new_id(),
            user_id=user_id,
            title=title,
            source=source,
            source_type=source_type,
        )
        db.add(project)
        db.flush()
        return _row(project)


def update_project(project_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"title", "source", "source_type", "source_key", "status"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown project fields: {unknown}")
    with session_scope() as db:
        project = db.get(Project, project_id)
        if project is None:
            return
        for key, value in fields.items():
            setattr(project, key, value)


# ----------------------------------------------------------------- clips


def add_clip(
    project_id: str,
    job_id: str | None,
    title: str,
    viral_hook: str | None,
    start: float,
    end: float,
    video_url: str | None,
    thumbnail_url: str | None,
) -> str:
    """Insert a clip. ``video_url`` is None until a render job cuts it —
    previews seek the project's source video to [start, end] until then."""
    with session_scope() as db:
        clip_id = _new_id()
        db.add(
            Clip(
                id=clip_id,
                project_id=project_id,
                job_id=job_id,
                title=title,
                viral_hook=viral_hook,
                start_time=start,
                end_time=end,
                video_url=video_url,
                thumbnail_url=thumbnail_url,
            )
        )
        return clip_id
