"""swap Lemon Squeezy for Paddle Billing: rename billing id columns

Revision ID: c9d0e1f2a3b4
Revises: b7c8d9e0f1a2
Create Date: 2026-08-25 12:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: Union[str, None] = "b7c8d9e0f1a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Provider-agnostic names: Paddle (and any future MoR gateway) stores its
    # customer/subscription/price ids in these columns.
    op.alter_column("users", "ls_customer_id", new_column_name="billing_customer_id")
    op.alter_column("users", "ls_subscription_id", new_column_name="billing_subscription_id")
    op.alter_column("users", "ls_variant_id", new_column_name="billing_price_id")

    # Default gateway is now Paddle; migrate any pre-existing LS markers.
    op.alter_column(
        "users",
        "payment_provider",
        existing_type=sa.String(),
        server_default="paddle",
    )
    op.execute("UPDATE users SET payment_provider = 'paddle' WHERE payment_provider = 'lemonsqueezy'")


def downgrade() -> None:
    op.execute("UPDATE users SET payment_provider = 'lemonsqueezy' WHERE payment_provider = 'paddle'")
    op.alter_column(
        "users",
        "payment_provider",
        existing_type=sa.String(),
        server_default="lemonsqueezy",
    )
    op.alter_column("users", "billing_price_id", new_column_name="ls_variant_id")
    op.alter_column("users", "billing_subscription_id", new_column_name="ls_subscription_id")
    op.alter_column("users", "billing_customer_id", new_column_name="ls_customer_id")
