"""Merge heads: servicetype enum lowercase + plugin enabled_by_user

Revision ID: 2f3c1b2a4dcd
Revises: 9f2b8d6b2a71, add_plugin_enabled_by_user
Create Date: 2026-02-07 12:40:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = '2f3c1b2a4dcd'
down_revision = ('9f2b8d6b2a71', 'add_plugin_enabled_by_user')
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass