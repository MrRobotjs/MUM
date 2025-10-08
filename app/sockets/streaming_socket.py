"""
WebSocket handlers for streaming/session monitoring
"""
from flask import request, current_app
from flask_socketio import emit, join_room, leave_room, disconnect
from flask_login import current_user
from app.extensions import socketio
from app.services.session_websocket_service import session_ws_service


@socketio.on('connect', namespace='/streaming')
def handle_connect():
    """Handle client connection to streaming namespace"""
    try:
        # Check if user is authenticated
        if not current_user.is_authenticated:
            current_app.logger.warning(
                f"Unauthenticated WebSocket connection attempt from {request.sid}"
            )
            disconnect()
            return False

        # Check if user has permission to view streams
        if not current_user.has_permission('view_streaming'):
            current_app.logger.warning(
                f"User {current_user.id} attempted to connect to streaming "
                f"WebSocket without permission"
            )
            disconnect()
            return False

        # Join the streaming room
        join_room('streaming')

        current_app.logger.info(
            f"User {current_user.id} ({current_user.get_display_name()}) "
            f"connected to streaming WebSocket [SID: {request.sid}]"
        )

        # Send initial data immediately upon connection
        emit('connection_status', {
            'status': 'connected',
            'message': 'Connected to live session updates'
        })

        # Trigger immediate session update for new client
        # Get the actual app instance before starting background task
        app = current_app._get_current_object()

        def update_with_context():
            with app.app_context():
                session_ws_service.force_update()

        socketio.start_background_task(update_with_context)

    except Exception as e:
        current_app.logger.error(f"Error in streaming WebSocket connect: {e}")
        disconnect()
        return False


@socketio.on('disconnect', namespace='/streaming')
def handle_disconnect():
    """Handle client disconnection"""
    try:
        if current_user.is_authenticated:
            leave_room('streaming')
            current_app.logger.info(
                f"User {current_user.id} disconnected from streaming WebSocket"
            )
    except Exception as e:
        current_app.logger.error(f"Error in streaming WebSocket disconnect: {e}")


@socketio.on('request_update', namespace='/streaming')
def handle_request_update():
    """Handle manual update request from client"""
    try:
        if not current_user.is_authenticated:
            return

        if not current_user.has_permission('view_streaming'):
            return

        current_app.logger.debug(
            f"Manual session update requested by user {current_user.id}"
        )

        # Force immediate update with app context
        # Get the actual app instance before starting background task
        app = current_app._get_current_object()

        def update_with_context():
            with app.app_context():
                session_ws_service.force_update()

        socketio.start_background_task(update_with_context)

        emit('update_requested', {
            'status': 'processing',
            'message': 'Refreshing session data...'
        })

    except Exception as e:
        current_app.logger.error(f"Error handling request_update: {e}")
        emit('error', {
            'message': 'Failed to refresh session data'
        })


@socketio.on('ping', namespace='/streaming')
def handle_ping(data):
    """Handle ping from client to keep connection alive"""
    timestamp = data.get('timestamp', 0) if isinstance(data, dict) else 0
    emit('pong', {'timestamp': timestamp})
