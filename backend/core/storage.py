"""Per-user S3 storage quota (100MB cap).

Storage is accounted as a denormalized running total on ``users``
(``storage_used_bytes``), updated beside every S3 write in the pipeline and
API. This module owns the cap constant and the helpers used to enforce it.

Write sites that must enforce the cap:
- presigned direct uploads (quota pre-check in the API + client-side size
  check in the browser, since the backend never sees the bytes)
- YouTube source download in the analyze job (checked right after download,
  before the S3 upload)
Rendered clips and thumbnails are derived from an already-counted source
video and are small, so they're not pre-checked — they just bump the total.

Because the direct-upload path can't know the final size ahead of time, the
cap is also re-enforced the moment a project is created from an uploaded
file (source_size_bytes = file size).
"""

from __future__ import annotations

from app import db

# The per-user storage cap in bytes. Single source of truth for the whole
# app (backend enforcement + the frontend display).
STORAGE_CAP_BYTES = 100 * 1024 * 1024  # 100 MB

# Headroom reserved when pre-checking a presigned upload whose final size
# is unknown: we only reject if the user has less than this much room left,
# rather than requiring the (unknowable) exact fit.
UPLOAD_HEADROOM_BYTES = 5 * 1024 * 1024  # 5 MB


class StorageQuotaExceeded(Exception):
    """Raised when an operation would exceed the per-user storage cap."""

    def __init__(self, used_bytes: int, cap_bytes: int = STORAGE_CAP_BYTES):
        self.used_bytes = used_bytes
        self.cap_bytes = cap_bytes
        super().__init__(
            f"Storage limit reached ({used_bytes} of {cap_bytes} bytes used). "
            "Delete a project to free up space."
        )


def storage_used(user_id: str) -> int:
    """Current stored bytes for ``user_id`` (0 when the row is missing)."""
    user = db.get_user(user_id)
    return int(user.get("storage_used_bytes") or 0) if user else 0


def storage_remaining(user_id: str) -> int:
    """Bytes of quota left before ``user_id`` hits the cap."""
    return max(0, STORAGE_CAP_BYTES - storage_used(user_id))


def enforce_cap(user_id: str, additional_bytes: int) -> None:
    """Raise ``StorageQuotaExceeded`` if adding ``additional_bytes`` would
    push ``user_id`` past the cap. Call BEFORE the S3 write."""
    if additional_bytes <= 0:
        return
    used = storage_used(user_id)
    if used + additional_bytes > STORAGE_CAP_BYTES:
        raise StorageQuotaExceeded(used + additional_bytes)


def add_storage(user_id: str, delta_bytes: int) -> None:
    """Add ``delta_bytes`` to the user's running total (negative to free).
    Never drops below zero."""
    if delta_bytes == 0:
        return
    db.increment_user_storage(user_id, delta_bytes)


def add_project_storage(project_id: str, user_id: str, delta_bytes: int) -> None:
    """Add ``delta_bytes`` to both the user's running total and the
    project's own accounting (so a whole-project delete frees exactly what
    it used)."""
    if delta_bytes == 0:
        return
    add_storage(user_id, delta_bytes)
    db.increment_project_storage(project_id, delta_bytes)


def has_storage_room(user_id: str, additional_bytes: int) -> bool:
    """Return True if adding ``additional_bytes`` would keep the user under
    the 100MB cap. Used before uploading thumbnails when rendering is over
    cap."""
    if additional_bytes <= 0:
        return True
    used = storage_used(user_id)
    return used + additional_bytes <= STORAGE_CAP_BYTES