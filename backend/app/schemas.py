"""Pydantic request/response schemas for the ClipForge REST API."""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

# ------------------------------------------------------------------ auth


class RegisterRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: str
    name: str | None = None
    email: str


# ------------------------------------------------------------------ projects


class ProjectCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    source: str = Field(min_length=1, max_length=1000)
    source_type: str = "youtube"  # youtube | upload
    # For source_type="upload": the size in bytes of the uploaded file, so
    # the storage cap can be enforced/accounted without the backend ever
    # reading the object. 0/omitted = unknown (no accounting).
    source_size_bytes: int = Field(default=0, ge=0)


class ClipDurationRange(BaseModel):
    """Per-run clip length bounds (seconds) handed to the LLM as the source
    of truth for how long each found clip should be."""

    min_clip_seconds: int = Field(default=15, ge=5, le=180)
    max_clip_seconds: int = Field(default=90, ge=10, le=300)

    @model_validator(mode="after")
    def _min_lte_max(self) -> "ClipDurationRange":
        if self.min_clip_seconds > self.max_clip_seconds:
            raise ValueError("min_clip_seconds must be <= max_clip_seconds")
        return self


class JobOptions(ClipDurationRange):
    orientation: str = "portrait"  # portrait | landscape | original
    max_clips: int = Field(default=10, ge=1, le=20)


class StartJobRequest(ClipDurationRange):
    orientation: str = "portrait"
    max_clips: int = Field(default=10, ge=1, le=20)


class RenderClipRequest(BaseModel):
    orientation: str = "portrait"  # portrait | landscape | original
    # Optional caption style to burn in. When omitted, renders without
    # captions; when set, a re-render of an already-rendered clip is
    # allowed (produces a new S3 variant).
    caption_style_id: str | None = None


class ClipResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    viral_hook: str | None = None
    start_time: float
    end_time: float
    # Null until a render job cuts this clip; previews use the project's
    # source_video_url + [start_time, end_time] instead.
    video_url: str | None = None
    thumbnail_url: str | None = None
    # Clip-relative word timings for TikTok-style captions (computed at
    # analyze time; may be None if the provider returned no word timings).
    caption_json: list[dict] | None = None
    created_at: dt.datetime
    # populated server-side:
    signed_video_url: str | None = None
    signed_thumbnail_url: str | None = None
    render_job: dict | None = None
    # The caption style id that produced the current rendered video_url,
    # if any (None when video_url is unset or was rendered without captions).
    caption_style_id: str | None = None


class CaptionStyleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    key: str
    label: str
    config: dict
    is_builtin: bool


class CaptionStyleCreate(BaseModel):
    """A user-defined caption style saved from the in-app style editor.

    ``config`` uses the same primitives as the built-in presets in
    ``app/caption_presets.py`` (font, font_size, colors, position, outline,
    boxed, word-grouping) and is validated by attempting to build a sample
    ASS file before saving.
    """

    label: str = Field(min_length=1, max_length=100)
    config: dict


class JobResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    type: str = "analyze"  # analyze | render
    clip_id: str | None = None
    status: str
    stage: str | None = None
    progress: int
    error: str | None = None
    options: dict | None = None
    created_at: dt.datetime
    updated_at: dt.datetime


class JobWithProjectResponse(JobResponse):
    project: dict | None = None


class ProjectListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    source: str
    source_type: str
    language: str | None = None
    status: str
    created_at: dt.datetime
    clip_count: int = 0
    latest_job: dict | None = None


class TrashListItem(ProjectListItem):
    """A soft-deleted project; ``deleted_at`` drives the 30-day countdown."""

    deleted_at: dt.datetime


class ProjectDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    source: str
    source_type: str
    language: str | None = None
    source_key: str | None = None
    status: str
    created_at: dt.datetime
    # signed URL of the canonical source video (used for clip previews)
    source_video_url: str | None = None
    clips: list[ClipResponse] = []
    jobs: list[JobResponse] = []


# ------------------------------------------------------------------ uploads


class PresignRequest(BaseModel):
    file_name: str = Field(min_length=1, max_length=300)
    content_type: str = "application/octet-stream"


class PresignResponse(BaseModel):
    url: str
    key: str


# ------------------------------------------------------------------ settings (BYOK)


class UserSettingsResponse(BaseModel):
    """Per-user BYOK settings as exposed to the frontend. API keys are
    write-only: the response carries only ``has_*`` booleans and a masked
    preview, never the plaintext."""

    transcription_provider: str = "assemblyai"
    llm_base_url: str | None = None
    llm_model: str | None = None
    has_llm_api_key: bool = False
    llm_api_key_preview: str | None = None
    has_assemblyai_key: bool = False
    assemblyai_key_preview: str | None = None
    storage_used_bytes: int = 0
    storage_cap_bytes: int = 0
    storage_remaining_bytes: int = 0


class UserSettingsUpdate(BaseModel):
    """Write-only settings payload. ``None`` leaves a field unchanged; empty
    string clears it. Key fields never echo back — sending ``None`` keeps the
    stored key, sending ``""`` deletes it."""

    transcription_provider: str | None = Field(default=None, pattern="^(assemblyai|local)$")
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    assemblyai_key: str | None = None


# ------------------------------------------------------------------ billing


class CheckoutRequest(BaseModel):
    """Start a one-time checkout for a built-in credit pack key.

    ``timezone`` is the browser's IANA zone (e.g. ``Asia/Jakarta``); Indonesian
    zones route to the Midtrans gateway (IDR), everything else to Paddle.
    Optional — defaults to Paddle. There is no plan/subscription here: a pack
    grants prepaid credits (1 = 1 source minute) plus permanent entitlements.
    """

    plan_key: str = Field(min_length=1, max_length=32)
    timezone: str | None = Field(default=None, max_length=64)


class CheckoutResponse(BaseModel):
    """Provider-dependent checkout payload.

    - Paddle: ``url`` (hosted redirect).
    - Midtrans Snap: ``token`` + ``client_key`` + ``snap_js_url`` (the frontend
      loads snap.js and opens the popup itself — there is no hosted URL).
    """

    provider: str = "paddle"
    url: str | None = None
    token: str | None = None
    client_key: str | None = None
    snap_js_url: str | None = None

