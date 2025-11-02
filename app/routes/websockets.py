"""WebSocket endpoints for real-time updates (JWT-secured)"""
from flask import Blueprint, current_app, request
from flask_socketio import emit, join_room, leave_room
from app.extensions import socketio
from app.models import User
from functools import wraps
from flask_jwt_extended import decode_token

bp = Blueprint('websockets', __name__)

# Track authenticated socket clients by sid
_ws_clients: dict[str, dict] = {}


def _set_client_auth(sid: str, user: User):
    _ws_clients[sid] = {
        'uuid': user.uuid,
        'permissions': [r.name for r in getattr(user, 'admin_roles', [])],
        'is_active': bool(getattr(user, 'is_active', True)),
    }


def _clear_client_auth(sid: str):
    _ws_clients.pop(sid, None)


def _has_permission(sid: str, perm: str) -> bool:
    info = _ws_clients.get(sid)
    if not info:
        return False
    perms = set(info.get('permissions') or [])
    return 'administrator' in perms or perm in perms


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
                current_app.logger.warning('WebSocket event rejected: unauthenticated sid')
                return False
            if perm and not _has_permission(sid, perm):
                current_app.logger.warning('WebSocket event rejected: insufficient permissions')
                return False
            return f(*args, **kwargs)
        return wrapped
    return decorator


@socketio.on('subscribe_streaming')
@jwt_ws_required('view_streaming')
def handle_subscribe_streaming():
    """Subscribe to streaming updates (requires view_streaming permission)"""
    join_room('streaming_updates')
    emit('subscribed', {'channel': 'streaming_updates'})


@socketio.on('unsubscribe_streaming')
@jwt_ws_required()
def handle_unsubscribe_streaming():
    """Unsubscribe from streaming updates"""
    leave_room('streaming_updates')
    emit('unsubscribed', {'channel': 'streaming_updates'})


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


def broadcast_streaming_update(active_count, summary_data=None, live_services=None):
    """
    Broadcast streaming updates to all subscribed clients.
    This is called from the task_service when session monitoring completes.

    Args:
        active_count: Number of active streaming sessions
        summary_data: Optional summary data (for dashboard card)
        live_services: Optional iterable of service types delivering live updates (e.g., websocket-backed)
    """
    from datetime import datetime, timezone

    payload = {
        'active_count': active_count,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

    if summary_data:
        payload['summary'] = summary_data

    if live_services is not None:
        try:
            payload['live_services'] = sorted({str(service).lower() for service in live_services})
        except TypeError:
            payload['live_services'] = []

    socketio.emit('streaming_update', payload, room='streaming_updates', namespace='/')
    current_app.logger.debug(f"Broadcasted streaming update: {active_count} active sessions")
