"""add allow_4k_transcode to invites

Revision ID: add_allow_4k_transcode_invites
Revises: add_user_prefs
Create Date: 2025-12-05 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_allow_4k_transcode_invites'
down_revision = 'add_user_prefs'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {col['name'] for col in inspector.get_columns('invites')}

    if 'allow_4k_transcode' not in existing_cols:
        op.add_column(
            'invites',
            sa.Column('allow_4k_transcode', sa.Boolean(), nullable=False, server_default=sa.true())
        )
        # Drop the server_default after setting existing rows for cleanliness.
        # SQLite does not support ALTER COLUMN DROP DEFAULT, so guard it.
        if bind.dialect.name != "sqlite":
            op.alter_column('invites', 'allow_4k_transcode', server_default=None)


def downgrade():
    op.drop_column('invites', 'allow_4k_transcode')
