"""add enabled_by_user to plugins

Revision ID: add_plugin_enabled_by_user
Revises: add_owner_role
Create Date: 2026-02-04 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision = "add_plugin_enabled_by_user"
down_revision = "add_owner_role"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "plugins",
        sa.Column("enabled_by_user", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    conn = op.get_bind()
    try:
        conn.execute(
            text("UPDATE plugins SET enabled_by_user = 1 WHERE status != 'disabled'")
        )
    except Exception:
        pass


def downgrade():
    op.drop_column("plugins", "enabled_by_user")
