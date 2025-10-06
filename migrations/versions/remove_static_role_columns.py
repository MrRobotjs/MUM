"""Remove is_home_user and shares_back columns

Revision ID: remove_static_role_columns
Revises: convert_static_roles
Create Date: 2025-10-04

This migration removes the is_home_user and shares_back boolean columns
since they have been replaced by the UserRole system.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'remove_static_role_columns'
down_revision = 'convert_static_roles'
branch_labels = None
depends_on = None


def upgrade():
    """Remove the is_home_user and shares_back columns"""
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('is_home_user')
        batch_op.drop_column('shares_back')

    print("Removed is_home_user and shares_back columns from users table")


def downgrade():
    """Re-add the is_home_user and shares_back columns"""
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('is_home_user', sa.Boolean(), nullable=False, server_default='0'))
        batch_op.add_column(sa.Column('shares_back', sa.Boolean(), nullable=False, server_default='0'))

    print("Re-added is_home_user and shares_back columns to users table")
