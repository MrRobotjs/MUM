"""WebSocket endpoints for real-time updates (JWT-secured)"""
from flask import Blueprint, current_app, request
from flask_socketio import emit, join_room, leave_room
from app.extensions import socketio
from app.models import User, UserType
from functools import wraps
from flask_jwt_extended import decode_token
from app.routes.api_v2.sync_status import get_sync_status, SYNC_STATUS_ROOM

bp = Blueprint('websockets', __name__)

# Track authenticated socket clients by sid
_ws_clients: dict[str, dict] = {}


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


@socketio.on('subscribe_streaming')
@jwt_ws_required('view_streaming')
def handle_subscribe_streaming():
    """Subscribe to streaming updates (requires view_streaming permission)"""
    try:
        join_room('streaming_updates')
        current_app.logger.info(f"WebSocket client {request.sid} subscribed to streaming_updates room")
        emit('subscribed', {'channel': 'streaming_updates'})
    except Exception as e:
        current_app.logger.error(f"Failed to subscribe client {request.sid} to streaming_updates: {e}", exc_info=True)
        emit('subscription_error', {'message': str(e)})


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


def broadcast_streaming_update(active_count, summary_data=None, live_services=None, sessions=None):
    """
    Broadcast streaming updates to all subscribed clients.
    This is called from the task_service when session monitoring completes.

    Args:
        active_count: Number of active streaming sessions
        summary_data: Optional summary data (for dashboard card)
        live_services: Optional iterable of service types delivering live updates (e.g., websocket-backed)
        sessions: Optional list of formatted session dictionaries (full session data for instant frontend updates)
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

    # ✅ ADD: Full session data for instant frontend updates
    if sessions is not None:
        payload['sessions'] = sessions

    socketio.emit('streaming_update', payload, room='streaming_updates', namespace='/')
    current_app.logger.debug(
        f"Broadcasted streaming update: {active_count} active sessions, {len(sessions) if sessions else 0} session objects"
    )
    # Log room membership for debugging
    try:
        from flask_socketio import rooms
        room_clients = rooms(namespace='/', room='streaming_updates')
        current_app.logger.debug(f"Room 'streaming_updates' has {len(room_clients) if room_clients else 0} clients")
    except Exception:
        pass
@socketio.on('subscribe_sync_status')
@jwt_ws_required('administrator')
def handle_subscribe_sync_status():
    """Subscribe to sync status updates."""
    try:
        join_room(SYNC_STATUS_ROOM)
        emit('subscribed', {'channel': SYNC_STATUS_ROOM})
        emit('sync_status_update', get_sync_status(), room=request.sid)
    except Exception as e:
        current_app.logger.error(f"Failed to subscribe client {request.sid} to sync status: {e}", exc_info=True)
        emit('subscription_error', {'message': str(e)})


@socketio.on('unsubscribe_sync_status')
@jwt_ws_required()
def handle_unsubscribe_sync_status():
    """Unsubscribe from sync status updates."""
    leave_room(SYNC_STATUS_ROOM)
    emit('unsubscribed', {'channel': SYNC_STATUS_ROOM})
