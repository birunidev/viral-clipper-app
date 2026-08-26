"""security hardening: uploads ledger + private caption styles

Revision ID: e6f7a8b9c0d1
Revises: d2e3f4a5b6c7
Create Date: 2026-08-26 12:00:00.000000

Two access-control fixes:

1. ``uploads`` table — ownership ledger for presigned upload keys. Project
   creation now proves the caller owns the key before binding it (and
   minting presigned read URLs for it).
2. ``caption_styles.user_id`` — NULL = built-in (global), non-NULL =
   private to that user. Existing custom styles are left unowned; they
   become invisible-to-others only when re-saved. Builtin seeds stay NULL.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e6f7a8b9c0d1"
down_revision: Union[str, None] = "d2e3f4a5b6c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if not conn.dialect.has_table(conn, "uploads"):
        op.create_table(
            "uploads",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column(
                "user_id",
                sa.String(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("content_type", sa.String()),
            sa.Column("size_bytes", sa.BigInteger()),
            sa.Column("used_project_id", sa.String()),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
    if not any(i["name"] == "ix_uploads_key" for i in insp.get_indexes("uploads")):
        op.create_index("ix_uploads_key", "uploads", ["key"], unique=True)
    if not any(i["name"] == "ix_uploads_user_id" for i in insp.get_indexes("uploads")):
        op.create_index("ix_uploads_user_id", "uploads", ["user_id"])

    if not any(c["name"] == "user_id" for c in insp.get_columns("caption_styles")):
        op.add_column("caption_styles", sa.Column("user_id", sa.String(), nullable=True))
    if not any(i["name"] == "ix_caption_styles_user_id" for i in insp.get_indexes("caption_styles")):
        op.create_index(
            "ix_caption_styles_user_id",
            "caption_styles",
            ["user_id"],
        )
    try:
        op.create_foreign_key(
            "fk_caption_styles_user_id",
            "caption_styles",
            "users",
            ["user_id"],
            ["id"],
            ondelete="CASCADE",
        )
    except Exception:
        pass


def downgrade() -> None:
    op.drop_constraint("fk_caption_styles_user_id", "caption_styles", type_="foreignkey")
    op.drop_index("ix_caption_styles_user_id", table_name="caption_styles")
    op.drop_column("caption_styles", "user_id")
    op.drop_index("ix_uploads_user_id", table_name="uploads")
    op.drop_index("ix_uploads_key", table_name="uploads")
    op.drop_table("uploads")
