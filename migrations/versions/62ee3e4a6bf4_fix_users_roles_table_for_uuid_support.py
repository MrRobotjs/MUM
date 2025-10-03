"""Fix users_roles table for UUID support

Revision ID: 62ee3e4a6bf4
Revises: create_default_staff_role
Create Date: 2025-10-02 21:39:50.864161

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '62ee3e4a6bf4'
down_revision = 'create_default_staff_role'
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
