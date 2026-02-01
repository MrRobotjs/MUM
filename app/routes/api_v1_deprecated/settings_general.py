from uuid import uuid4

from flask import jsonify, request, current_app, g
from flask_login import login_required, current_user

from app.routes.api_v1_deprecated import bp
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import permission_required, log_event


def _serialize_general_settings():
    return {
        'app_name': Setting.get('APP_NAME') or current_app.config.get('APP_NAME'),
        'app_base_url': Setting.get('APP_BASE_URL') or current_app.config.get('APP_BASE_URL'),
        'app_local_url': Setting.get('APP_LOCAL_URL') or current_app.config.get('APP_LOCAL_URL'),
        'enable_navbar_stream_badge': Setting.get_bool('ENABLE_NAVBAR_STREAM_BADGE', False),
        'session_monitoring_interval': Setting.get('SESSION_MONITORING_INTERVAL_SECONDS', 30),
        'api_timeout_seconds': Setting.get('API_TIMEOUT_SECONDS', current_app.config.get('API_TIMEOUT_SECONDS', 3))
    }


@bp.route('/settings/general', methods=['GET'])
@login_required
@permission_required('manage_general_settings')
def get_general_settings():
    request_id = str(uuid4())
    return jsonify({'data': _serialize_general_settings(), 'meta': {'request_id': request_id}})


@bp.route('/settings/general', methods=['PATCH'])
@login_required
@permission_required('manage_general_settings')
def update_general_settings():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    app_name = (payload.get('app_name') or '').strip()
    app_base_url = (payload.get('app_base_url') or '').strip()
    app_local_url = (payload.get('app_local_url') or '').strip()
    enable_badge = bool(payload.get('enable_navbar_stream_badge', False))
    session_interval = payload.get('session_monitoring_interval')
    api_timeout = payload.get('api_timeout_seconds')

    if not app_base_url:
        return jsonify({
            'error': {
                'code': 'BASE_URL_REQUIRED',
                'message': 'Application base URL is required.'
            },
            'meta': {'request_id': request_id}
        }), 400

    if not app_base_url.startswith(('http://', 'https://')):
        return jsonify({
            'error': {
                'code': 'BASE_URL_INVALID',
                'message': 'Application base URL must start with http:// or https://.'
            },
            'meta': {'request_id': request_id}
        }), 400

    if app_local_url and not app_local_url.startswith(('http://', 'https://')):
        return jsonify({
            'error': {
                'code': 'LOCAL_URL_INVALID',
                'message': 'Local application URL must start with http:// or https://.'
            },
            'meta': {'request_id': request_id}
        }), 400

    try:
        if session_interval is None:
            raise ValueError
        session_interval = int(session_interval)
        if session_interval < 10 or session_interval > 300:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({
            'error': {
                'code': 'INVALID_MONITOR_INTERVAL',
                'message': 'Session monitoring interval must be between 10 and 300 seconds.'
            },
            'meta': {'request_id': request_id}
        }), 400

    try:
        if api_timeout is None:
            raise ValueError
        api_timeout = int(api_timeout)
        if api_timeout < 1 or api_timeout > 60:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({
            'error': {
                'code': 'INVALID_API_TIMEOUT',
                'message': 'API timeout must be between 1 and 60 seconds.'
            },
            'meta': {'request_id': request_id}
        }), 400

    Setting.set('APP_NAME', app_name or current_app.config.get('APP_NAME'), SettingValueType.STRING, "Application Name")
    Setting.set('APP_BASE_URL', app_base_url.rstrip('/'), SettingValueType.STRING, "Application Base URL")
    Setting.set('APP_LOCAL_URL', app_local_url.rstrip('/') if app_local_url else '', SettingValueType.STRING, "Application Local URL")
    Setting.set('ENABLE_NAVBAR_STREAM_BADGE', enable_badge, SettingValueType.BOOLEAN, "Enable Nav Bar Stream Badge")
    Setting.set('SESSION_MONITORING_INTERVAL_SECONDS', session_interval, SettingValueType.INTEGER, "Session Monitoring Interval")
    Setting.set('API_TIMEOUT_SECONDS', api_timeout, SettingValueType.INTEGER, "API Request Timeout")

    current_app.config['APP_NAME'] = app_name or current_app.config.get('APP_NAME')
    current_app.config['APP_BASE_URL'] = app_base_url.rstrip('/')
    current_app.config['APP_LOCAL_URL'] = app_local_url.rstrip('/') if app_local_url else None
    current_app.config['SESSION_MONITORING_INTERVAL_SECONDS'] = session_interval
    current_app.config['API_TIMEOUT_SECONDS'] = api_timeout
    if hasattr(g, 'app_name'):
        g.app_name = current_app.config['APP_NAME']
    if hasattr(g, 'app_base_url'):
        g.app_base_url = current_app.config['APP_BASE_URL']
    if hasattr(g, 'app_local_url'):
        g.app_local_url = current_app.config['APP_LOCAL_URL']

    log_event(EventType.SETTING_CHANGE, "General application settings updated via API.", admin_id=current_user.id)

    return jsonify({
        'data': _serialize_general_settings(),
        'meta': {'request_id': request_id}
    }), 200

