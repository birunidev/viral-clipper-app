"""purge orphan licenses (no users yet)

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-08-30

There are no users yet, so any ``licenses`` row with ``user_id IS NULL``
(an old env-allowlist-style "license key without an account") is
unrecoverable.  Purge them now so the new account-bound model has a
clean baseline.  Any related ``entitlements`` and ``device_activations``
go with them (cascade FK).
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Count first so the migration is auditable in the alembic log.
    op.execute("""
        DO $$
        DECLARE
            orphan_count INTEGER;
        BEGIN
            SELECT COUNT(*) INTO orphan_count FROM licenses WHERE user_id IS NULL;
            RAISE NOTICE 'Purging % orphan licenses (user_id IS NULL)', orphan_count;
        END $$;
    """)
    # DELETE — the related entitlements / device_activations rows have
    # ON DELETE CASCADE so they go with the license automatically.
    op.execute("DELETE FROM licenses WHERE user_id IS NULL;")


def downgrade() -> None:
    # No way to restore the deleted license strings.  The downgrade is a
    # documented no-op; restoring a license row here without its original
    # id would just create a different orphan.
    op.execute("DO $$ BEGIN RAISE NOTICE 'downgrade is a no-op: orphan license data is not recoverable'; END $$;")
