"""Placeholder bridge to align DB head 93d4674ba5d5 with repo

Revision ID: 93d4674ba5d5
Revises: migrate_staff_to_admin_role
Create Date: 2025-11-01

This is a no-op migration used to bridge an out-of-band revision present in
the database but missing from the repository. It allows subsequent migrations
to proceed by establishing the expected revision chain.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '93d4674ba5d5'
down_revision = 'migrate_staff_to_admin_role'
branch_labels = None
depends_on = None


def upgrade():
    # No-op: bridge migration only
    pass


def downgrade():
    # No-op: bridge migration only
    pass

