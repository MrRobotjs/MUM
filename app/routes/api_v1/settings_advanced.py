from uuid import uuid4

from flask import jsonify, request, current_app
from flask_login import login_required, current_user

from app.routes.api_v1 import bp
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import permission_required, log_event


def _serialize_advanced_settings():
    raw_timeout = Setting.get('WTF_CSRF_TIME_LIMIT')
    if raw_timeout is None:
        timeout_minutes = 0
    else:
        timeout_minutes = int(raw_timeout) // 60 if raw_timeout else 0
    return {
        'csrf_token_timeout_minutes': timeout_minutes
    }


@bp.route('/settings/advanced', methods=['GET'])
@login_required
@permission_required('manage_advanced_settings')
def get_advanced_settings():
    request_id = str(uuid4())
    return jsonify({'data': _serialize_advanced_settings(), 'meta': {'request_id': request_id}})


@bp.route('/settings/advanced', methods=['PATCH'])
@login_required
@permission_required('manage_advanced_settings')
def update_advanced_settings():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    timeout_minutes = payload.get('csrf_token_timeout_minutes')
    try:
        timeout_minutes = int(timeout_minutes)
        if timeout_minutes < 0 or timeout_minutes > 1440:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({
            'error': {
                'code': 'INVALID_CSRF_TIMEOUT',
                'message': 'CSRF token timeout must be between 0 and 1440 minutes.'
            },
            'meta': {'request_id': request_id}
        }), 400

    if timeout_minutes == 0:
        Setting.set('WTF_CSRF_TIME_LIMIT', None, SettingValueType.STRING, "CSRF Token Timeout")
        current_app.config['WTF_CSRF_TIME_LIMIT'] = None
    else:
        timeout_seconds = timeout_minutes * 60
        Setting.set('WTF_CSRF_TIME_LIMIT', timeout_seconds, SettingValueType.INTEGER, "CSRF Token Timeout")
        current_app.config['WTF_CSRF_TIME_LIMIT'] = timeout_seconds

    log_event(EventType.SETTING_CHANGE, "Advanced settings updated via API.", admin_id=current_user.id)

    return jsonify({'data': _serialize_advanced_settings(), 'meta': {'request_id': request_id}}), 200

