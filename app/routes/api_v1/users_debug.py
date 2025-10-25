from uuid import uuid4

from flask import jsonify
from flask_login import login_required

from app.routes.api_v1 import bp
from app.models import User, UserType
from app.utils.helpers import get_user_by_uuid


@bp.route('/users/<uuid:user_uuid>/debug', methods=['GET'])
@login_required
def get_user_debug_data(user_uuid):
    """Get raw user data for debugging purposes - returns JSON"""
    request_id = str(uuid4())

    # Get user by uuid
    user_obj, user_type = get_user_by_uuid(str(user_uuid))

    if not user_obj:
        return jsonify({
            'error': {
                'code': 'USER_NOT_FOUND',
                'message': f'User not found: {user_uuid}'
            },
            'meta': {'request_id': request_id}
        }), 404

    actual_id = user_obj.id

    if user_type == "user_app_access":
        # This is a local user (unified User model with userType=LOCAL)
        user = User.query.filter_by(userType=UserType.LOCAL, id=actual_id).first()
    elif user_type == "user_media_access":
        # This is a standalone service user (unified User model with userType=SERVICE)
        user = User.query.filter_by(userType=UserType.SERVICE, id=actual_id).first()
        if user:
            user._is_standalone = True
    else:
        return jsonify({
            'error': {
                'code': 'INVALID_USER_TYPE',
                'message': f'Invalid user type: {user_type}'
            },
            'meta': {'request_id': request_id}
        }), 400

    if not user:
        return jsonify({
            'error': {
                'code': 'USER_NOT_FOUND',
                'message': f'User with ID {actual_id} not found'
            },
            'meta': {'request_id': request_id}
        }), 404

    # Build user info
    user_info = {
        'username': user.get_display_name(),
        'user_uuid': str(user.uuid),
        'user_type': user.userType.value if user.userType else None,
    }

    # Add external IDs if this is a standalone service user
    if hasattr(user, '_is_standalone') and user._is_standalone:
        if user.external_user_id:
            user_info['external_user_id'] = user.external_user_id
        if user.external_user_alt_id:
            user_info['external_user_alt_id'] = user.external_user_alt_id
        if user.server:
            user_info['service_type'] = user.server.service_type.value
            user_info['server_name'] = user.server.server_nickname

    # Get service data
    service_data = []

    if hasattr(user, '_is_standalone') and user._is_standalone:
        # For standalone users, the service user itself contains the data
        user_accesses = [user]
    else:
        # For regular users, query by linkedUserId
        user_accesses = User.query.filter_by(userType=UserType.SERVICE, linkedUserId=user.uuid).all()

    for access in user_accesses:
        if access.user_raw_data or access.service_settings:
            service_entry = {
                'server_id': access.server.id,
                'server_name': access.server.server_nickname,
                'service_type': access.server.service_type.value,
                'raw_data': access.user_raw_data,
                'service_settings': access.service_settings
            }
            service_data.append(service_entry)

    return jsonify({
        'data': {
            'user_info': user_info,
            'service_data': service_data,
            'has_data': len(service_data) > 0
        },
        'meta': {'request_id': request_id}
    })
