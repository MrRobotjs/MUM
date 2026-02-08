"""Create overseerr_user_links table

Revision ID: c8c60172f4fb
Revises: 5a3121afd767
Create Date: 2025-11-14 12:35:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c8c60172f4fb'
down_revision = '5a3121afd767'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'overseerr_user_links',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('plex_user_id', sa.String(length=255), nullable=False),
        sa.Column('plex_username', sa.String(length=255), nullable=False),
        sa.Column('plex_email', sa.String(length=255), nullable=True),
        sa.Column('overseerr_user_id', sa.Integer(), nullable=True),
        sa.Column('overseerr_username', sa.String(length=255), nullable=True),
        sa.Column('overseerr_email', sa.String(length=255), nullable=True),
        sa.Column('server_id', sa.Integer(), nullable=False),
        sa.Column('is_linked', sa.Boolean(), nullable=False, server_default=sa.text('FALSE')),
        sa.Column('last_sync_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['server_id'], ['media_servers.id'], ondelete='CASCADE'),
    )
    op.create_index(
        'ix_overseerr_user_links_server_id',
        'overseerr_user_links',
        ['server_id'],
    )
    op.create_index(
        'ix_overseerr_user_links_plex_user_id',
        'overseerr_user_links',
        ['plex_user_id'],
    )


def downgrade():
    op.drop_index('ix_overseerr_user_links_plex_user_id', table_name='overseerr_user_links')
    op.drop_index('ix_overseerr_user_links_server_id', table_name='overseerr_user_links')
    op.drop_table('overseerr_user_links')
