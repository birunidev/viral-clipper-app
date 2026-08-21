"""Per-user Bring-Your-Own-Key (BYOK) settings endpoints.

Users can supply their own LLM (OpenAI-compatible) and AssemblyAI keys so
the app runs without the operator paying for API usage. Keys are encrypted
at rest (core/secrets.py) and are **write-only**: the GET response shows
only ``has_*`` booleans + a masked preview, never plaintext. To clear a
key, PUT an empty string; to leave it untouched, PUT null/omit it.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import UserSettingsResponse, UserSettingsUpdate
from ..security import SessionUser, current_user
from core import secrets, storage

router = APIRouter(prefix="/settings", tags=["settings"])


def _mask(value: str | None) -> str | None:
    """Return a short preview of a key like ``sk-…abc123`` for UI display."""
    if not value:
        return None
    if len(value) <= 6:
        return "••••"
    return f"{value[:3]}…{value[-4:]}"


def _response(user: SessionUser) -> UserSettingsResponse:
    used = storage.storage_used(user.id)
    remaining = storage.storage_remaining(user.id)
    row = db.get_user_settings(user.id)

    if row:
        llm_key = secrets.decrypt_secret(row.get("llm_api_key"))
        aai_key = secrets.decrypt_secret(row.get("assemblyai_key"))
        return UserSettingsResponse(
            transcription_provider=row.get("transcription_provider") or "assemblyai",
            llm_base_url=row.get("llm_base_url"),
            llm_model=row.get("llm_model"),
            has_llm_api_key=bool(llm_key),
            llm_api_key_preview=_mask(llm_key),
            has_assemblyai_key=bool(aai_key),
            assemblyai_key_preview=_mask(aai_key),
            storage_used_bytes=used,
            storage_cap_bytes=storage.STORAGE_CAP_BYTES,
            storage_remaining_bytes=remaining,
        )

    return UserSettingsResponse(
        transcription_provider="assemblyai",
        storage_used_bytes=used,
        storage_cap_bytes=storage.STORAGE_CAP_BYTES,
        storage_remaining_bytes=remaining,
    )


@router.get("", response_model=UserSettingsResponse)
def get_settings(user: SessionUser = Depends(current_user)) -> UserSettingsResponse:
    """Return the current user's BYOK settings (keys masked) + storage usage."""
    return _response(user)


@router.put("", response_model=UserSettingsResponse)
def update_settings(
    payload: UserSettingsUpdate, user: SessionUser = Depends(current_user)
) -> UserSettingsResponse:
    """Save/clear BYOK settings. Validate before persisting so bad combos
    (e.g. assemblyai provider with no key anywhere) fail fast."""
    provider = payload.transcription_provider or "assemblyai"

    # Merge in the stored keys (decrypted) so we can validate the *effective*
    # result, then re-encrypt everything before writing back. An explicit ""
    # (cleared) key must reach upsert as "" so it wipes the stored value,
    # not as None (which means "leave unchanged") — hence no `or None` here.
    existing = db.get_user_settings(user.id) or {}
    current_llm = secrets.decrypt_secret(existing.get("llm_api_key"))
    current_aai = secrets.decrypt_secret(existing.get("assemblyai_key"))

    llm_key = current_llm if payload.llm_api_key is None else payload.llm_api_key
    aai_key = current_aai if payload.assemblyai_key is None else payload.assemblyai_key

    # Only require a transcription key when the provider actually needs one.
    if provider == "assemblyai" and not aai_key:
        raise HTTPException(
            status_code=400,
            detail="AssemblyAI key is required when using the AssemblyAI transcription provider.",
        )

    db.upsert_user_settings(
        user.id,
        {
            "transcription_provider": provider,
            "llm_base_url": payload.llm_base_url,
            "llm_model": payload.llm_model,
            "llm_api_key": secrets.encrypt_secret(llm_key),
            "assemblyai_key": secrets.encrypt_secret(aai_key),
        },
    )
    return _response(user)
