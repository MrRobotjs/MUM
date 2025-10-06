"""Convert static roles to user roles

Revision ID: convert_static_roles
Revises: 6b59fc2adbc1
Create Date: 2025-10-04

This migration converts the is_home_user and shares_back boolean flags
into proper UserRole assignments.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
import uuid

# revision identifiers, used by Alembic.
revision = 'convert_static_roles'
down_revision = '6b59fc2adbc1'
branch_labels = None
depends_on = None


def upgrade():
    """
    1. Create UserRole records for "Home User" and "Shares Back"
    2. Assign these roles to users based on their boolean flags
    """
    conn = op.get_bind()

    # Generate UUIDs for the new roles
    home_user_role_id = str(uuid.uuid4())
    shares_back_role_id = str(uuid.uuid4())

    # Check if roles already exist
    home_user_exists = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Home User'")
    ).fetchone()

    shares_back_exists = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Shares Back'")
    ).fetchone()

    # Create "Home User" role if it doesn't exist
    if not home_user_exists:
        conn.execute(
            text("""
                INSERT INTO users_roles (id, name, description, color, icon, created_at, updated_at)
                VALUES (:id, :name, :description, :color, :icon, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """),
            {
                'id': home_user_role_id,
                'name': 'Home User',
                'description': 'Plex Home User with managed access',
                'color': '#a855f7',  # Purple color
                'icon': 'fa-solid fa-home'
            }
        )
        print(f"Created 'Home User' role with ID: {home_user_role_id}")
    else:
        home_user_role_id = home_user_exists[0]
        print(f"'Home User' role already exists with ID: {home_user_role_id}")

    # Create "Shares Back" role if it doesn't exist
    if not shares_back_exists:
        conn.execute(
            text("""
                INSERT INTO users_roles (id, name, description, color, icon, created_at, updated_at)
                VALUES (:id, :name, :description, :color, :icon, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """),
            {
                'id': shares_back_role_id,
                'name': 'Shares Back',
                'description': 'User shares their library back with you',
                'color': '#22c55e',  # Green color
                'icon': 'fa-solid fa-share'
            }
        )
        print(f"Created 'Shares Back' role with ID: {shares_back_role_id}")
    else:
        shares_back_role_id = shares_back_exists[0]
        print(f"'Shares Back' role already exists with ID: {shares_back_role_id}")

    # Assign "Home User" role to all users where is_home_user = True
    home_users = conn.execute(
        text("SELECT uuid FROM users WHERE is_home_user = 1")
    ).fetchall()

    for user in home_users:
        user_uuid = user[0]
        # Check if assignment already exists
        exists = conn.execute(
            text("""
                SELECT 1 FROM users_roles_assignments
                WHERE user_id = :user_id AND visual_role_id = :visual_role_id
            """),
            {'user_id': user_uuid, 'visual_role_id': home_user_role_id}
        ).fetchone()

        if not exists:
            conn.execute(
                text("""
                    INSERT INTO users_roles_assignments (user_id, visual_role_id)
                    VALUES (:user_id, :visual_role_id)
                """),
                {'user_id': user_uuid, 'visual_role_id': home_user_role_id}
            )

    print(f"Assigned 'Home User' role to {len(home_users)} users")

    # Assign "Shares Back" role to all users where shares_back = True
    shares_back_users = conn.execute(
        text("SELECT uuid FROM users WHERE shares_back = 1")
    ).fetchall()

    for user in shares_back_users:
        user_uuid = user[0]
        # Check if assignment already exists
        exists = conn.execute(
            text("""
                SELECT 1 FROM users_roles_assignments
                WHERE user_id = :user_id AND visual_role_id = :visual_role_id
            """),
            {'user_id': user_uuid, 'visual_role_id': shares_back_role_id}
        ).fetchone()

        if not exists:
            conn.execute(
                text("""
                    INSERT INTO users_roles_assignments (user_id, visual_role_id)
                    VALUES (:user_id, :visual_role_id)
                """),
                {'user_id': user_uuid, 'visual_role_id': shares_back_role_id}
            )

    print(f"Assigned 'Shares Back' role to {len(shares_back_users)} users")

    # Note: We keep the is_home_user and shares_back columns for backwards compatibility
    # They can be removed in a future migration if needed


def downgrade():
    """
    Remove the UserRole assignments and delete the roles
    """
    conn = op.get_bind()

    # Get role IDs
    home_user_role = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Home User'")
    ).fetchone()

    shares_back_role = conn.execute(
        text("SELECT id FROM users_roles WHERE name = 'Shares Back'")
    ).fetchone()

    # Remove assignments
    if home_user_role:
        conn.execute(
            text("DELETE FROM users_roles_assignments WHERE visual_role_id = :visual_role_id"),
            {'visual_role_id': home_user_role[0]}
        )
        conn.execute(
            text("DELETE FROM users_roles WHERE id = :id"),
            {'id': home_user_role[0]}
        )
        print(f"Removed 'Home User' role and its assignments")

    if shares_back_role:
        conn.execute(
            text("DELETE FROM users_roles_assignments WHERE visual_role_id = :visual_role_id"),
            {'visual_role_id': shares_back_role[0]}
        )
        conn.execute(
            text("DELETE FROM users_roles WHERE id = :id"),
            {'id': shares_back_role[0]}
        )
        print(f"Removed 'Shares Back' role and its assignments")
