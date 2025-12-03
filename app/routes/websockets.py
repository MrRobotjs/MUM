"""WebSocket endpoints for real-time updates (JWT-secured)"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Dict, Iterable, Set

from flask import Blueprint, current_app, request
from flask_socketio import emit, join_room, leave_room
from functools import wraps
from flask_jwt_extended import decode_token

from app.extensions import socketio
from app.models import User, UserType
from app.models_media_services import MediaServer

bp = Blueprint('websockets', __name__)

# Track authenticated socket clients by sid
_ws_clients: dict[str, dict] = {}
# Track channel subscriptions per socket and per channel
_ws_subscriptions: Dict[str, Set[str]] = defaultdict(set)
_channel_subscribers: Dict[str, Set[str]] = defaultdict(set)

CHANNEL_PATTERN = re.compile(r"^(?P<service>[a-z0-9]+)\.(?P<server_id>[0-9]+)\.(?P<topic>[a-z0-9_.-]+)$")
SYSTEM_CHANNEL_PATTERN = re.compile(r"^system\.(?P<topic>[a-z0-9_.-]+)$")


def _set_client_auth(sid: str, user: User):
    """Store user authentication info for websocket client"""
    # Get role names for permission checking
    role_names = [r.name for r in getattr(user, 'admin_roles', [])]
    
    # Check if user has 'administrator' permission through any role
    has_administrator = False
    if user.userType == UserType.LOCAL:
        for role in user.admin_roles:
            if role.has_permission('administrator'):
                has_administrator = True
                break
    
    _ws_clients[sid] = {
        'uuid': user.uuid,
        'user_type': user.userType,  # Store user type (Owner, Local, Service)
        'permissions': role_names,  # Role names
        'has_administrator': has_administrator,  # Has administrator permission
        'is_active': bool(getattr(user, 'is_active', True)),
    }


def _clear_client_auth(sid: str):
    """Clear auth and subscriptions for a socket."""
    channels = _ws_subscriptions.pop(sid, set())
    for channel in channels:
        _channel_subscribers[channel].discard(sid)
        try:
            leave_room(channel)
        except Exception:
            pass
    _ws_clients.pop(sid, None)


def _has_permission(sid: str, perm: str) -> bool:
    """Check if websocket client has permission (matches User.has_permission logic)"""
    info = _ws_clients.get(sid)
    if not info:
        return False
    
    # Owner users have all permissions
    if info.get('user_type') == UserType.OWNER:
        return True
    
    # Administrators (role with 'administrator' permission) have full access
    if info.get('has_administrator', False):
        return True
    
    # Check if user has the specific permission through role names
    perms = set(info.get('permissions') or [])
    return perm in perms


def _get_user_for_sid(sid: str) -> User | None:
    info = _ws_clients.get(sid)
    if not info:
        return None
    return User.query.filter_by(uuid=info.get('uuid')).first()


@socketio.on('connect')
def handle_connect(auth):
    """Handle client connection with JWT in auth payload."""
    token = None
    if isinstance(auth, dict):
        token = auth.get('access_token') or auth.get('token')
    if not token:
        current_app.logger.warning('WebSocket connect rejected: missing access_token in auth payload')
        return False
    try:
        decoded = decode_token(token)
        identity = decoded.get('sub')
        if not identity:
            current_app.logger.warning('WebSocket connect rejected: token missing identity')
            return False
        user = User.query.filter_by(uuid=identity).first()
        if not user or not getattr(user, 'is_active', True):
            current_app.logger.warning('WebSocket connect rejected: user not found or inactive')
            return False
        _set_client_auth(request.sid, user)
        current_app.logger.info(f"WebSocket client connected: {user.uuid}")
        emit('connected', {'message': 'Connected to MUM WebSocket server'})
        return True
    except Exception as e:
        current_app.logger.warning(f'WebSocket connect rejected: invalid token ({e})')
        return False


@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection"""
    _clear_client_auth(request.sid)
    current_app.logger.info("WebSocket client disconnected")


