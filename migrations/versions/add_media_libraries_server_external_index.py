"""Add index for media_libraries server_id and external_id lookup

Revision ID: add_media_libraries_index
Revises: 6b173daf0089
Create Date: 2025-09-29 16:45:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_media_libraries_index'
down_revision = '7c8d9e0f1a2b'
branch_labels = None
depends_on = None


def upgrade():
    # Create index for faster lookups during Kavita ID conversion
    op.create_index(
        'idx_media_libraries_server_external',
        'media_libraries',
        ['server_id', 'external_id'],
        unique=False
    )


def downgrade():
    # Remove the index if rolling back
    op.drop_index('idx_media_libraries_server_external', table_name='media_libraries')