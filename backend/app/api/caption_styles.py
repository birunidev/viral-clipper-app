"""Caption style endpoints: list built-in presets for the frontend picker."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import db
from ..schemas import CaptionStyleResponse
from ..security import SessionUser, current_user

router = APIRouter(prefix="/caption-styles", tags=["caption-styles"])


@router.get("", response_model=list[CaptionStyleResponse])
def list_caption_styles(user: SessionUser = Depends(current_user)) -> list[dict]:
    """Return all caption style presets (built-in + any custom)."""
    return db.list_caption_styles()
