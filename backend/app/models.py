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
    BigInteger,
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
    # Running total of the user's stored bytes in S3 (source videos +
    # rendered clips + thumbnails). Enforced against the per-user storage
    # cap (core/billing.py, plan-based). Kept denormalized for cheap quota
    # checks; use bigint so a high cap / many files can't overflow the int API.
    storage_used_bytes: Mapped[int] = mapped_column(
        BigInteger, server_default="0", nullable=False
    )

    # Credit-based billing (pay-per-clip / per-source-minute). There are no
    # subscriptions or billing periods: ``credits`` is a prepaid balance
    # deducted as source-video minutes are transcribed+analyzed, and
    # ``entitlement_tier`` records the highest credit pack the user has ever
    # bought (permanently unlocks that tier's storage/projects/resolution/
    # watermark). ``plan_key`` stores the pack key from the user's most recent
    # settlement purely for audit (mirrors payment_orders); entitlement always
    # comes from ``entitlement_tier``.
    entitlement_tier: Mapped[str] = mapped_column(
        String, server_default="free", nullable=False
    )
    # Prepaid credit balance in whole source-minutes.
    credits: Mapped[int] = mapped_column(BigInteger, server_default="0", nullable=False)
    plan_key: Mapped[str | None] = mapped_column(String)
    billing_email: Mapped[str | None] = mapped_column(String)

    sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    accounts: Mapped[list["Account"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    projects: Mapped[list["Project"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    settings: Mapped["UserSettings | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )


class UserSettings(Base, TimestampMixin):
    """Per-user Bring-Your-Own-Key (BYOK) settings for LLM + transcription.

    One row per user, created lazily on first save. API-key fields store
    Fernet-encrypted values (see core/secrets.py); empty string means "not
    set", in which case the pipeline falls back to the app's env-configured
    keys. The LLM fields also let users override the OpenAI-compatible
    endpoint/model, so this works with any vendor (OpenAI, DeepSeek, Groq,
    Ollama, ...), not just OpenAI.
    """

    __tablename__ = "user_settings"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )
    llm_api_key: Mapped[str | None] = mapped_column(String)
    llm_base_url: Mapped[str | None] = mapped_column(String)
    llm_model: Mapped[str | None] = mapped_column(String)
    transcription_provider: Mapped[str] = mapped_column(
        String, server_default="assemblyai", nullable=False
    )
    assemblyai_key: Mapped[str | None] = mapped_column(String)

    user: Mapped[User] = relationship(back_populates="settings")


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


class BillingEvent(Base):
    """Idempotency ledger for payment-gateway webhooks (Paddle, Midtrans).

    One row per processed webhook event; ``event_id`` (LS's global unique
    event id) has a UNIQUE index so a redelivered webhook is a no-op instead
    of double-syncing the user's subscription.
    """

    __tablename__ = "billing_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    event_id: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    event_name: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class PaymentOrder(Base):
    """A checkout we initiated (either gateway), for webhook verification.

    Stores the plan and the exact amount *we* quoted at checkout time so a
    payment notification can never grant entitlements by paying less than the
    real price (the notification's ``gross_amount`` is attacker-malleable
    input; this row is ground truth). Also serves as the payment audit trail.
    """

    __tablename__ = "payment_orders"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # "paddle" | "midtrans"
    provider: Mapped[str] = mapped_column(String, nullable=False)
    order_id: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    plan_key: Mapped[str] = mapped_column(String, nullable=False)
    # Amount in the smallest practical unit of ``currency`` (IDR whole rupiah
    # or USD cents) — whatever the gateway quoted.
    gross_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), server_default="USD", nullable=False)
    # pending | settled | failed | expired | refunded
    status: Mapped[str] = mapped_column(String, server_default="pending", nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


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
    # Size in bytes of the stored source video (S3 object size). Used for
    # per-user storage accounting against the 100MB cap; 0/None = unknown.
    source_size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    # Total S3 bytes accounted to this project (source + rendered clips +
    # thumbnails). Mirrors the user's running total so a whole-project delete
    # can free exactly the right amount.
    storage_bytes: Mapped[int] = mapped_column(BigInteger, server_default="0", nullable=False)
    # Spoken language of the source, ISO 639-1 (e.g. "id"). Detected from
    # source metadata / the transcription provider and used to write
    # titles/hooks in the transcript's language.
    language: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, server_default="idle", nullable=False)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )

    user: Mapped[User] = relationship(back_populates="projects")
    clips: Mapped[list["Clip"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    timeline_words: Mapped[list["TimelineWord"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


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
    # Clip-relative word timings [{"text", "start_ms", "end_ms"}, ...] used
    # for TikTok-style word-by-word captions. Computed once at analyze time;
    # burned into the rendered clip only when a caption style is requested.
    caption_json: Mapped[list | None] = mapped_column(JSON)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    project: Mapped[Project] = relationship(back_populates="clips")
    job: Mapped[Job | None] = relationship(back_populates="clips")


class TimelineWord(Base):
    """A single spoken word with its absolute timestamp in the source video.

    Populated once per project during the analyze job (from whichever
    transcription provider is active), shared by every clip so caption
    timings can be derived per-clip without re-transcribing.
    """

    __tablename__ = "timeline_words"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(String, nullable=False)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)

    project: Mapped[Project] = relationship(back_populates="timeline_words")


class CaptionStyle(Base):
    """A named, reusable caption style preset (TikTok-style config).

    Seeded with built-in presets; config holds the ASS-style primitives the
    caption builder (core/captions.py) needs: font, size, position, colors,
    outline/shadow, and word-grouping rules.
    """

    __tablename__ = "caption_styles"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    key: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)
    config: Mapped[dict] = mapped_column(JSON, nullable=False)
    is_builtin: Mapped[bool] = mapped_column(Boolean, server_default="true", nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
