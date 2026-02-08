"""add auto-managed flag to admin roles

Revision ID: add_auto_managed_admin_roles
Revises: add_auto_managed_user_roles
Create Date: 2025-12-29 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision = 'add_auto_managed_admin_roles'
down_revision = 'add_auto_managed_user_roles'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("admins_roles")}

    if "is_auto_managed" not in columns:
        op.add_column(
            "admins_roles",
            sa.Column("is_auto_managed", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    bind.execute(
        text("""
            UPDATE admins_roles
            SET is_auto_managed = TRUE
            WHERE lower(name) = 'staff'
        """)
    )

    if bind.dialect.name != "sqlite":
        op.alter_column("admins_roles", "is_auto_managed", server_default=None)


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("admins_roles")}
    if "is_auto_managed" in columns:
        op.drop_column("admins_roles", "is_auto_managed")
