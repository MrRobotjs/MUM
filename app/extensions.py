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
import json
from sqlalchemy.types import TypeDecorator, TEXT
from sqlalchemy import event
from sqlalchemy.engine import Engine

# Enable better SQLite concurrency (WAL, busy timeout) when using SQLite
@event.listens_for(Engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    try:
        import sqlite3
        if isinstance(dbapi_connection, sqlite3.Connection):
            cursor = dbapi_connection.cursor()
            # Allow concurrent readers during writes
            cursor.execute("PRAGMA journal_mode=WAL")
            # Reasonable durability/performance tradeoff for WAL
            cursor.execute("PRAGMA synchronous=NORMAL")
            # Back off and wait if database is busy/locked
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()
    except Exception:
        # Do not fail app startup if PRAGMAs cannot be applied
        pass

class JSONEncodedDict(TypeDecorator):
    """Enables JSON storage by encoding and decoding on the fly."""
    impl = TEXT

    def process_bind_param(self, value, dialect):
        if value is not None:
            return json.dumps(value)
        return value

    def process_result_value(self, value, dialect):
        if value is not None:
            return json.loads(value)
        return value

# JWT Manager (configured in app/__init__.py)
jwt = JWTManager()
