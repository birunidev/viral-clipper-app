"""projects.soft_delete: add projects.deleted_at

Revision ID: d2e3f4a5b6c7
Revises: e5f6d7a8b9c0
Create Date: 2026-08-26 12:00:00.000000

Soft delete for projects: ``deleted_at`` is NULL for live rows and set to
the deletion timestamp for hidden ones. Rows, clips, jobs and S3 objects
stay in place.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d2e3f4a5b6c7"
down_revision: Union[str, None] = "e5f6d7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("deleted_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("projects", "deleted_at")
