"""add multi-gateway billing (midtrans) columns and payment_orders table

Revision ID: b7c8d9e0f1a2
Revises: f5e6d7c8b9a1
Create Date: 2026-08-25 12:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, None] = "f5e6d7c8b9a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "payment_orders",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("plan_key", sa.String(), nullable=False),
        sa.Column("gross_amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("status", sa.String(), server_default="pending", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_payment_orders_user_id"), "payment_orders", ["user_id"])
    op.create_index(op.f("ix_payment_orders_order_id"), "payment_orders", ["order_id"], unique=True)

    op.add_column("users", sa.Column("payment_provider", sa.String(), server_default="lemonsqueezy", nullable=False))
    op.add_column("users", sa.Column("plan_key", sa.String(), nullable=True))
    op.add_column("users", sa.Column("midtrans_order_id", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "midtrans_order_id")
    op.drop_column("users", "plan_key")
    op.drop_column("users", "payment_provider")
    op.drop_index(op.f("ix_payment_orders_order_id"), table_name="payment_orders")
    op.drop_index(op.f("ix_payment_orders_user_id"), table_name="payment_orders")
    op.drop_table("payment_orders")
