"""Add thumb_url to media_stream_history

Revision ID: d52b53f36e51
Revises: 95162e0dd3c7
Create Date: 2025-11-30 13:19:18.259817

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd52b53f36e51'
down_revision = '95162e0dd3c7'
branch_labels = None
depends_on = None


def upgrade():
    # Add thumb_url column to media_stream_history table
    op.add_column('media_stream_history', sa.Column('thumb_url', sa.String(length=500), nullable=True))


def downgrade():
    # Remove thumb_url column from media_stream_history table
    op.drop_column('media_stream_history', 'thumb_url')
