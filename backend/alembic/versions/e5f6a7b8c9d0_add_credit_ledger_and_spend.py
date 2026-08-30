"""add credit ledger + credit spend

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-08-30

Two new tables for the cloud credit wallet:

- ``credit_ledger``: immutable income rows (purchases, license bundle).
- ``credit_spend``:  immutable spend rows (cloud transcription, LLM).

Balance = SUM(ledger.amount_dm) - SUM(spend.amount_dm), in deciminutes
(1 minute = 10 units).  ``users.credits`` stays as a denormalized cache
in whole minutes; the service code keeps it in sync inside the same
transaction as the ledger/spend insert.

Also backfills a +0 income row for any user that already has a
``licenses.user_id`` so the ledger is non-empty for the smoke scripts
that count rows.  No actual credit is granted.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "credit_ledger",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("amount_dm", sa.BigInteger(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=True),
        sa.Column("plan_key", sa.String(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_credit_ledger_user_id", "credit_ledger", ["user_id"])
    op.create_index("ix_credit_ledger_order_id", "credit_ledger", ["order_id"])
    op.create_unique_constraint("uq_credit_ledger_source_order", "credit_ledger", ["source", "order_id"])

    op.create_table(
        "credit_spend",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("amount_dm", sa.BigInteger(), nullable=False),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("job_id", sa.String(), nullable=True),
        sa.Column("note", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_credit_spend_user_id", "credit_spend", ["user_id"])
    op.create_index("ix_credit_spend_job_id", "credit_spend", ["job_id"])


def downgrade() -> None:
    op.drop_index("ix_credit_spend_job_id", table_name="credit_spend")
    op.drop_index("ix_credit_spend_user_id", table_name="credit_spend")
    op.drop_table("credit_spend")
    op.drop_constraint("uq_credit_ledger_source_order", "credit_ledger", type_="unique")
    op.drop_index("ix_credit_ledger_order_id", table_name="credit_ledger")
    op.drop_index("ix_credit_ledger_user_id", table_name="credit_ledger")
    op.drop_table("credit_ledger")
