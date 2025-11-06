"""Add revoked_at column to token_blocklist if missing

Revision ID: add_revoked_at_column
Revises: add_token_blocklist
Create Date: 2025-11-05

This migration adds the revoked_at column to token_blocklist table
if it doesn't already exist. This handles cases where the table was
created without this column.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision = 'add_revoked_at_column'
down_revision = 'add_token_blocklist'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)
    
    # Check if token_blocklist table exists
    if not insp.has_table('token_blocklist'):
        return
    
    # Check if revoked_at column is missing
    existing_columns = {col['name'] for col in insp.get_columns('token_blocklist')}
    if 'revoked_at' not in existing_columns:
        conn = op.get_bind()
        
        # SQLite doesn't support adding NOT NULL columns with non-constant defaults
        # Add column as nullable (SQLite limitation - we can't change to NOT NULL after creation)
        conn.execute(text("ALTER TABLE token_blocklist ADD COLUMN revoked_at DATETIME"))
        conn.commit()
        
        # Update existing rows with current timestamp
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        # Format as ISO string for SQLite
        now_str = now.strftime('%Y-%m-%d %H:%M:%S.%f')
        conn.execute(text("UPDATE token_blocklist SET revoked_at = :now WHERE revoked_at IS NULL"), {"now": now_str})
        conn.commit()
        
        # Note: SQLite cannot change a column to NOT NULL after creation
        # The application code will always set revoked_at, so this is acceptable
        # The model defines it as NOT NULL, but SQLite will allow NULLs at the DB level


def downgrade():
    # Don't remove the column in downgrade to avoid data loss
    # If needed, this can be done manually
    pass

