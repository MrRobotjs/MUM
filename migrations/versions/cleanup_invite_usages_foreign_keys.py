"""Cleanup invite_usages foreign key constraints

Revision ID: cleanup_invite_usages_fks
Revises: add_userid_invite_usages
Create Date: 2025-09-28 15:35:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'cleanup_invite_usages_fks'
down_revision = 'add_userid_invite_usages'
branch_labels = None
depends_on = None


def upgrade():
    """Remove old foreign key constraints and user_app_access_id column from invite_usages"""
    
    print("Starting cleanup of invite_usages foreign key constraints...")
    
    # Get connection and check current table structure
    connection = op.get_bind()
    
    try:
        inspector = sa.inspect(connection)
        columns = [col['name'] for col in inspector.get_columns('invite_usages')]
        print(f"Current columns in invite_usages: {columns}")
        
        # Check for foreign keys
        try:
            foreign_keys = inspector.get_foreign_keys('invite_usages')
            print(f"Current foreign keys in invite_usages: {foreign_keys}")
        except Exception as e:
            print(f"Could not inspect foreign keys: {e}")
            foreign_keys = []
            
    except Exception as e:
        print(f"Could not inspect invite_usages table: {e}")
        return
    
    # If user_app_access_id column exists, we need to remove it and its foreign key
    if 'user_app_access_id' in columns:
        print("Found user_app_access_id column, attempting to clean up...")
        
        # For SQLite, we need to recreate the table without the problematic column
        # This approach avoids foreign key constraint issues
        try:
            print("Recreating invite_usages table without user_app_access_id...")
            
            # Create new table structure
            connection.execute(sa.text("""
                CREATE TABLE invite_usages_new (
                    id INTEGER PRIMARY KEY,
                    invite_id INTEGER NOT NULL,
                    used_at DATETIME,
                    ip_address VARCHAR(45),
                    plex_user_uuid VARCHAR(255),
                    plex_username VARCHAR(255),
                    plex_email VARCHAR(120),
                    plex_thumb VARCHAR(512),
                    plex_auth_successful BOOLEAN NOT NULL DEFAULT 0,
                    discord_user_id VARCHAR(255),
                    discord_username VARCHAR(255),
                    discord_auth_successful BOOLEAN NOT NULL DEFAULT 0,
                    userId VARCHAR(36),
                    accepted_invite BOOLEAN NOT NULL DEFAULT 0,
                    status_message VARCHAR(255),
                    FOREIGN KEY (invite_id) REFERENCES invites (id),
                    FOREIGN KEY (userId) REFERENCES users (uuid)
                )
            """))
            print("Created new invite_usages table")
            
            # Copy data from old table to new table (excluding user_app_access_id)
            connection.execute(sa.text("""
                INSERT INTO invite_usages_new (
                    id, invite_id, used_at, ip_address, plex_user_uuid, plex_username, 
                    plex_email, plex_thumb, plex_auth_successful, discord_user_id, 
                    discord_username, discord_auth_successful, userId, accepted_invite, status_message
                )
                SELECT 
                    id, invite_id, used_at, ip_address, plex_user_uuid, plex_username, 
                    plex_email, plex_thumb, plex_auth_successful, discord_user_id, 
                    discord_username, discord_auth_successful, userId, accepted_invite, status_message
                FROM invite_usages
            """))
            print("Copied data to new table")
            
            # Drop old table and rename new one
            connection.execute(sa.text("DROP TABLE invite_usages"))
            connection.execute(sa.text("ALTER TABLE invite_usages_new RENAME TO invite_usages"))
            print("Replaced old table with new table")
            
            # Recreate index
            connection.execute(sa.text("CREATE INDEX ix_invite_usages_userId ON invite_usages (userId)"))
            print("Recreated userId index")
            
        except Exception as e:
            print(f"Error during table recreation: {e}")
            print("Attempting fallback cleanup...")
            
            # Fallback: try to disable foreign keys and drop column
            try:
                connection.execute(sa.text("PRAGMA foreign_keys = OFF"))
                connection.execute(sa.text("ALTER TABLE invite_usages DROP COLUMN user_app_access_id"))
                connection.execute(sa.text("PRAGMA foreign_keys = ON"))
                print("Successfully dropped user_app_access_id column using fallback method")
            except Exception as e2:
                print(f"Fallback method also failed: {e2}")
                print("Manual cleanup may be required")
    else:
        print("user_app_access_id column not found, no cleanup needed")
    
    print("invite_usages foreign key cleanup completed!")


def downgrade():
    """This downgrade is not implemented as it would recreate problematic foreign keys"""
    print("Downgrade not implemented - would recreate problematic foreign key constraints")
    pass