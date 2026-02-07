from __future__ import annotations

from uuid import uuid4
from flask import jsonify, request, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import Setting, EventType
from app.models_media_services import ServiceType
from app.utils.helpers import log_event
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.extensions import db


settings_tag = Tag(name="Settings", description="Application settings")
streaming_tag = Tag(name="Streaming", description="Streaming settings and status")


def _load_streaming_settings() -> dict:
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
        'session_monitoring_interval': interval_value,
        'websocket_refresh_interval': websocket_interval_value
    }


class StreamingSettingsData(BaseModel):
    session_monitoring_interval: int
    websocket_refresh_interval: int


class StreamingSettingsResponse(BaseModel):
    data: StreamingSettingsData
    meta: dict


@api_v2.get(
    "/settings/streaming",
    tags=[settings_tag],
    summary="Get streaming settings",
    responses={200: StreamingSettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_streaming_settings(current_user):
    request_id = uuid4().hex
    data = _load_streaming_settings()
    return jsonify({'data': data, 'meta': {'request_id': request_id, 'deprecated': False}})


class UpdateStreamingBody(BaseModel):
    session_monitoring_interval: int = Field(..., ge=5, le=300)
    websocket_refresh_interval: int = Field(..., ge=2, le=300)


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.patch(
    "/settings/streaming",
    tags=[settings_tag],
    summary="Update streaming settings",
    responses={200: StreamingSettingsResponse, 400: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def update_streaming_settings(body: UpdateStreamingBody, current_user):
    request_id = uuid4().hex
    interval_value = body.session_monitoring_interval
    websocket_interval_value = body.websocket_refresh_interval

    try:
        Setting.set('SESSION_MONITORING_INTERVAL_SECONDS', str(interval_value))
        Setting.set('STREAMING_WEBSOCKET_REFRESH_INTERVAL_SECONDS', str(websocket_interval_value))

        log_event(
            EventType.SETTING_CHANGE,
            f"Streaming settings updated: interval={interval_value}, websocket_refresh={websocket_interval_value}",
            admin_id=getattr(current_user, 'id', None)
        )

        return jsonify({'data': _load_streaming_settings(), 'meta': {'request_id': request_id, 'deprecated': False}})
    except Exception as exc:
        current_app.logger.error(f"Failed to update streaming settings: {exc}")
        return jsonify({'error': {'code': 'UPDATE_FAILED', 'message': 'Failed to update streaming settings.'}, 'meta': {'request_id': request_id}}), 500


class ActiveSessionsResponse(BaseModel):
    sessions: list[dict]
    total_count: int
    by_server: dict
    by_service: dict
    meta: dict


class StreamingRefreshResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/streaming/active",
    tags=[streaming_tag],
    summary="Get currently active streaming sessions",
    responses={200: ActiveSessionsResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_active_sessions(current_user):
    request_id = uuid4().hex
    try:
        all_servers = MediaServiceManager.get_effective_servers(active_only=True)
        http_only = str(request.args.get('http_only', '')).lower() in {'1', 'true', 'yes'}
        if http_only:
            websocket_services = {ServiceType.PLEX, ServiceType.EMBY, ServiceType.JELLYFIN}
            all_servers = [
                server for server in all_servers if server.service_type not in websocket_services
            ]
        sessions = []
        by_server = {}
        by_service = {}

        for server in all_servers:
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                try:
                    server_nickname = server.server_nickname
                    formatted_sessions = service.get_formatted_sessions()
                    sessions.extend(formatted_sessions)

                    if formatted_sessions:
                        server_name = server.server_nickname
                        by_server.setdefault(server_name, []).extend(formatted_sessions)

                        service_type = server.service_type.value
                        by_service.setdefault(service_type, []).extend(formatted_sessions)
                except Exception as e:
                    db.session.rollback()
                    current_app.logger.error(f"Error getting formatted sessions from {server_nickname}: {e}")

        return jsonify({'sessions': sessions, 'total_count': len(sessions), 'by_server': by_server, 'by_service': by_service, 'meta': {'request_id': request_id}})
    except Exception as exc:
        current_app.logger.error(f"Failed to get active sessions: {exc}", exc_info=True)
        return jsonify({'error': {'code': 'FETCH_FAILED', 'message': 'Failed to retrieve active sessions.'}, 'meta': {'request_id': request_id}}), 500


@api_v2.post(
    "/streaming/refresh",
    tags=[streaming_tag],
    summary="Trigger an immediate streaming refresh",
    responses={200: StreamingRefreshResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def refresh_streaming_sessions(current_user):
    request_id = uuid4().hex
    try:
        websocket_services = {ServiceType.PLEX, ServiceType.EMBY, ServiceType.JELLYFIN}
        from app.services.task_service import _run_media_session_monitor

        _run_media_session_monitor(
            exclude_service_types=websocket_services,
            source="manual-refresh",
            summary_data={"update_source": "manual_refresh"},
        )
        return jsonify({'data': {'ok': True}, 'meta': {'request_id': request_id}})
    except Exception as exc:
        current_app.logger.error(f"Failed to refresh streaming sessions: {exc}", exc_info=True)
        return jsonify({'error': {'code': 'REFRESH_FAILED', 'message': 'Failed to refresh streaming sessions.'}, 'meta': {'request_id': request_id}}), 500


class TerminateBody(BaseModel):
    session_key: str
    service_type: str
    server_name: str
    message: str | None = ''


class TerminateResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


@api_v2.post(
    "/streaming/terminate",
    tags=[streaming_tag],
    summary="Terminate an active streaming session",
    responses={200: TerminateResponse, 400: TerminateResponse, 404: TerminateResponse, 500: TerminateResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def terminate_session(body: TerminateBody, current_user):
    request_id = uuid4().hex
    session_key = body.session_key
    service_type = body.service_type
    server_name = body.server_name
    message = body.message or ''

    if not session_key or not service_type or not server_name:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'session_key, service_type, and server_name are required.'}, 'meta': {'request_id': request_id}}), 400

    try:
        from app.models_media_services import MediaServer
        server = MediaServer.query.filter_by(server_nickname=server_name, is_active=True).first()
        if not server:
            return jsonify({'error': {'code': 'SERVER_NOT_FOUND', 'message': f'Server {server_name} not found or inactive.'}, 'meta': {'request_id': request_id}}), 404

        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return jsonify({'error': {'code': 'SERVICE_NOT_AVAILABLE', 'message': f'Service not available for server {server_name}.'}, 'meta': {'request_id': request_id}}), 404

        success = service.terminate_session(session_key, message)
        if success:
            log_event(EventType.STREAMING_SESSION_TERMINATED, f"Session {session_key} terminated on {server_name}", admin_id=getattr(current_user, 'id', None))
            return jsonify({'data': {'success': True, 'message': 'Session terminated successfully'}, 'meta': {'request_id': request_id}})
        else:
            return jsonify({'error': {'code': 'TERMINATION_FAILED', 'message': 'Failed to terminate session.'}, 'meta': {'request_id': request_id}}), 500
    except Exception as exc:
        current_app.logger.error(f"Failed to terminate session: {exc}", exc_info=True)
        return jsonify({'error': {'code': 'TERMINATION_ERROR', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500


class SendMessageBody(BaseModel):
    session_key: str
    service_type: str
    server_name: str
    text: str
    header: str | None = None
    timeout_seconds: float | None = None
    timeout_ms: int | None = None


@api_v2.post(
    "/streaming/message",
    tags=[streaming_tag],
    summary="Send a message to an active streaming session",
    responses={200: TerminateResponse, 400: TerminateResponse, 404: TerminateResponse, 500: TerminateResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def send_session_message(body: SendMessageBody, current_user):
    request_id = uuid4().hex
    session_key = body.session_key
    service_type = body.service_type
    server_name = body.server_name
    text = (body.text or "").strip()
    header = body.header
    timeout_seconds = body.timeout_seconds
    timeout_ms = body.timeout_ms

    if not session_key or not service_type or not server_name or not text:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'session_key, service_type, server_name, and text are required.'}, 'meta': {'request_id': request_id}}), 400

    try:
        from app.models_media_services import MediaServer
        server = MediaServer.query.filter_by(server_nickname=server_name, is_active=True).first()
        if not server:
            return jsonify({'error': {'code': 'SERVER_NOT_FOUND', 'message': f'Server {server_name} not found or inactive.'}, 'meta': {'request_id': request_id}}), 404

        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return jsonify({'error': {'code': 'SERVICE_NOT_AVAILABLE', 'message': f'Service not available for server {server_name}.'}, 'meta': {'request_id': request_id}}), 404

        resolved_timeout_ms: int | None = None
        if timeout_seconds is not None:
            try:
                timeout_seconds_value = float(timeout_seconds)
            except (TypeError, ValueError):
                timeout_seconds_value = 0
            if timeout_seconds_value > 0:
                resolved_timeout_ms = int(timeout_seconds_value * 1000)
        elif timeout_ms is not None and timeout_ms > 0:
            resolved_timeout_ms = int(timeout_ms)

        success = bool(
            service.send_session_message(
                session_key,
                text,
                header=header,
                timeout_ms=resolved_timeout_ms,
            )
        )
        if success:
            log_event(
                EventType.SETTING_CHANGE,
                f"Message sent to session {session_key} on {server_name}",
                admin_id=getattr(current_user, 'id', None),
            )
            return jsonify({'data': {'success': True, 'message': 'Message sent successfully'}, 'meta': {'request_id': request_id}})
        else:
            return jsonify({'error': {'code': 'MESSAGE_FAILED', 'message': 'Failed to send message.'}, 'meta': {'request_id': request_id}}), 500
    except Exception as exc:
        current_app.logger.error(f"Failed to send session message: {exc}", exc_info=True)
        return jsonify({'error': {'code': 'MESSAGE_ERROR', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500
