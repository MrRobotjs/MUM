"""add per-server feature overrides for invites

Revision ID: add_invite_server_features
Revises: add_allow_4k_transcode_invites
Create Date: 2025-12-08 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from datetime import datetime

# revision identifiers, used by Alembic.
revision = 'add_invite_server_features'
down_revision = 'add_allow_4k_transcode_invites'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'invite_server_features',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('invite_id', sa.Integer(), sa.ForeignKey('invites.id'), nullable=False),
        sa.Column('server_id', sa.Integer(), sa.ForeignKey('media_servers.id'), nullable=False),
        sa.Column('allow_downloads', sa.Boolean(), nullable=True),
        sa.Column('invite_to_plex_home', sa.Boolean(), nullable=True),
        sa.Column('allow_live_tv', sa.Boolean(), nullable=True),
        sa.Column('allow_4k_transcode', sa.Boolean(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('invite_id', 'server_id', name='uq_invite_server_feature'),
    )

    # Backfill a default row per invite/server using invite-level flags so existing data keeps parity
    connection = op.get_bind()
    invites = connection.execute(
        sa.text(
            "SELECT id, allow_downloads, invite_to_plex_home, allow_live_tv, allow_4k_transcode FROM invites"
        )
    ).fetchall()
    invite_lookup = {row.id: row for row in invites}
    links = connection.execute(sa.text("SELECT invite_id, server_id FROM invite_servers")).fetchall()

    feature_table = sa.table(
        'invite_server_features',
        sa.column('invite_id', sa.Integer()),
        sa.column('server_id', sa.Integer()),
        sa.column('allow_downloads', sa.Boolean()),
        sa.column('invite_to_plex_home', sa.Boolean()),
        sa.column('allow_live_tv', sa.Boolean()),
        sa.column('allow_4k_transcode', sa.Boolean()),
        sa.column('created_at', sa.DateTime()),
        sa.column('updated_at', sa.DateTime()),
    )

    rows = []
    now = datetime.utcnow()
    for link in links:
        inv = invite_lookup.get(link.invite_id)
        if not inv:
            continue
        rows.append(
            {
                'invite_id': link.invite_id,
                'server_id': link.server_id,
                'allow_downloads': bool(inv.allow_downloads) if inv.allow_downloads is not None else False,
                'invite_to_plex_home': bool(inv.invite_to_plex_home) if inv.invite_to_plex_home is not None else False,
                'allow_live_tv': bool(inv.allow_live_tv) if inv.allow_live_tv is not None else False,
                'allow_4k_transcode': bool(inv.allow_4k_transcode) if inv.allow_4k_transcode is not None else True,
                'created_at': now,
                'updated_at': now,
            }
        )

    if rows:
        op.bulk_insert(feature_table, rows)


def downgrade():
    op.drop_table('invite_server_features')
