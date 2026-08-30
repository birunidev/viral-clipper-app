"""add password_reset_tokens table

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f7
Create Date: 2026-08-30

Magic-link storage for email-based password reset. Only the SHA-256
of the raw token is persisted; the raw value lives exactly once, in
the email we send.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            ip_address TEXT,
            user_agent TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_token_hash ON password_reset_tokens(token_hash);
        CREATE INDEX IF NOT EXISTS ix_password_reset_user_id ON password_reset_tokens(user_id);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS password_reset_tokens;")
