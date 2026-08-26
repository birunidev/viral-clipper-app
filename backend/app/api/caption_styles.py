"""Caption style endpoints: list presets, and save custom ones from the
in-app caption editor."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import CaptionStyleCreate, CaptionStyleResponse
from ..security import SessionUser, current_user
from core.captions import CaptionBuildError, build_ass
from core.cutter import slugify

router = APIRouter(prefix="/caption-styles", tags=["caption-styles"])

# Sample word list used only to validate a submitted config by attempting
# to build a real ASS file from it before saving — catches bad colors,
# missing fields, etc. up front instead of failing later inside a render job.
_SAMPLE_WORDS = [
    {"text": "Sample", "start_ms": 0, "end_ms": 400},
    {"text": "caption", "start_ms": 450, "end_ms": 800},
    {"text": "preview", "start_ms": 900, "end_ms": 1300},
]


@router.get("", response_model=list[CaptionStyleResponse])
def list_caption_styles(user: SessionUser = Depends(current_user)) -> list[dict]:
    """Return the caller's visible presets (built-in + their own customs)."""
    return db.list_caption_styles(user.id)


@router.post("", response_model=CaptionStyleResponse, status_code=201)
def create_caption_style(
    payload: CaptionStyleCreate, user: SessionUser = Depends(current_user)
) -> dict:
    """Save a custom caption style (e.g. from the in-app style editor).

    Validated by building a sample ASS file from ``config`` before saving,
    so invalid colors/fields are rejected here rather than failing a render
    job later. Styles are private to their creator.
    """
    try:
        build_ass(_SAMPLE_WORDS, payload.config, 720, 1280)
    except CaptionBuildError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid caption style: {exc}")

    base_key = slugify(payload.label) or "custom"
    key = base_key
    suffix = 2
    while db.get_caption_style_by_key(key) is not None:
        key = f"{base_key}-{suffix}"
        suffix += 1

    return db.create_caption_style(payload.label, payload.config, key, user.id)
