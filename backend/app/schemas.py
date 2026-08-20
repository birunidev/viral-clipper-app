"""Pydantic request/response schemas for the ClipForge REST API."""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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


class JobOptions(BaseModel):
    orientation: str = "portrait"  # portrait | landscape | original
    max_clips: int = Field(default=10, ge=1, le=20)


class StartJobRequest(BaseModel):
    orientation: str = "portrait"
    max_clips: int = Field(default=10, ge=1, le=20)


class RenderClipRequest(BaseModel):
    orientation: str = "portrait"  # portrait | landscape | original


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
    created_at: dt.datetime
    # populated server-side:
    signed_video_url: str | None = None
    signed_thumbnail_url: str | None = None
    render_job: dict | None = None


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
    status: str
    created_at: dt.datetime
    clip_count: int = 0
    latest_job: dict | None = None


class ProjectDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    source: str
    source_type: str
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
