"""Migrate Staff from UserRole to AdminRole

Revision ID: migrate_staff_to_admin_role
Revises: remove_static_role_columns
Create Date: 2025-10-06

This migration moves the Staff role from UserRole (visual/cosmetic) to AdminRole
(permission-based) since it should be an admin role with 0 permissions.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
import uuid

# revision identifiers, used by Alembic.
revision = 'migrate_staff_to_admin_role'
down_revision = 'remove_static_role_columns'
branch_labels = None
depends_on = None


def upgrade():
    """
    1. Create Staff as an AdminRole
    2. Copy user assignments from UserRole to AdminRole
    3. Delete Staff from UserRole
    """
    conn = op.get_bind()

    # Check if Staff exists as a UserRole
    staff_user_role = conn.execute(
        text("SELECT id, name, description, color, icon FROM users_roles WHERE name = 'Staff'")
    ).fetchone()

    if staff_user_role:
        print(f"Found Staff UserRole: {staff_user_role[0]}")

        # Check if Staff already exists as AdminRole
        staff_admin_role_exists = conn.execute(
            text("SELECT id FROM admins_roles WHERE name = 'Staff'")
        ).fetchone()

        if not staff_admin_role_exists:
            # Create Staff as AdminRole with position -1 (lowest)
            new_staff_id = str(uuid.uuid4())
            conn.execute(
                text("""
                    INSERT INTO admins_roles (id, name, description, position, color, icon)
                    VALUES (:id, :name, :description, :position, :color, :icon)
                """),
                {
                    'id': new_staff_id,
                    'name': 'Staff',
                    'description': 'Visual indicator for administrators - automatically assigned to users with admin roles',
                    'position': -1,
                    'color': staff_user_role[3] or '#5865f2',
                    'icon': staff_user_role[4] or 'fa-solid fa-user-tie'
                }
            )
            print(f"Created Staff AdminRole with ID: {new_staff_id}")
        else:
            new_staff_id = staff_admin_role_exists[0]
            print(f"Staff AdminRole already exists with ID: {new_staff_id}")

        # Get users who have Staff UserRole
        user_assignments = conn.execute(
            text("""
                SELECT user_id FROM users_roles_assignments
                WHERE visual_role_id = :role_id
            """),
            {'role_id': staff_user_role[0]}
        ).fetchall()

        print(f"Found {len(user_assignments)} users with Staff UserRole")

        # Move assignments to AdminRole
        for assignment in user_assignments:
            user_id = assignment[0]

            # Check if assignment already exists
            exists = conn.execute(
                text("""
                    SELECT 1 FROM admin_user_roles_assignments
                    WHERE user_id = :user_id AND role_id = :role_id
                """),
                {'user_id': user_id, 'role_id': new_staff_id}
            ).fetchone()

            if not exists:
                conn.execute(
                    text("""
                        INSERT INTO admin_user_roles_assignments (user_id, role_id)
                        VALUES (:user_id, :role_id)
                    """),
                    {'user_id': user_id, 'role_id': new_staff_id}
                )
                print(f"Migrated Staff role for user: {user_id}")

        # Delete Staff UserRole assignments
        conn.execute(
            text("DELETE FROM users_roles_assignments WHERE visual_role_id = :role_id"),
            {'role_id': staff_user_role[0]}
        )
        print(f"Deleted Staff UserRole assignments")

        # Delete Staff UserRole
        conn.execute(
            text("DELETE FROM users_roles WHERE id = :id"),
            {'id': staff_user_role[0]}
        )
        print(f"Deleted Staff UserRole")

    else:
        print("Staff UserRole not found, checking if Staff AdminRole exists...")
        # Ensure Staff AdminRole exists even if UserRole didn't
        staff_admin_role = conn.execute(
            text("SELECT id FROM admins_roles WHERE name = 'Staff'")
        ).fetchone()

        if not staff_admin_role:
            new_staff_id = str(uuid.uuid4())
            conn.execute(
                text("""
                    INSERT INTO admins_roles (id, name, description, position, color, icon)
                    VALUES (:id, :name, :description, :position, :color, :icon)
                """),
                {
                    'id': new_staff_id,
                    'name': 'Staff',
                    'description': 'Visual indicator for administrators - automatically assigned to users with admin roles',
                    'position': -1,
                    'color': '#5865f2',
                    'icon': 'fa-solid fa-user-tie'
                }
            )
            print(f"Created Staff AdminRole with ID: {new_staff_id}")
        else:
            print(f"Staff AdminRole already exists")


def downgrade():
    """
    Move Staff back from AdminRole to UserRole
    """
    conn = op.get_bind()

    # Get Staff AdminRole
    staff_admin_role = conn.execute(
        text("SELECT id, name, description, color, icon FROM admins_roles WHERE name = 'Staff'")
    ).fetchone()

    if staff_admin_role:
        print(f"Found Staff AdminRole: {staff_admin_role[0]}")

        # Create Staff as UserRole
        new_staff_id = str(uuid.uuid4())
        conn.execute(
            text("""
                INSERT INTO users_roles (id, name, description, color, icon, created_at, updated_at)
                VALUES (:id, :name, :description, :color, :icon, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """),
            {
                'id': new_staff_id,
                'name': 'Staff',
                'description': staff_admin_role[2] or 'Visual indicator for users with admin access',
                'color': staff_admin_role[3] or '#6366f1',
                'icon': staff_admin_role[4] or 'fa-solid fa-user-tie'
            }
        )
        print(f"Created Staff UserRole with ID: {new_staff_id}")

        # Get users who have Staff AdminRole
        user_assignments = conn.execute(
            text("""
                SELECT user_id FROM admin_user_roles_assignments
                WHERE role_id = :role_id
            """),
            {'role_id': staff_admin_role[0]}
        ).fetchall()

        # Move assignments to UserRole
        for assignment in user_assignments:
            user_id = assignment[0]
            conn.execute(
                text("""
                    INSERT INTO users_roles_assignments (user_id, visual_role_id)
                    VALUES (:user_id, :visual_role_id)
                """),
                {'user_id': user_id, 'visual_role_id': new_staff_id}
            )

        # Delete Staff AdminRole assignments
        conn.execute(
            text("DELETE FROM admin_user_roles_assignments WHERE role_id = :role_id"),
            {'role_id': staff_admin_role[0]}
        )

        # Delete Staff AdminRole
        conn.execute(
            text("DELETE FROM admins_roles WHERE id = :id"),
            {'id': staff_admin_role[0]}
        )
        print(f"Deleted Staff AdminRole and migrated back to UserRole")
