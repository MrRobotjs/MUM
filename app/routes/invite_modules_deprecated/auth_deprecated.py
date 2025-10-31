"""
DEPRECATED: Public invite authentication initiation.
Replaced by v2 public endpoints used by the SPA:
- POST /api/v2/public/invite/<token>/plex/start
- POST /api/v2/public/invite/<token>/discord/start
"""

import uuid
from flask import redirect, url_for, flash, request, current_app, session, jsonify
from urllib.parse import urlencode
from app.models import User, UserType, Invite, Setting, EventType
from app.utils.helpers import setup_required, log_event
from app.utils.timeout_helper import get_api_timeout
from . import invites_public_bp as invites_bp
import requests

@invites_bp.route('/plex_auth/<int:invite_id>')
@setup_required
def initiate_plex_auth(invite_id):
    """DEPRECATED: Use /api/v2/public/invite/<token>/plex/start from the SPA."""
    return jsonify({'error': {'code': 'DEPRECATED', 'message': 'Use /api/v2/public/invite/<token>/plex/start'}}), 410

@invites_bp.route('/discord_auth/<int:invite_id>')
@setup_required
def initiate_discord_auth(invite_id):
    """DEPRECATED: Use /api/v2/public/invite/<token>/discord/start via wizard."""
    return jsonify({'error': {'code': 'DEPRECATED', 'message': 'Use /api/v2/public/invite/<token>/discord/start'}}), 410
