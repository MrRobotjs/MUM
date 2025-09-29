"""Add internal_id to media_libraries table

Revision ID: add_internal_id_media_libs
Revises: 6b173daf0089
Create Date: 2025-01-27 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import uuid

# revision identifiers, used by Alembic.
revision = '7c8d9e0f1a2b'
down_revision = '6b173daf0089'
branch_labels = None
depends_on = None


def upgrade():
    # Check if the column already exists (in case of partial migration)
    connection = op.get_bind()
    
    # Check if internal_id column exists
    try:
        result = connection.execute(sa.text("PRAGMA table_info(media_libraries)"))
        columns = [row[1] for row in result.fetchall()]  # Column names are in index 1
        has_internal_id = 'internal_id' in columns
    except:
        has_internal_id = False
    
    # Add the column only if it doesn't exist
    if not has_internal_id:
        op.add_column('media_libraries', sa.Column('internal_id', sa.String(36), nullable=True))
    
    # Populate existing records with UUIDs (only for records that don't have internal_id)
    result = connection.execute(sa.text("SELECT id FROM media_libraries WHERE internal_id IS NULL"))
    libraries = result.fetchall()
    
    # Update each library with a unique internal_id
    for library in libraries:
        internal_id = str(uuid.uuid4())
        connection.execute(
            sa.text("UPDATE media_libraries SET internal_id = :internal_id WHERE id = :id"),
            {"internal_id": internal_id, "id": library.id}
        )
    
    # Create unique index if it doesn't exist
    try:
        op.create_index('idx_media_libraries_internal_id', 'media_libraries', ['internal_id'], unique=True)
    except:
        # Index might already exist, ignore the error
        pass


def downgrade():
    # Remove the index and column
    op.drop_index('idx_media_libraries_internal_id', table_name='media_libraries')
    op.drop_column('media_libraries', 'internal_id')