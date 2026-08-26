"""Per-user S3 storage accounting and quota enforcement.

Storage is accounted as a denormalized running total on ``users``
(``storage_used_bytes``), updated beside every S3 write in the pipeline and
API. The quota itself is plan-based (see :mod:`core.billing`): each plan has a
``storage_cap_bytes`` and a user's harness comes from their effective plan
(trial by default, upgraded to their paid plan).

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
from core import billing

# Headroom reserved when pre-checking a presigned upload whose final size
# is unknown: we only reject if the user has less than this much room left,
# rather than requiring the (unknowable) exact fit.
UPLOAD_HEADROOM_BYTES = 5 * 1024 * 1024  # 5 MB


class StorageQuotaExceeded(Exception):
    """Raised when an operation would exceed the user's plan storage cap."""

    def __init__(self, used_bytes: int, cap_bytes: int):
        self.used_bytes = used_bytes
        self.cap_bytes = cap_bytes
        super().__init__(
            f"Storage limit reached ({used_bytes} of {cap_bytes} bytes used). "
            "Delete a project or buy a bigger credit pack to free up space."
        )


def storage_cap(user_id: str) -> int:
    return billing.storage_cap(user_id)


def storage_used(user_id: str) -> int:
    return billing.storage_used(user_id)


def storage_remaining(user_id: str) -> int:
    return billing.storage_remaining(user_id)


def enforce_cap(user_id: str, additional_bytes: int) -> None:
    """Raise ``StorageQuotaExceeded`` if adding ``additional_bytes`` would
    push ``user_id`` past their plan cap. Call BEFORE the S3 write."""
    if additional_bytes <= 0:
        return
    cap = storage_cap(user_id)
    used = storage_used(user_id)
    if used + additional_bytes > cap:
        raise StorageQuotaExceeded(used + additional_bytes, cap)


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
    their plan cap. Used before uploading thumbnails when rendering is over
    cap."""
    if additional_bytes <= 0:
        return True
    cap = storage_cap(user_id)
    used = storage_used(user_id)
    return used + additional_bytes <= cap
