# File: app/extensions.py
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_apscheduler import APScheduler
from flask_socketio import SocketIO
from flask_caching import Cache
from flask_jwt_extended import JWTManager

# Database
db = SQLAlchemy()

# Migrations
migrate = Migrate()

## Flask-Login and CSRF removed (JWT-only)

# APScheduler for background tasks
scheduler = APScheduler()

# Flask-SocketIO for WebSocket support
# Use eventlet for production (Gunicorn compatibility)
socketio = SocketIO(cors_allowed_origins="*", async_mode='eventlet')

# Flask-Caching for in-memory caching
# Uses 'simple' backend for single-worker deployments
# Can be easily upgraded to Redis by changing CACHE_TYPE in config
cache = Cache()
from sqlalchemy.types import TypeDecorator
from sqlalchemy.dialects.postgresql import JSONB

class JSONEncodedDict(TypeDecorator):
    """Enables JSON storage by encoding and decoding on the fly."""
    impl = JSONB
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return value

    def process_result_value(self, value, dialect):
        return value

# JWT Manager (configured in app/__init__.py)
jwt = JWTManager()
