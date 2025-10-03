"""Create default Staff role for admin users

Revision ID: create_default_staff_role
Revises: implement_discord_style_rbac
Create Date: 2025-01-02 15:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
import uuid

# revision identifiers, used by Alembic.
revision = 'create_default_staff_role'
down_revision = 'implement_discord_style_rbac'
branch_labels = None
depends_on = None


def upgrade():
    """Create the default Staff role"""
    connection = op.get_bind()
    
    try:
        # Check if Staff role already exists
        result = connection.execute(sa.text("SELECT COUNT(*) FROM users_roles WHERE name = 'Staff'"))
        staff_exists = result.scalar() > 0
        
        if not staff_exists:
            # Create the Staff role
            staff_id = str(uuid.uuid4())
            connection.execute(sa.text("""
                INSERT INTO users_roles (id, name, description, color, icon, created_at, updated_at)
                VALUES (:id, :name, :description, :color, :icon, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """), {
                "id": staff_id,
                "name": "Staff",
                "description": "Visual indicator for users with admin access",
                "color": "#6366f1",
                "icon": "fa-solid fa-user-tie"
            })
            print("Created default Staff role")
        else:
            print("Staff role already exists, skipping creation")
        
        connection.commit()
        print("Staff role setup completed successfully!")
        
    except Exception as e:
        print(f"Error creating Staff role: {e}")
        connection.rollback()
        raise


def downgrade():
    """Remove the Staff role"""
    connection = op.get_bind()
    
    try:
        # Remove Staff role (but only if no users are assigned to it)
        connection.execute(sa.text("DELETE FROM users_roles WHERE name = 'Staff'"))
        print("Removed Staff role")
        connection.commit()
    except Exception as e:
        print(f"Could not remove Staff role: {e}")
        connection.rollback()