def jwt_ws_required(perm: str | None = None):
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            sid = request.sid
            if sid not in _ws_clients:
                current_app.logger.warning(f'WebSocket event rejected: unauthenticated sid {sid}')
                emit('error', {'message': 'Not authenticated'})
                return False
            if perm and not _has_permission(sid, perm):
                user_info = _ws_clients.get(sid, {})
                user_perms = user_info.get('permissions', [])
                current_app.logger.warning(
                    f'WebSocket event rejected: insufficient permissions. Required: {perm}, User perms: {user_perms}, SID: {sid}'
                )
                emit('error', {'message': f'Insufficient permissions: {perm}'})
                return False
            return f(*args, **kwargs)
        return wrapped
    return decorator


def _parse_channel(channel: str):
    """Parse channel string into structured info."""
    system_match = SYSTEM_CHANNEL_PATTERN.match(channel)
    if system_match:
        return {"kind": "system", "topic": system_match.group("topic")}
    match = CHANNEL_PATTERN.match(channel)
    if not match:
        return None
    return {
        "kind": "service",
        "service": match.group("service"),
        "server_id": int(match.group("server_id")),
        "topic": match.group("topic"),
    }


def _validate_channel_access(sid: str, channel: str):
    parsed = _parse_channel(channel)
    if not parsed:
        return False, "invalid_channel", "Channel name is not valid"

    user = _get_user_for_sid(sid)
    if not user or not getattr(user, "is_active", True):
        return False, "unauthenticated", "User not authenticated"

    if parsed["kind"] == "system":
        topic = parsed["topic"]
        if topic == "sync_status":
            if not _has_permission(sid, "administrator"):
                return False, "forbidden", "Administrator permission required for sync status"
            return True, None, None
        return False, "invalid_channel", f"Unknown system channel: {topic}"

    server = MediaServer.query.get(parsed["server_id"])
    if not server:
        return False, "invalid_channel", f"Server {parsed['server_id']} not found"
    if server.service_type.value != parsed["service"]:
        return False, "invalid_channel", "Service type mismatch for channel"

    # Owners and administrators can subscribe to any server; others require explicit access
    if user.userType == UserType.OWNER or _has_permission(sid, "administrator"):
        return True, None, None
    if user.has_access_to_server(server.id):
        return True, None, None

    return False, "forbidden", "User does not have access to this server"


def _subscribe_channels(sid: str, channels: Iterable[str]):
    granted: list[str] = []
    rejected: list[dict] = []

    for channel in channels:
        ok, code, msg = _validate_channel_access(sid, channel)
        if not ok:
            rejected.append({"channel": channel, "error": code, "message": msg})
            continue

        if channel not in _ws_subscriptions[sid]:
            _ws_subscriptions[sid].add(channel)
            _channel_subscribers[channel].add(sid)
            join_room(channel)
        granted.append(channel)

        # System channels can send a snapshot immediately
        if channel == "system.sync_status":
            try:
                from app.routes.api_v2.sync_status import get_sync_status

                emit(
                    "ws_event",
                    {"channel": channel, "event": "sync_status_update", "data": get_sync_status()},
                    room=sid,
                )
            except Exception:
                current_app.logger.warning("Failed to send initial sync status snapshot", exc_info=True)

    return granted, rejected


def _unsubscribe_channels(sid: str, channels: Iterable[str]):
    removed: list[str] = []
    for channel in channels:
        if channel in _ws_subscriptions.get(sid, set()):
            _ws_subscriptions[sid].discard(channel)
            _channel_subscribers[channel].discard(sid)
            removed.append(channel)
            try:
                leave_room(channel)
            except Exception:
                pass
    return removed


