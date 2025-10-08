"""
WebSocket handlers for real-time updates
"""
# Import socketio from extensions to avoid creating duplicate instance
from app.extensions import socketio

# Export for convenience
__all__ = ['socketio']
