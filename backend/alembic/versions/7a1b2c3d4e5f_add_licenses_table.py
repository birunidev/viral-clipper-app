"""add licenses table for desktop unlimited

Revision ID: 7a1b2c3d4e5f
Revises: 592afdb0ea21
Create Date: 2026-08-28

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7a1b2c3d4e5f"
down_revision: Union[str, None] = "592afdb0ea21"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS licenses (
            id TEXT PRIMARY KEY,
            license_key TEXT UNIQUE NOT NULL,
            email TEXT,
            user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            is_valid BOOLEAN NOT NULL DEFAULT true,
            tier TEXT NOT NULL DEFAULT 'unlimited',
            expires_at TIMESTAMPTZ,
            metadata JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ix_licenses_license_key ON licenses(license_key);
        CREATE INDEX IF NOT EXISTS ix_licenses_email ON licenses(email);
        CREATE INDEX IF NOT EXISTS ix_licenses_user_id ON licenses(user_id);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS licenses;")
