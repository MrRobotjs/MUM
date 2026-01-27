"""add Owner user role

Revision ID: add_owner_role
Revises: add_admin_role_badge_style
Create Date: 2026-01-27 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
import uuid


# revision identifiers, used by Alembic.
revision = 'add_owner_role'
down_revision = 'add_admin_role_badge_style'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = {col["name"] for col in inspector.get_columns("users_roles")}

    if "is_auto_managed" not in columns:
        op.add_column(
            "users_roles",
            sa.Column("is_auto_managed", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    owner_role_id = str(uuid.uuid4())
    owner_role = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Owner'")
    ).fetchone()

    if not owner_role:
        conn.execute(
            text(
                """
                INSERT INTO users_roles (id, name, description, color, icon, badge_style, is_auto_managed, created_at, updated_at)
                VALUES (:id, :name, :description, :color, :icon, :badge_style, :is_auto_managed, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """
            ),
            {
                "id": owner_role_id,
                "name": "Owner",
                "description": "Server owner - automatically assigned based on media service ownership",
                "color": "#f59e0b",
                "icon": "fa-solid fa-crown",
                "badge_style": "default",
                "is_auto_managed": True,
            },
        )
    else:
        owner_role_id = owner_role[0]
        conn.execute(
            text("UPDATE users_roles SET is_auto_managed = 1 WHERE id = :id"),
            {"id": owner_role_id},
        )

    owner_service_users = conn.execute(
        text(
            """
            SELECT u.uuid
            FROM users u
            JOIN media_servers s ON s.id = u.server_id
            WHERE u.userType = 'SERVICE'
              AND s.service_type = 'PLEX'
              AND (
                u.service_settings LIKE '%"is_media_server_owner": true%'
                OR u.user_raw_data LIKE '%"is_media_server_owner": true%'
                OR u.service_settings LIKE '%"is_owner": true%'
                OR u.user_raw_data LIKE '%"is_owner": true%'
              )
            """
        )
    ).fetchall()

    for user in owner_service_users:
        user_uuid = user[0]
        exists = conn.execute(
            text(
                """
                SELECT 1 FROM users_roles_assignments
                WHERE user_id = :user_id AND visual_role_id = :visual_role_id
                """
            ),
            {"user_id": user_uuid, "visual_role_id": owner_role_id},
        ).fetchone()
        if not exists:
            conn.execute(
                text(
                    """
                    INSERT INTO users_roles_assignments (user_id, visual_role_id)
                    VALUES (:user_id, :visual_role_id)
                    """
                ),
                {"user_id": user_uuid, "visual_role_id": owner_role_id},
            )


def downgrade():
    conn = op.get_bind()
    owner_role = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Owner'")
    ).fetchone()

    if owner_role:
        conn.execute(
            text("DELETE FROM users_roles_assignments WHERE visual_role_id = :visual_role_id"),
            {"visual_role_id": owner_role[0]},
        )
        conn.execute(
            text("DELETE FROM users_roles WHERE id = :id"),
            {"id": owner_role[0]},
        )
