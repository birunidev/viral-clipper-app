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

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import func, select, update

from .database import session_scope
from .models import (
    Account,
    BillingEvent,
    CaptionStyle,
    Clip,
    Job,
    PaymentOrder,
    Project,
    Session,
    TimelineWord,
    User,
    UserSettings,
    Verification,
)

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
        # New accounts get a one-time free credit grant (no subscription).
        from app.plans import free_credits

        user = User(
            id=_new_id(),
            email=email.lower().strip(),
            password_hash=password_hash,
            name=name,
            credits=free_credits(),
            entitlement_tier="free",
        )
        db.add(user)
        db.flush()
        return _row(user)


def get_user(user_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        return _row(db.get(User, user_id))


def update_user(user_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"name", "image", "storage_used_bytes"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown user fields: {unknown}")
    with session_scope() as db:
        user = db.get(User, user_id)
        if user is None:
            return
        for key, value in fields.items():
            setattr(user, key, value)


def increment_user_storage(user_id: str, delta_bytes: int) -> None:
    """Atomically add ``delta_bytes`` to ``users.storage_used_bytes``.

    Uses a SQL UPDATE … SET storage_used_bytes = GREATEST(0, x + delta)
    so concurrent renders/thumbnails can't lose updates via read-modify-write
    races (relevant when WORKERS > 1). Never goes below zero.
    """
    if delta_bytes == 0:
        return
    with session_scope() as db:
        from sqlalchemy import func as sqlfunc
        db.execute(
            update(User)
            .where(User.id == user_id)
            .values(
                storage_used_bytes=sqlfunc.greatest(
                    0, User.storage_used_bytes + delta_bytes
                )
            )
        )


def increment_project_storage(project_id: str, delta_bytes: int) -> None:
    """Atomically add ``delta_bytes`` to ``projects.storage_bytes``."""
    if delta_bytes == 0:
        return
    with session_scope() as db:
        from sqlalchemy import func as sqlfunc
        db.execute(
            update(Project)
            .where(Project.id == project_id)
            .values(
                storage_bytes=sqlfunc.greatest(
                    0, Project.storage_bytes + delta_bytes
                )
            )
        )


def get_user_by_email(email: str) -> dict[str, Any] | None:
    with session_scope() as db:
        stmt = select(User).where(User.email == email.lower().strip())
        return _row(db.execute(stmt).scalar_one_or_none())


# ------------------------------------------------------------------ billing


def count_projects(user_id: str) -> int:
    with session_scope() as db:
        stmt = select(func.count(Project.id)).where(Project.user_id == user_id)
        return int(db.execute(stmt).scalar() or 0)


def set_user_billing(user_id: str, **fields: Any) -> None:
    """Update a user's credit/entitlement columns (provider-agnostic)."""
    allowed = {
        "credits",
        "entitlement_tier",
        "plan_key",
        "billing_email",
    }
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown billing fields: {unknown}")
    with session_scope() as db:
        user = db.get(User, user_id)
        if user is None:
            return
        for key, value in fields.items():
            setattr(user, key, value)


def increment_user_credits(user_id: str, delta_credits: int) -> None:
    """Atomically add ``delta_credits`` to ``users.credits`` (negative to
    deduct). Never drops below zero — a concurrent deduction can't overdraw."""
    if delta_credits == 0:
        return
    with session_scope() as db:
        from sqlalchemy import func as sqlfunc
        db.execute(
            update(User)
            .where(User.id == user_id)
            .values(
                credits=sqlfunc.greatest(0, User.credits + delta_credits)
            )
        )


def create_payment_order(
    user_id: str, provider: str, order_id: str, plan_key: str,
    gross_amount: int, currency: str,
) -> dict[str, Any]:
    """Record a checkout we initiated. ``order_id`` is globally unique so the
    payment webhook can look up exactly one row (and its quoted amount)."""
    with session_scope() as db:
        order = PaymentOrder(
            id=_new_id(),
            user_id=user_id,
            provider=provider,
            order_id=order_id,
            plan_key=plan_key,
            gross_amount=gross_amount,
            currency=currency,
            status="pending",
        )
        db.add(order)
        db.flush()
        return _row(order)


def get_payment_order(order_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        stmt = select(PaymentOrder).where(PaymentOrder.order_id == order_id)
        return _row(db.execute(stmt).scalar_one_or_none())


def set_payment_order_status(order_id: str, status: str) -> None:
    with session_scope() as db:
        stmt = select(PaymentOrder).where(PaymentOrder.order_id == order_id)
        order = db.execute(stmt).scalar_one_or_none()
        if order is not None:
            order.status = status


def billing_event_exists(event_id: str) -> bool:
    with session_scope() as db:
        stmt = select(BillingEvent).where(BillingEvent.event_id == event_id)
        return db.execute(stmt).scalar_one_or_none() is not None


def record_billing_event(event_id: str, event_name: str, payload: dict) -> None:
    with session_scope() as db:
        db.add(
            BillingEvent(
                id=_new_id(), event_id=event_id, event_name=event_name, payload=payload
            )
        )


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


def create_settings(user_id: str, settings: dict) -> dict:
    """Insert one user_settings row. ``settings`` fields map 1:1 to the
    UserSettings model (API keys should already be encrypted by the caller).
    """
    with session_scope() as db:
        row = UserSettings(
            id=_new_id(),
            user_id=user_id,
            llm_api_key=settings.get("llm_api_key"),
            llm_base_url=settings.get("llm_base_url") or None,
            llm_model=settings.get("llm_model") or None,
            transcription_provider=settings.get("transcription_provider", "assemblyai") or "assemblyai",
            assemblyai_key=settings.get("assemblyai_key"),
        )
        db.add(row)
        db.flush()
        return _row(row)


def get_user_settings(user_id: str) -> dict[str, Any] | None:
    """A user's BYOK settings row (raw/encrypted), or None if unset."""
    with session_scope() as db:
        stmt = select(UserSettings).where(UserSettings.user_id == user_id)
        return _row(db.execute(stmt).scalar_one_or_none())


def upsert_user_settings(user_id: str, settings: dict) -> dict:
    """Create or update a user's settings row (merge on all fields)."""
    with session_scope() as db:
        stmt = select(UserSettings).where(UserSettings.user_id == user_id)
        row = db.execute(stmt).scalar_one_or_none()
        if row is None:
            new_row = UserSettings(id=_new_id(), user_id=user_id)
            db.add(new_row)
            db.flush()
            row = new_row

        llm_api_key = settings.get("llm_api_key")
        assemblyai_key = settings.get("assemblyai_key")
        # Only overwrite a key field when one was actually supplied. A None
        # key in the payload means "leave as-is"; an empty string means
        # "clear it". (The API cannot read existing keys back, so this
        # distinction is what lets clients clear a key.)
        if llm_api_key is not None:
            row.llm_api_key = llm_api_key or None
        if assemblyai_key is not None:
            row.assemblyai_key = assemblyai_key or None
        row.llm_base_url = settings.get("llm_base_url") or None
        row.llm_model = settings.get("llm_model") or None
        transcription_provider = settings.get("transcription_provider")
        if transcription_provider:
            row.transcription_provider = transcription_provider
        db.flush()
        return _row(row)


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


def get_latest_completed_render_job(clip_id: str) -> dict[str, Any] | None:
    """The most recent completed render job for a clip (used to report which
    caption style produced the clip's current rendered file)."""
    with session_scope() as db:
        stmt = (
            select(Job)
            .where(
                Job.clip_id == clip_id,
                Job.status == "completed",
                Job.type == "render",
            )
            .order_by(Job.created_at.desc())
            .limit(1)
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


def set_clip_caption_json(clip_id: str, caption_json: list[dict] | None) -> None:
    with session_scope() as db:
        clip = db.get(Clip, clip_id)
        if clip is not None:
            clip.caption_json = caption_json


# --------------------------------------------------------- timeline words


def add_timeline_words(project_id: str, words: list[dict]) -> None:
    """Bulk-insert absolute-timed words for a project's source video.

    ``words`` is ``[{"text", "start_ms", "end_ms"}, ...]`` in transcript
    order (from ``core.transcriber.TranscriptResult.words``). No-op if
    ``words`` is empty (e.g. a provider that didn't return timings).
    """
    if not words:
        return
    with session_scope() as db:
        for idx, word in enumerate(words):
            db.add(
                TimelineWord(
                    id=_new_id(),
                    project_id=project_id,
                    idx=idx,
                    text=word["text"],
                    start_ms=word["start_ms"],
                    end_ms=word["end_ms"],
                )
            )


def get_timeline_words(project_id: str) -> list[dict[str, Any]]:
    """All words for a project, in transcript order."""
    with session_scope() as db:
        stmt = (
            select(TimelineWord)
            .where(TimelineWord.project_id == project_id)
            .order_by(TimelineWord.idx)
        )
        return [_row(w) for w in db.execute(stmt).scalars().all()]


def delete_timeline_words(project_id: str) -> None:
    """Remove a project's whole word timeline (e.g. before re-inserting it
    on re-analysis)."""
    with session_scope() as db:
        db.query(TimelineWord).filter(
            TimelineWord.project_id == project_id
        ).delete()


def get_timeline_words_in_range(project_id: str, start_ms: int, end_ms: int) -> list[dict[str, Any]]:
    """Words whose span overlaps ``[start_ms, end_ms]``, in transcript order.

    A word is included if any part of it falls inside the range (matches
    on ``start_ms < end_ms`` and ``end_ms > start_ms`` to catch words that
    straddle a clip boundary).
    """
    with session_scope() as db:
        stmt = (
            select(TimelineWord)
            .where(
                TimelineWord.project_id == project_id,
                TimelineWord.start_ms < end_ms,
                TimelineWord.end_ms > start_ms,
            )
            .order_by(TimelineWord.idx)
        )
        return [_row(w) for w in db.execute(stmt).scalars().all()]


# --------------------------------------------------------- caption styles


def list_caption_styles() -> list[dict[str, Any]]:
    with session_scope() as db:
        stmt = select(CaptionStyle).order_by(CaptionStyle.label)
        return [_row(s) for s in db.execute(stmt).scalars().all()]


def get_caption_style(style_id: str) -> dict[str, Any] | None:
    with session_scope() as db:
        return _row(db.get(CaptionStyle, style_id))


def get_caption_style_by_key(key: str) -> dict[str, Any] | None:
    with session_scope() as db:
        stmt = select(CaptionStyle).where(CaptionStyle.key == key)
        return _row(db.execute(stmt).scalar_one_or_none())


def create_caption_style(label: str, config: dict, key: str) -> dict:
    """Insert a user-defined (non-builtin) caption style.

    ``key`` must already be unique (see ``app/api/caption_styles.py`` for
    the slug-plus-suffix generation that guarantees this).
    """
    with session_scope() as db:
        style = CaptionStyle(
            id=_new_id(), key=key, label=label, config=config, is_builtin=False
        )
        db.add(style)
        db.flush()
        return _row(style)


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
        stmt = select(Project).where(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.deleted_at.is_(None),
        )
        return _row(db.execute(stmt).scalar_one_or_none())


def list_projects_for_user(user_id: str) -> list[dict[str, Any]]:
    """Live (non-deleted) projects for a user, newest first, with clip_count
    and latest_job."""
    with session_scope() as db:
        stmt = (
            select(Project)
            .where(Project.user_id == user_id, Project.deleted_at.is_(None))
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
        stmt = select(Project).where(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.deleted_at.is_(None),
        )
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


def delete_project(project_id: str) -> None:
    """Soft-delete a project: stamp ``deleted_at`` so it disappears from all
    listings/API. Rows (clips/jobs/words), storage accounting and S3 objects
    are left untouched."""
    with session_scope() as db:
        project = db.get(Project, project_id)
        if project is not None and project.deleted_at is None:
            project.deleted_at = func.now()


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
    allowed = {"title", "source", "source_type", "source_key", "language", "status",
               "source_size_bytes", "storage_bytes"}
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
    caption_json: list[dict] | None = None,
) -> str:
    """Insert a clip. ``video_url`` is None until a render job cuts it —
    previews seek the project's source video to [start, end] until then.
    ``caption_json`` is the clip-relative word timing list used for
    TikTok-style captions (computed at analyze time)."""
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
                caption_json=caption_json,
            )
        )
        return clip_id
