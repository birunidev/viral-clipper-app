"""credit-based billing: replace subscription columns with credits + tier

Revision ID: e5f6d7a8b9c0
Revises: c9d0e1f2a3b4
Create Date: 2026-08-26 12:00:00.000000

Billing moves from monthly subscriptions/passes (Paddle + Midtrans) to a
credit-based pay-per-clip model: no recurring plans, no billing periods.
Removed columns: payment_provider, billing_customer_id,
billing_subscription_id, billing_price_id, midtrans_order_id,
subscription_status, current_period_start, current_period_end,
minutes_used_current_period. Added: entitlement_tier (permanent highest-pack
bought), credits (prepaid balance, 1 = 1 source minute). ``plan_key`` is kept
as the last-purchased pack key for audit.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6d7a8b9c0"
down_revision: Union[str, None] = "c9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DROP = [
    "payment_provider",
    "billing_customer_id",
    "billing_subscription_id",
    "billing_price_id",
    "midtrans_order_id",
    "subscription_status",
    "current_period_start",
    "current_period_end",
    "minutes_used_current_period",
]


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("entitlement_tier", sa.String(), server_default="free", nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("credits", sa.BigInteger(), server_default="0", nullable=False),
    )
    # Free signup grant is applied at create-time in db.create_user; existing
    # rows just start at the default balance. New users get the grant.
    for col in _DROP:
        op.drop_column("users", col)


def downgrade() -> None:
    op.add_column("users", sa.Column("payment_provider", sa.String(), server_default="paddle", nullable=False))
    op.add_column("users", sa.Column("billing_customer_id", sa.String()))
    op.add_column("users", sa.Column("billing_subscription_id", sa.String()))
    op.add_column("users", sa.Column("billing_price_id", sa.String()))
    op.add_column("users", sa.Column("midtrans_order_id", sa.String()))
    op.add_column("users", sa.Column("subscription_status", sa.String(), server_default="none", nullable=False))
    op.add_column("users", sa.Column("current_period_start", sa.DateTime(timezone=True)))
    op.add_column("users", sa.Column("current_period_end", sa.DateTime(timezone=True)))
    op.add_column(
        "users",
        sa.Column("minutes_used_current_period", sa.BigInteger(), server_default="0", nullable=False),
    )
    op.drop_column("users", "credits")
    op.drop_column("users", "entitlement_tier")