"""WebSocket endpoints for real-time updates"""
from flask import Blueprint, current_app
from flask_socketio import emit, join_room, leave_room
from flask_login import current_user
from app.extensions import socketio
from app.models import User, UserType
from functools import wraps

bp = Blueprint('websockets', __name__)


def authenticated_only(f):
    """Decorator to require authentication for WebSocket events"""
    @wraps(f)
    def wrapped(*args, **kwargs):
        if not current_user.is_authenticated:
            return False
        return f(*args, **kwargs)
    return wrapped


@socketio.on('connect')
def handle_connect():
    """Handle client connection"""
    if not current_user.is_authenticated:
        current_app.logger.warning("Unauthenticated WebSocket connection attempt")
        return False

    current_app.logger.info(f"WebSocket client connected: {current_user.get_display_name()}")
    emit('connected', {'message': 'Connected to MUM WebSocket server'})


@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection"""
    if current_user.is_authenticated:
        current_app.logger.info(f"WebSocket client disconnected: {current_user.get_display_name()}")


@socketio.on('subscribe_streaming')
@authenticated_only
def handle_subscribe_streaming():
    """Subscribe to streaming updates"""
    if not current_user.has_permission('view_streaming'):
        current_app.logger.warning(f"User {current_user.get_display_name()} attempted to subscribe to streaming without permission")
        return False

    join_room('streaming_updates')
    current_app.logger.info(f"User {current_user.get_display_name()} subscribed to streaming updates")
    emit('subscribed', {'channel': 'streaming_updates'})


@socketio.on('unsubscribe_streaming')
@authenticated_only
def handle_unsubscribe_streaming():
    """Unsubscribe from streaming updates"""
    leave_room('streaming_updates')
    current_app.logger.info(f"User {current_user.get_display_name()} unsubscribed from streaming updates")
    emit('unsubscribed', {'channel': 'streaming_updates'})


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
