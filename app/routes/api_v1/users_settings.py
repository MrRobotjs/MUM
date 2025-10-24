
from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required

from app.routes.api_v1 import bp
from app.models import User, UserType
from app.extensions import db
from app.utils.helpers import permission_required


@bp.route('/users/<string:user_uuid>/settings', methods=['GET'])
@login_required
@permission_required('edit_user')
def get_user_settings(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()

    data = {
        'uuid': user.uuid,
        'notes': user.notes,
        'is_active': user.is_active
    }

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200


@bp.route('/users/<string:user_uuid>/settings', methods=['PATCH'])
@login_required
@permission_required('edit_user')
def update_user_settings(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()

    payload = request.get_json() or {}
    notes = payload.get('notes')
    is_active = payload.get('is_active')

    if notes is not None:
        user.notes = notes
    if is_active is not None:
        if user.userType == UserType.OWNER and not is_active:
            return jsonify({
                'error': {
                    'code': 'CANNOT_DEACTIVATE_OWNER',
                    'message': 'Owner account cannot be deactivated.'
                },
                'meta': {'request_id': request_id}
            }), 400
        user.is_active = bool(is_active)

    db.session.commit()

    return jsonify({
        'data': {
            'success': True,
            'notes': user.notes,
            'is_active': user.is_active
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200
