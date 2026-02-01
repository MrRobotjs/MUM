from uuid import uuid4

from flask import jsonify, request, current_app
from flask_login import login_required, current_user

from app.routes.api_v1_deprecated import bp
from app.models import Setting
from app.utils.helpers import permission_required
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.extensions import db


def _load_streaming_settings():
    enable_badge = Setting.get('ENABLE_NAVBAR_STREAM_BADGE', 'false').lower() == 'true'
    interval = Setting.get('SESSION_MONITORING_INTERVAL_SECONDS', '30')
    websocket_interval = Setting.get('STREAMING_WEBSOCKET_REFRESH_INTERVAL_SECONDS', '30')
    try:
        interval_value = int(interval)
    except (TypeError, ValueError):
        interval_value = 30
    try:
        websocket_interval_value = int(websocket_interval)
    except (TypeError, ValueError):
        websocket_interval_value = 30

    return {
        'enable_navbar_stream_badge': enable_badge,
        'session_monitoring_interval': interval_value,
        'websocket_refresh_interval': websocket_interval_value
    }


@bp.route('/settings/streaming', methods=['GET'])
@login_required
@permission_required('view_settings')
def api_get_streaming_settings():
    request_id = str(uuid4())
    data = _load_streaming_settings()

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    })


@bp.route('/settings/streaming', methods=['PATCH'])
@login_required
@permission_required('edit_settings')
def api_update_streaming_settings():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    enable_badge = bool(payload.get('enable_navbar_stream_badge', False))
    interval_value = payload.get('session_monitoring_interval')
    websocket_interval_value = payload.get('websocket_refresh_interval')

    if interval_value is None:
        interval_value = _load_streaming_settings()['session_monitoring_interval']
    if websocket_interval_value is None:
        websocket_interval_value = _load_streaming_settings()['websocket_refresh_interval']

    try:
        interval_value = int(interval_value)
    except (TypeError, ValueError):
        return jsonify({
            'error': {
                'code': 'INVALID_INTERVAL',
                'message': 'Session monitoring interval must be an integer.'
            },
            'meta': {'request_id': request_id}
        }), 400

    if interval_value < 5 or interval_value > 300:
        return jsonify({
            'error': {
                'code': 'INTERVAL_OUT_OF_RANGE',
                'message': 'Session monitoring interval must be between 5 and 300 seconds.'
            },
            'meta': {'request_id': request_id}
        }), 400

    try:
        websocket_interval_value = int(websocket_interval_value)
    except (TypeError, ValueError):
        return jsonify({
            'error': {
                'code': 'INVALID_WEBSOCKET_INTERVAL',
                'message': 'WebSocket refresh interval must be an integer.'
            },
            'meta': {'request_id': request_id}
        }), 400

    if websocket_interval_value < 2 or websocket_interval_value > 300:
        return jsonify({
            'error': {
                'code': 'WEBSOCKET_INTERVAL_OUT_OF_RANGE',
                'message': 'WebSocket refresh interval must be between 2 and 300 seconds.'
            },
            'meta': {'request_id': request_id}
        }), 400

    try:
        Setting.set('ENABLE_NAVBAR_STREAM_BADGE', 'true' if enable_badge else 'false')
        Setting.set('SESSION_MONITORING_INTERVAL_SECONDS', str(interval_value))
        Setting.set('STREAMING_WEBSOCKET_REFRESH_INTERVAL_SECONDS', str(websocket_interval_value))

        )

        return jsonify({
            'data': _load_streaming_settings(),
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        })
    except Exception as exc:
        current_app.logger.error(f"Failed to update streaming settings: {exc}")
        return jsonify({
            'error': {
                'code': 'UPDATE_FAILED',
                'message': 'Failed to update streaming settings.'
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/streaming/active', methods=['GET'])
@login_required
@permission_required('view_streaming')
def api_get_active_sessions():
    """Get currently active streaming sessions from all servers"""
    request_id = str(uuid4())

    try:
        # Get formatted sessions from all services (similar to streaming.py route)
        all_servers = MediaServiceManager.get_all_servers()
        sessions = []
        by_server = {}
        by_service = {}

        for server in all_servers:
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                try:
                    server_nickname = server.server_nickname
                    # Use the service's get_formatted_sessions method which returns properly formatted dicts
                    formatted_sessions = service.get_formatted_sessions()
                    sessions.extend(formatted_sessions)

                    # Group by server
                    if formatted_sessions:
                        server_name = server.server_nickname
                        if server_name not in by_server:
                            by_server[server_name] = []
                        by_server[server_name].extend(formatted_sessions)

                        # Group by service
                        service_type = server.service_type.value
                        if service_type not in by_service:
                            by_service[service_type] = []
                        by_service[service_type].extend(formatted_sessions)

                except Exception as e:
                    db.session.rollback()
                    current_app.logger.error(f"Error getting formatted sessions from {server_nickname}: {e}")

        return jsonify({
            'sessions': sessions,
            'total_count': len(sessions),
            'by_server': by_server,
            'by_service': by_service,
            'meta': {
                'request_id': request_id
            }
        })

    except Exception as exc:
        current_app.logger.error(f"Failed to get active sessions: {exc}", exc_info=True)
        return jsonify({
            'error': {
                'code': 'FETCH_FAILED',
                'message': 'Failed to retrieve active sessions.'
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/streaming/terminate', methods=['POST'])
@login_required
@permission_required('terminate_stream')
def api_terminate_session():
    """Terminate an active streaming session"""
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    session_key = payload.get('session_key')
    service_type = payload.get('service_type')
    server_name = payload.get('server_name')
    message = payload.get('message', '')

    if not session_key or not service_type or not server_name:
        return jsonify({
            'error': {
                'code': 'INVALID_PAYLOAD',
                'message': 'session_key, service_type, and server_name are required.'
            },
            'meta': {'request_id': request_id}
        }), 400

    try:
        # Get the specific server
        from app.models_media_services import MediaServer
        server = MediaServer.query.filter_by(
            server_nickname=server_name,
            is_active=True
        ).first()

        if not server:
            return jsonify({
                'error': {
                    'code': 'SERVER_NOT_FOUND',
                    'message': f'Server {server_name} not found or inactive.'
                },
                'meta': {'request_id': request_id}
            }), 404

        # Get the service for this server using MediaServiceFactory
        service = MediaServiceFactory.create_service_from_db(server)

        if not service:
            return jsonify({
                'error': {
                    'code': 'SERVICE_NOT_AVAILABLE',
                    'message': f'Service not available for server {server_name}.'
                },
                'meta': {'request_id': request_id}
            }), 404

        # Terminate the session
        success = service.terminate_session(session_key, message)

        if success:
            )

            return jsonify({
                'data': {
                    'success': True,
                    'message': f'Session terminated successfully'
                },
                'meta': {'request_id': request_id}
            })
        else:
            return jsonify({
                'error': {
                    'code': 'TERMINATION_FAILED',
                    'message': 'Failed to terminate session.'
                },
                'meta': {'request_id': request_id}
            }), 500

    except Exception as exc:
        current_app.logger.error(f"Failed to terminate session: {exc}", exc_info=True)
        return jsonify({
            'error': {
                'code': 'TERMINATION_ERROR',
                'message': str(exc)
            },
            'meta': {'request_id': request_id}
        }), 500