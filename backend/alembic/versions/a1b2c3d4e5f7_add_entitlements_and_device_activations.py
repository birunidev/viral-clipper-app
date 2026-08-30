"""add entitlements and device_activations tables

Revision ID: a1b2c3d4e5f7
Revises: e1f2a3b4c5d6
Create Date: 2026-08-30

Server-side entitlement (one row per user+license) and per-device
activation table. Replaces the per-key license model for desktop
checks: the desktop authenticates as the user and the server decides
entitlement based on whichever active row matches.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f7"
down_revision: Union[str, None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS entitlements (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
            tier TEXT NOT NULL,
            max_devices INTEGER NOT NULL DEFAULT 3,
            is_active BOOLEAN NOT NULL DEFAULT true,
            revoked_at TIMESTAMPTZ,
            revoked_reason TEXT,
            cache_max_age_days INTEGER NOT NULL DEFAULT 7,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ix_entitlements_user_id ON entitlements(user_id);
        CREATE INDEX IF NOT EXISTS ix_entitlements_license_id ON entitlements(license_id);
        CREATE INDEX IF NOT EXISTS ix_entitlements_active ON entitlements(user_id, is_active);
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS device_activations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device_id TEXT NOT NULL,
            device_name TEXT NOT NULL,
            os TEXT NOT NULL,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            is_revoked BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_device_per_user ON device_activations(user_id, device_id);
        CREATE INDEX IF NOT EXISTS ix_device_activations_user_id ON device_activations(user_id);
        CREATE INDEX IF NOT EXISTS ix_device_activations_device_id ON device_activations(device_id);
        CREATE INDEX IF NOT EXISTS ix_device_activations_last_seen ON device_activations(last_seen_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS device_activations;")
    op.execute("DROP TABLE IF EXISTS entitlements;")
