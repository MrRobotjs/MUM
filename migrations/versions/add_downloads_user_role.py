"""add Downloads user role

Revision ID: add_downloads_role
Revises: add_invite_server_features
Create Date: 2025-12-29 00:00:00.000000
"""
from alembic import op
from sqlalchemy import text
import uuid


# revision identifiers, used by Alembic.
revision = 'add_downloads_role'
down_revision = 'add_invite_server_features'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()

    downloads_role_id = str(uuid.uuid4())
    downloads_role = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Downloads'")
    ).fetchone()

    if not downloads_role:
        conn.execute(
            text("""
                INSERT INTO users_roles (id, name, description, color, icon, created_at, updated_at)
                VALUES (:id, :name, :description, :color, :icon, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """),
            {
                'id': downloads_role_id,
                'name': 'Downloads',
                'description': 'User can download or sync content from the server',
                'color': '#3b82f6',
                'icon': 'fa-solid fa-download',
            }
        )
    else:
        downloads_role_id = downloads_role[0]

    users_with_downloads = conn.execute(
        text("""
            SELECT u.uuid
            FROM users u
            JOIN media_servers s ON s.id = u.server_id
            WHERE u."userType" = 'SERVICE'
              AND u.allow_downloads = TRUE
              AND s.service_type IN ('plex', 'jellyfin', 'emby')
        """)
    ).fetchall()

    for user in users_with_downloads:
        user_uuid = user[0]
        exists = conn.execute(
            text("""
                SELECT 1 FROM users_roles_assignments
                WHERE user_id = :user_id AND visual_role_id = :visual_role_id
            """),
            {'user_id': user_uuid, 'visual_role_id': downloads_role_id}
        ).fetchone()
        if not exists:
            conn.execute(
                text("""
                    INSERT INTO users_roles_assignments (user_id, visual_role_id)
                    VALUES (:user_id, :visual_role_id)
                """),
                {'user_id': user_uuid, 'visual_role_id': downloads_role_id}
            )


def downgrade():
    conn = op.get_bind()
    downloads_role = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Downloads'")
    ).fetchone()

    if downloads_role:
        conn.execute(
            text("DELETE FROM users_roles_assignments WHERE visual_role_id = :visual_role_id"),
            {'visual_role_id': downloads_role[0]}
        )
        conn.execute(
            text("DELETE FROM users_roles WHERE id = :id"),
            {'id': downloads_role[0]}
        )
