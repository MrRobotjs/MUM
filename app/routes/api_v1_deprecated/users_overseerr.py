
from uuid import uuid4
from datetime import datetime

from flask import jsonify
from flask_login import login_required

from app.routes.api_v1_deprecated import bp
from app.models_overseerr import OverseerrUserLink
from app.models import User, UserType


def _serialize_overseerr_link(link: OverseerrUserLink):
    return {
        'server_id': link.server_id,
        'server_name': link.server.server_nickname if link.server else None,
        'overseerr_user_id': link.overseerr_user_id,
        'overseerr_username': link.overseerr_username,
        'overseerr_email': link.overseerr_email,
        'is_linked': link.is_linked,
        'last_sync_at': link.last_sync_at.isoformat() if link.last_sync_at else None
    }


@bp.route('/users/<string:user_uuid>/overseerr', methods=['GET'])
@login_required
def get_user_overseerr(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()

    # For service accounts, attempt to use linked parent
    target_uuid = user.linkedUserId if user.userType == UserType.SERVICE else user.uuid
    local_user = User.query.filter_by(uuid=target_uuid).first()

    if not local_user:
        return jsonify({
            'data': [],
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        }), 200

    links = OverseerrUserLink.query.filter_by(plex_user_id=local_user.plex_uuid).all()

    response = {
        'data': [_serialize_overseerr_link(link) for link in links],
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }
    return jsonify(response), 200
