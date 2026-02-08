"""Normalize servicetype enum values to lowercase

Revision ID: 9f2b8d6b2a71
Revises: c8c60172f4fb
Create Date: 2026-02-07 04:20:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = '9f2b8d6b2a71'
down_revision = 'c8c60172f4fb'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'PLEX'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'plex'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'PLEX' TO 'plex';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'EMBY'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'emby'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'EMBY' TO 'emby';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'JELLYFIN'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'jellyfin'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'JELLYFIN' TO 'jellyfin';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'KAVITA'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'kavita'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'KAVITA' TO 'kavita';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'AUDIOBOOKSHELF'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'audiobookshelf'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'AUDIOBOOKSHELF' TO 'audiobookshelf';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'KOMGA'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'komga'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'KOMGA' TO 'komga';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'ROMM'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'romm'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'ROMM' TO 'romm';
          END IF;
        END$$;
        """
    )


def downgrade():
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'plex'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'PLEX'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'plex' TO 'PLEX';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'emby'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'EMBY'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'emby' TO 'EMBY';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'jellyfin'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'JELLYFIN'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'jellyfin' TO 'JELLYFIN';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'kavita'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'KAVITA'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'kavita' TO 'KAVITA';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'audiobookshelf'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'AUDIOBOOKSHELF'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'audiobookshelf' TO 'AUDIOBOOKSHELF';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'komga'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'KOMGA'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'komga' TO 'KOMGA';
          END IF;

          IF EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'romm'
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'servicetype' AND e.enumlabel = 'ROMM'
          ) THEN
            ALTER TYPE servicetype RENAME VALUE 'romm' TO 'ROMM';
          END IF;
        END$$;
        """
    )