"""security: store session tokens hashed (sha256) at rest

Revision ID: f3a4b5c6d7e8
Revises: e6f7a8b9c0d1
Create Date: 2026-08-26 12:00:00.000000

Session tokens are bearer credentials; storing them plaintext turns any
read-only database leak into live account takeover. This migration hashes
existing tokens in place (sha256 hex), so current sessions remain valid —
the cookie still carries the raw token, which now hashes to the stored
value.
"""
from __future__ import annotations

import hashlib
import re

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, None] = "e6f7a8b9c0d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# A sha256 hex digest is 64 lowercase hex chars. Raw tokens are
# secrets.token_urlsafe(48) — 64 chars but base64url alphabet, which
# includes '-' and '_'. The odds of a raw token being all-hex are ~4e-39;
# treating 64-hex values as already-hashed is safe.
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, token FROM sessions")).fetchall()
    for row_id, token in rows:
        if token and not _HEX64.match(token):
            hashed = hashlib.sha256(token.encode()).hexdigest()
            conn.execute(
                sa.text("UPDATE sessions SET token = :t WHERE id = :i"),
                {"t": hashed, "i": row_id},
            )


def downgrade() -> None:
    # One-way: hashed tokens cannot be restored to plaintext.
    pass
