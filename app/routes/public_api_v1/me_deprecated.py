"""DEPRECATED: Public API v1 user identity endpoint (use /api/v2/session)."""
from uuid import uuid4

from flask import jsonify
from flask_login import login_required, current_user

from app.routes.public_api_v1 import bp
from .auth_deprecated import _serialize_portal_user
from app.utils.helpers import get_csrf_token


@bp.route('/me', methods=['GET'])
@login_required
def current_portal_user():
    request_id = str(uuid4())
    return jsonify({
        'data': {
            'user': _serialize_portal_user(current_user),
            'csrf_token': get_csrf_token()
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200
