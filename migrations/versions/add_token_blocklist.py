"""Add token_blocklist table for JWT revocation

Revision ID: add_token_blocklist
Revises: migrate_staff_to_admin_role
Create Date: 2025-11-01
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_token_blocklist'
# Align to existing database head to allow upgrade path
down_revision = '93d4674ba5d5'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Create table if it doesn't already exist
    if not insp.has_table('token_blocklist'):
        op.create_table(
            'token_blocklist',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('jti', sa.String(length=36), nullable=False, unique=True),
            sa.Column('token_type', sa.String(length=10), nullable=False),
            sa.Column('user_uuid', sa.String(length=36), nullable=True),
            sa.Column('revoked_at', sa.DateTime(), nullable=False),
            sa.Column('expires_at', sa.DateTime(), nullable=True),
        )
    else:
        # Table exists - the revoked_at column will be added by a later migration
        # (add_revoked_at_column) to handle SQLite limitations properly
        pass

    # Ensure indexes exist
    existing_indexes = {idx['name'] for idx in insp.get_indexes('token_blocklist')}
    if 'ix_token_blocklist_jti' not in existing_indexes:
        op.create_index('ix_token_blocklist_jti', 'token_blocklist', ['jti'], unique=True)
    if 'ix_token_blocklist_user_uuid' not in existing_indexes:
        op.create_index('ix_token_blocklist_user_uuid', 'token_blocklist', ['user_uuid'], unique=False)


def downgrade():
    op.drop_index('ix_token_blocklist_user_uuid', table_name='token_blocklist')
    op.drop_index('ix_token_blocklist_jti', table_name='token_blocklist')
    op.drop_table('token_blocklist')
