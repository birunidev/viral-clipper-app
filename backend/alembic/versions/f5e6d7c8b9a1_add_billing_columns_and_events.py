"""add billing (Lemon Squeezy) columns and billing_events table

Revision ID: f5e6d7c8b9a1
Revises: a1b2c3d4e5f6
Create Date: 2026-08-25 12:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f5e6d7c8b9a1"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "billing_events",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("event_name", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_billing_events_event_id"), "billing_events", ["event_id"], unique=True)

    op.add_column("users", sa.Column("ls_customer_id", sa.String(), nullable=True))
    op.add_column("users", sa.Column("ls_subscription_id", sa.String(), nullable=True))
    op.add_column("users", sa.Column("ls_variant_id", sa.String(), nullable=True))
    op.add_column("users", sa.Column("subscription_status", sa.String(), server_default="none", nullable=False))
    op.add_column("users", sa.Column("current_period_start", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("minutes_used_current_period", sa.BigInteger(), server_default="0", nullable=False))
    op.add_column("users", sa.Column("billing_email", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "billing_email")
    op.drop_column("users", "minutes_used_current_period")
    op.drop_column("users", "current_period_end")
    op.drop_column("users", "current_period_start")
    op.drop_column("users", "subscription_status")
    op.drop_column("users", "ls_variant_id")
    op.drop_column("users", "ls_subscription_id")
    op.drop_column("users", "ls_customer_id")
    op.drop_index(op.f("ix_billing_events_event_id"), table_name="billing_events")
    op.drop_table("billing_events")
