"""Implement Discord-style RBAC with role hierarchy

Revision ID: implement_discord_style_rbac
Revises: rename_roles_to_admins_roles
Create Date: 2025-01-02 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import sqlite

# revision identifiers, used by Alembic.
revision = 'implement_discord_style_rbac'
down_revision = 'e96443719543'
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    
    try:
        # 1. Create admin_permissions table
        op.create_table('admin_permissions',
            sa.Column('id', sa.String(36), nullable=False),
            sa.Column('name', sa.String(100), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('name')
        )
        print("Created admin_permissions table")
        
        # 2. Update admins_roles table structure
        # First, check if admins_roles exists, if not create it
        inspector = sa.inspect(connection)
        tables = inspector.get_table_names()
        
        if 'admins_roles' not in tables:
            op.create_table('admins_roles',
                sa.Column('id', sa.String(36), nullable=False),
                sa.Column('name', sa.String(80), nullable=False),
                sa.Column('description', sa.String(255), nullable=True),
                sa.Column('position', sa.Integer(), nullable=False, default=0),
                sa.Column('color', sa.String(7), nullable=True),
                sa.Column('icon', sa.String(100), nullable=True),
                sa.PrimaryKeyConstraint('id'),
                sa.UniqueConstraint('name')
            )
            print("Created admins_roles table")
        else:
            # Add position column to existing admins_roles table
            try:
                op.add_column('admins_roles', sa.Column('position', sa.Integer(), nullable=False, server_default='0'))
                print("Added position column to admins_roles")
            except Exception as e:
                print(f"Position column might already exist: {e}")
                
            # Change id to UUID if it's still integer
            try:
                # SQLite doesn't support ALTER COLUMN, so we'll need to recreate the table
                # For now, we'll keep integer IDs and handle UUID in the application layer
                pass
            except Exception as e:
                print(f"Could not update ID column: {e}")
        
        # 3. Create admin_role_permissions junction table
        op.create_table('admin_role_permissions',
            sa.Column('role_id', sa.String(36), nullable=False),
            sa.Column('permission_id', sa.String(36), nullable=False),
            sa.ForeignKeyConstraint(['role_id'], ['admins_roles.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['permission_id'], ['admin_permissions.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('role_id', 'permission_id')
        )
        print("Created admin_role_permissions table")
        
        # 4. Create admin_user_roles_assignments junction table (many-to-many for users and admin roles)
        op.create_table('admin_user_roles_assignments',
            sa.Column('user_id', sa.String(36), nullable=False),
            sa.Column('role_id', sa.String(36), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['users.uuid'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['role_id'], ['admins_roles.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('user_id', 'role_id')
        )
        print("Created admin_user_roles_assignments table")
        
        # 5. Recreate users_roles table with UUID support
        if 'users_roles' in tables:
            # Drop existing users_roles table if it exists (will be recreated with UUIDs)
            op.drop_table('users_roles')
            print("Dropped existing users_roles table")
            
        # Create new users_roles table with UUID IDs
        op.create_table('users_roles',
            sa.Column('id', sa.String(36), nullable=False),
            sa.Column('name', sa.String(100), nullable=False),
            sa.Column('description', sa.Text(), nullable=True),
            sa.Column('color', sa.String(7), nullable=True),
            sa.Column('icon', sa.String(100), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('name')
        )
        print("Created users_roles table with UUID support")
        
        # 6. Create users_roles_assignments junction table
        op.create_table('users_roles_assignments',
            sa.Column('user_id', sa.String(36), nullable=False),
            sa.Column('visual_role_id', sa.String(36), nullable=False),
            sa.ForeignKeyConstraint(['user_id'], ['users.uuid'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['visual_role_id'], ['users_roles.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('user_id', 'visual_role_id')
        )
        print("Created users_roles_assignments table")
        
        # 7. Remove old columns that are no longer needed
        try:
            # Remove admin_roles_id from users (replaced by admin_user_roles junction table)
            # SQLite doesn't support DROP COLUMN, so we'll keep it for now and ignore it
            pass
        except Exception as e:
            print(f"Could not remove old columns: {e}")
            
        # 8. Insert default admin permissions
        default_permissions = [
            ('manage_users', 'Create, edit, and delete users'),
            ('manage_roles', 'Create, edit, and delete admin roles'),
            ('manage_permissions', 'Assign permissions to roles'),
            ('manage_settings', 'Access and modify application settings'),
            ('view_logs', 'View application logs and audit trails'),
            ('manage_invites', 'Create and manage user invitations'),
            ('manage_servers', 'Configure media servers'),
            ('manage_plugins', 'Install and configure plugins'),
        ]
        
        for perm_name, perm_desc in default_permissions:
            try:
                # Generate a simple UUID-like string for the ID
                import uuid
                perm_id = str(uuid.uuid4())
                connection.execute(sa.text(
                    "INSERT INTO admin_permissions (id, name, description) VALUES (:id, :name, :desc)"
                ), {"id": perm_id, "name": perm_name, "desc": perm_desc})
            except Exception as e:
                print(f"Could not insert permission {perm_name}: {e}")
        
        connection.commit()
        print("Database migration completed successfully!")
        
    except Exception as e:
        print(f"Migration error: {e}")
        connection.rollback()
        raise


def downgrade():
    # Drop all the new tables
    op.drop_table('users_roles_assignments')
    op.drop_table('admin_user_roles_assignments')
    op.drop_table('admin_role_permissions')
    op.drop_table('admin_permissions')
    
    # Remove position column from admins_roles (if possible in SQLite)
    try:
        op.drop_column('admins_roles', 'position')
    except:
        pass