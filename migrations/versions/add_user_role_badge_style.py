"""add badge style to user roles

Revision ID: add_user_role_badge_style
Revises: add_auto_managed_admin_roles
Create Date: 2026-01-07 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision = 'add_user_role_badge_style'
down_revision = 'add_auto_managed_admin_roles'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("users_roles")}

    if "badge_style" not in columns:
        op.add_column(
            "users_roles",
            sa.Column("badge_style", sa.String(length=20), nullable=False, server_default="default"),
        )

    bind.execute(
        text("""
            UPDATE users_roles
            SET badge_style = 'default'
            WHERE badge_style IS NULL OR badge_style = ''
        """)
    )

    if bind.dialect.name != "sqlite":
        op.alter_column("users_roles", "badge_style", server_default=None)


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("users_roles")}
    if "badge_style" in columns:
        op.drop_column("users_roles", "badge_style")