@socketio.on('subscribe')
@jwt_ws_required()
def handle_subscribe(data):
    """Subscribe to one or more channels."""
    channels = []
    if isinstance(data, dict):
        channels = data.get('channels') or []
    elif isinstance(data, list):
        channels = data

    if not channels:
        emit('subscription_error', {'error': 'invalid_payload', 'message': 'channels array required'})
        return False

    granted, rejected = _subscribe_channels(request.sid, channels)
    if granted:
        emit('subscribed', {'channels': granted})
    if rejected:
        emit('subscription_error', {'rejected': rejected})
    return True


@socketio.on('unsubscribe')
@jwt_ws_required()
def handle_unsubscribe(data):
    """Unsubscribe from one or more channels."""
    channels = []
    if isinstance(data, dict):
        channels = data.get('channels') or []
    elif isinstance(data, list):
        channels = data

    if not channels:
        emit('subscription_error', {'error': 'invalid_payload', 'message': 'channels array required'})
        return False

    removed = _unsubscribe_channels(request.sid, channels)
    if removed:
        emit('unsubscribed', {'channels': removed})
    return True


@socketio.on('auth_update')
def handle_auth_update(data):
    """Update the current socket's auth with a new access token without reconnecting.

    Client example:
      socket.emit('auth_update', { access_token: newAccessToken })
    """
    token = None
    if isinstance(data, dict):
        token = data.get('access_token') or data.get('token')
    if not token:
        current_app.logger.warning('WebSocket auth_update rejected: missing access_token')
        emit('auth_error', {'message': 'missing access_token'})
        return False
    try:
        decoded = decode_token(token)
        identity = decoded.get('sub')
        if not identity:
            emit('auth_error', {'message': 'invalid token: no identity'})
            return False
        user = User.query.filter_by(uuid=identity).first()
        if not user or not getattr(user, 'is_active', True):
            emit('auth_error', {'message': 'user inactive or not found'})
            return False
        _set_client_auth(request.sid, user)
        emit('auth_updated', {'ok': True})
        return True
    except Exception as e:
        current_app.logger.warning(f'WebSocket auth_update rejected: invalid token ({e})')
        emit('auth_error', {'message': 'invalid token'})
        return False


def publish_channel_event(channel: str, event: str, data: dict):
    """Publish a message envelope to a specific channel."""
    envelope = {"channel": channel, "event": event, "data": data}
    socketio.emit('ws_event', envelope, room=channel, namespace='/')


def broadcast_streaming_update(sessions, live_services=None, servers=None, summary_data=None):
    """
    Broadcast streaming updates to channelized subscribers.

    Args:
        sessions: List of formatted session dictionaries
        live_services: Optional iterable of service types delivering live updates
        servers: Optional iterable of MediaServer objects that were monitored
        summary_data: Optional summary payload
    """
    from datetime import datetime, timezone
    from collections import defaultdict

    sessions = sessions or []
    server_index = {}
    if servers:
        for srv in servers:
            server_index[(srv.service_type.value, int(srv.id))] = srv

    grouped = defaultdict(list)
    for session in sessions:
        service = str(session.get('service_type') or '').lower()
        server_id = session.get('server_id')
        if service and server_id is not None:
            grouped[(service, int(server_id))].append(session)

    # Ensure we also send empty updates for monitored servers with no active sessions
    for key in server_index.keys():
        grouped.setdefault(key, grouped.get(key, []))

    live_services_payload = []
    if live_services is not None:
        try:
            live_services_payload = sorted({str(service).lower() for service in live_services})
        except TypeError:
            live_services_payload = []

    now = datetime.now(timezone.utc).isoformat()

    for (service, server_id), server_sessions in grouped.items():
        channel = f"{service}.{server_id}.sessions"
        payload = {
            'active_count': len(server_sessions),
            'timestamp': now,
            'sessions': server_sessions,
        }
        if live_services_payload:
            payload['live_services'] = live_services_payload
        if summary_data:
            payload['summary'] = summary_data

        publish_channel_event(channel, 'session_update', payload)
        current_app.logger.debug(
            f"Broadcasted session_update to {channel}: {len(server_sessions)} sessions"
        )
