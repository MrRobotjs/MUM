"""add_notifications_table

Revision ID: 95162e0dd3c7
Revises: c8c60172f4fb
Create Date: 2025-11-26 16:26:00.176353

"""
from alembic import op
import sqlalchemy as sa
from app.models import JSONEncodedDict


# revision identifiers, used by Alembic.
revision = '95162e0dd3c7'
down_revision = 'c8c60172f4fb'
branch_labels = None
depends_on = None


def upgrade():
    # Create notifications table
    op.create_table(
        'notifications',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('timestamp', sa.DateTime(), nullable=False),
        sa.Column('notification_type', sa.Enum('USER_LIMIT_WARNING', 'SERVER_NOT_SYNCED', 'SERVER_CONNECTION_FAILED', 'USER_ACCEPTED_INVITE', name='notificationtype'), nullable=False),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('read', sa.Boolean(), nullable=False),
        sa.Column('details', JSONEncodedDict(), nullable=True),
        sa.Column('owner_id', sa.Integer(), nullable=True),
        sa.Column('server_id', sa.Integer(), nullable=True),
        sa.Column('invite_id', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['invite_id'], ['invites.id'], ),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
        sa.ForeignKeyConstraint(['server_id'], ['media_servers.id'], ),
        sa.PrimaryKeyConstraint('id')
    )

    # Create indexes
    op.create_index(op.f('ix_notifications_timestamp'), 'notifications', ['timestamp'], unique=False)
    op.create_index(op.f('ix_notifications_notification_type'), 'notifications', ['notification_type'], unique=False)
    op.create_index(op.f('ix_notifications_read'), 'notifications', ['read'], unique=False)


def downgrade():
    # Drop indexes
    op.drop_index(op.f('ix_notifications_read'), table_name='notifications')
    op.drop_index(op.f('ix_notifications_notification_type'), table_name='notifications')
    op.drop_index(op.f('ix_notifications_timestamp'), table_name='notifications')

    # Drop table
    op.drop_table('notifications')
