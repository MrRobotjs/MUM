# File: app/extensions.py
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_login import LoginManager
from flask_wtf.csrf import CSRFProtect
from flask_session import Session # If using Flask-Session
from flask_apscheduler import APScheduler
from flask_babel import Babel
from flask_socketio import SocketIO
from flask_caching import Cache

# Database
db = SQLAlchemy()

# Migrations
migrate = Migrate()

# Login Manager
login_manager = LoginManager()
# Users who are not logged in and try to access a protected page will be redirected by the unauthorized_handler below
login_manager.login_view = 'auth.admin_login'  # Fallback if handler fails
login_manager.login_message_category = 'info'
login_manager.needs_refresh_message_category = "info"
# login_manager.session_protection = "strong" # Can help prevent session fixation

# Custom unauthorized handler will be attached in app/__init__.py to properly route to admin or user login pages

# CSRF Protection
csrf = CSRFProtect()

# Server-side Session (optional, if you choose to use it over default client-side sessions)
# server_session = Session()

# APScheduler for background tasks
scheduler = APScheduler()

# Babel for i18n/l10n (initialized without a custom locale selector)
babel = Babel()

# Flask-SocketIO for WebSocket support
# Use eventlet for production (Gunicorn compatibility)
socketio = SocketIO(cors_allowed_origins="*", async_mode='eventlet')

# Flask-Caching for in-memory caching
# Uses 'simple' backend for single-worker deployments
# Can be easily upgraded to Redis by changing CACHE_TYPE in config
cache = Cache()
import json
from sqlalchemy.types import TypeDecorator, TEXT

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
