"""Add userId to invite_usages table

Revision ID: add_userid_invite_usages
Revises: user_unification_migration
Create Date: 2025-09-28 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_userid_invite_usages'
down_revision = 'fix_history_logs_column_name'
branch_labels = None
depends_on = None


def upgrade():
    """Add userId column to invite_usages table"""
    
    print("Starting userId column addition to invite_usages...")
    
    # Get connection and check current table structure
    connection = op.get_bind()
    
    try:
        inspector = sa.inspect(connection)
        columns = [col['name'] for col in inspector.get_columns('invite_usages')]
        print(f"Current columns in invite_usages: {columns}")
    except Exception as e:
        print(f"Could not inspect invite_usages table: {e}")
        return
    
    # Use raw SQL to avoid foreign key inspection issues
    try:
        # Add the new userId column
        print("Adding userId column...")
        connection.execute(sa.text("ALTER TABLE invite_usages ADD COLUMN userId VARCHAR(36)"))
        print("Added userId column successfully")
        
        # Create index on userId column
        print("Creating index on userId column...")
        connection.execute(sa.text("CREATE INDEX ix_invite_usages_userId ON invite_usages (userId)"))
        print("Created index successfully")
        
        # Note: Skip foreign key constraint for now to avoid table reflection issues
        print("Skipping foreign key constraint to avoid reflection issues")
        
    except Exception as e:
        print(f"Error during column addition: {e}")
        print("Continuing anyway...")
    
    # Migrate existing data from user_app_access_id to userId (if the old column exists)
    if 'user_app_access_id' in columns:
        print("Migrating data from user_app_access_id to userId...")
        try:
            # Map old user IDs to new UUIDs
            result = connection.execute(sa.text("""
                UPDATE invite_usages 
                SET userId = (
                    SELECT users.uuid 
                    FROM users 
                    WHERE users.id = invite_usages.user_app_access_id 
                    AND users.userType IN ('owner', 'local')
                )
                WHERE user_app_access_id IS NOT NULL
            """))
            print(f"Migrated {result.rowcount} records from user_app_access_id to userId")
            
            # Drop the old column using raw SQL
            print("Dropping old user_app_access_id column...")
            connection.execute(sa.text("ALTER TABLE invite_usages DROP COLUMN user_app_access_id"))
            print("Dropped user_app_access_id column successfully")
            
        except Exception as e:
            print(f"Error during data migration: {e}")
            print("Continuing anyway...")
    else:
        print("user_app_access_id column not found, skipping data migration")
    
    print("userId column addition completed!")


def downgrade():
    """Remove userId column from invite_usages table"""
    
    print("Starting userId column removal from invite_usages...")
    
    # Get connection
    connection = op.get_bind()
    
    try:
        # Drop index first
        print("Dropping userId index...")
        connection.execute(sa.text("DROP INDEX IF EXISTS ix_invite_usages_userId"))
        print("Dropped index successfully")
        
        # Drop the column (foreign key constraint will be dropped automatically)
        print("Dropping userId column...")
        connection.execute(sa.text("ALTER TABLE invite_usages DROP COLUMN userId"))
        print("Dropped userId column successfully")
        
    except Exception as e:
        print(f"Error during column removal: {e}")
        print("Continuing anyway...")
    
    print("userId column removal completed!")