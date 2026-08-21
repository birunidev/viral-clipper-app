"""add user_settings (BYOK) and storage accounting columns

Revision ID: a1b2c3d4e5f6
Revises: 9d8e0faf72f5
Create Date: 2026-08-21 12:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "9d8e0faf72f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Per-user Bring-Your-Own-Key (BYOK) settings for LLM + transcription.
    op.create_table(
        "user_settings",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("llm_api_key", sa.String(), nullable=True),
        sa.Column("llm_base_url", sa.String(), nullable=True),
        sa.Column("llm_model", sa.String(), nullable=True),
        sa.Column("transcription_provider", sa.String(), server_default="assemblyai", nullable=False),
        sa.Column("assemblyai_key", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_user_settings_user_id"), "user_settings", ["user_id"], unique=True)

    # Storage accounting live on users/source videos.
    op.add_column("users", sa.Column("storage_used_bytes", sa.BigInteger(), server_default="0", nullable=False))
    op.add_column("projects", sa.Column("source_size_bytes", sa.BigInteger(), nullable=True))
    op.add_column("projects", sa.Column("storage_bytes", sa.BigInteger(), server_default="0", nullable=False))


def downgrade() -> None:
    op.drop_column("projects", "storage_bytes")
    op.drop_column("projects", "source_size_bytes")
    op.drop_column("users", "storage_used_bytes")
    op.drop_index(op.f("ix_user_settings_user_id"), table_name="user_settings")
    op.drop_table("user_settings")