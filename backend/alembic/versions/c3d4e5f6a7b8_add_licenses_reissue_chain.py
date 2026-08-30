"""add licenses reissue chain

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-08-30

Two columns on the existing ``licenses`` table that let a reissue chain
preserve history: ``reissued_from_id`` (FK self) links the replacement
back to the row it superseded, and ``reissued_at`` timestamps the moment
the old row was invalidated.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE licenses
            ADD COLUMN IF NOT EXISTS reissued_from_id TEXT REFERENCES licenses(id) ON DELETE SET NULL;
    """)
    op.execute("""
        ALTER TABLE licenses
            ADD COLUMN IF NOT EXISTS reissued_at TIMESTAMPTZ;
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_licenses_reissued_from_id ON licenses(reissued_from_id);
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_licenses_reissued_from_id;")
    op.execute("ALTER TABLE licenses DROP COLUMN IF EXISTS reissued_at;")
    op.execute("ALTER TABLE licenses DROP COLUMN IF EXISTS reissued_from_id;")
