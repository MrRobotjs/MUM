"""DEPRECATED: Public API v1 invite validation (use /api/v2/invite)."""
from uuid import uuid4

from flask import jsonify

from app.routes.public_api_v1 import bp
from app.models import Invite


def _serialize_invite(invite: Invite):
    return {
        'token': invite.token,
        'custom_path': invite.custom_path,
        'expires_at': invite.expires_at.isoformat() if invite.expires_at else None,
        'max_uses': invite.max_uses,
        'current_uses': invite.current_uses,
        'is_active': invite.is_active,
        'grant_library_ids': invite.grant_library_ids,
        'allow_downloads': invite.allow_downloads,
    }


@bp.route('/public/invite/<token>', methods=['GET'])
def validate_public_invite(token):
    request_id = str(uuid4())
    invite = Invite.query.filter((Invite.token == token) | (Invite.custom_path == token)).first()
    if not invite:
        return jsonify({
            'error': {
                'code': 'INVITE_NOT_FOUND',
                'message': 'Invite not found.'
            },
            'meta': {'request_id': request_id}
        }), 404

    return jsonify({
        'data': _serialize_invite(invite),
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200
