"""SQLAlchemy ORM models for ClipForge.

Owns the Postgres schema previously managed by Prisma (Better Auth user/
session tables + app tables). Column/table names are snake_case to match
SQLAlchemy conventions — the database is reset as part of this migration so
there is no legacy data to preserve.

Tables: users, sessions, accounts, verifications, projects, jobs, clips.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


# ------------------------------------------------------------------ auth


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    email_verified: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String)
    image: Mapped[str | None] = mapped_column(String)

    sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    accounts: Mapped[list["Account"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    projects: Mapped[list["Project"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    token: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    ip_address: Mapped[str | None] = mapped_column(String)
    user_agent: Mapped[str | None] = mapped_column(String)

    user: Mapped[User] = relationship(back_populates="sessions")


class Account(Base, TimestampMixin):
    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False)
    provider_id: Mapped[str] = mapped_column(String, nullable=False)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    access_token: Mapped[str | None] = mapped_column(String)
    refresh_token: Mapped[str | None] = mapped_column(String)
    id_token: Mapped[str | None] = mapped_column(String)
    access_token_expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    refresh_token_expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    scope: Mapped[str | None] = mapped_column(String)
    password: Mapped[str | None] = mapped_column(String)

    user: Mapped[User] = relationship(back_populates="accounts")


class Verification(Base, TimestampMixin):
    __tablename__ = "verifications"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    identifier: Mapped[str] = mapped_column(String, index=True, nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# ------------------------------------------------------------------- app


PROJECT_STATUSES = ("idle", "queued", "running", "completed", "failed")
JOB_STATUSES = ("queued", "running", "completed", "failed")


JOB_TYPE_ANALYZE = "analyze"
JOB_TYPE_RENDER = "render"


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)
    source_type: Mapped[str] = mapped_column(String, server_default="youtube", nullable=False)
    # S3 key of the canonical source video (stored during analysis). The
    # browser seeks into this for previews; render jobs cut from it.
    source_key: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, server_default="idle", nullable=False)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )

    user: Mapped[User] = relationship(back_populates="projects")
    clips: Mapped[list["Clip"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # "analyze" (find viral moments + store source) or "render" (cut one clip).
    type: Mapped[str] = mapped_column(String, server_default=JOB_TYPE_ANALYZE, nullable=False)
    # For render jobs: the clip being cut. Plain string column (no FK) so we
    # avoid a circular FK with clips.job_id.
    clip_id: Mapped[str | None] = mapped_column(String, index=True)
    status: Mapped[str] = mapped_column(String, server_default="queued", nullable=False)
    stage: Mapped[str | None] = mapped_column(String)
    progress: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    error: Mapped[str | None] = mapped_column(String)
    options: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    project: Mapped[Project] = relationship(back_populates="jobs")
    clips: Mapped[list["Clip"]] = relationship(back_populates="job", cascade="all, delete-orphan")


class Clip(Base):
    __tablename__ = "clips"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    job_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("jobs.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    viral_hook: Mapped[str | None] = mapped_column(String)
    start_time: Mapped[float] = mapped_column(Float, nullable=False)
    end_time: Mapped[float] = mapped_column(Float, nullable=False)
    # Null until a render job cuts this clip; then holds the S3 key of the
    # rendered MP4. Until then the clip is previewed by seeking the project's
    # source video to [start_time, end_time].
    video_url: Mapped[str | None] = mapped_column(String)
    thumbnail_url: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    project: Mapped[Project] = relationship(back_populates="clips")
    job: Mapped[Job | None] = relationship(back_populates="clips")
