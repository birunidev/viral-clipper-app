"""add app_updates table for desktop self-update mechanism

Revision ID: e1f2a3b4c5d6
Revises: 7a1b2c3d4e5f
Create Date: 2026-08-30

Stores metadata for each published app binary (one row per
platform/arch/version/channel).  The actual binary lives in S3 at
``s3_key``; the backend streams it on demand and ``electron-updater``
verifies the file against ``sha512``.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, None] = "7a1b2c3d4e5f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS app_updates (
            id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            platform TEXT NOT NULL,
            arch TEXT NOT NULL,
            release_notes TEXT NOT NULL DEFAULT '',
            sha512 TEXT NOT NULL,
            size_bytes BIGINT NOT NULL DEFAULT 0,
            is_beta BOOLEAN NOT NULL DEFAULT false,
            s3_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ix_app_updates_pac ON app_updates(platform, arch, is_beta);
        CREATE INDEX IF NOT EXISTS ix_app_updates_version ON app_updates(version);
        CREATE INDEX IF NOT EXISTS ix_app_updates_created_at ON app_updates(created_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS app_updates;")
