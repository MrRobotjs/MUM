"""add_user_preferences_columns

Revision ID: add_user_prefs
Revises: d52b53f36e51
Create Date: 2025-12-04 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from app.models import JSONEncodedDict


# revision identifiers, used by Alembic.
revision = 'add_user_prefs'
down_revision = 'd52b53f36e51'
branch_labels = None
depends_on = None


def upgrade():
    # Add sync_preferences column to users table
    op.add_column('users', sa.Column('sync_preferences', sa.Boolean(), nullable=False, server_default='0'))

    # Add user_preferences JSON column to users table
    op.add_column('users', sa.Column('user_preferences', JSONEncodedDict(), nullable=True))


def downgrade():
    # Remove columns
    op.drop_column('users', 'user_preferences')
    op.drop_column('users', 'sync_preferences')
