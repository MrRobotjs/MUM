# File: app/extensions.py
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_login import LoginManager
from flask_wtf.csrf import CSRFProtect
from flask_session import Session # If using Flask-Session
from flask_apscheduler import APScheduler
from flask_babel import Babel
from flask_htmx import HTMX
from cachetools import TTLCache

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

# Babel for i18n/l10n (even if not immediately used, good to have)
babel = Babel()

# Flask-HTMX
htmx = HTMX()

# Global in-memory cache example (e.g., for Plex libraries, server status for short periods)
# Cache for 5 minutes, max 100 items
# You might want more sophisticated caching (e.g., Flask-Caching with Redis/Memcached) for a larger app.
# For this project, simple TTLCache might suffice for some non-critical, frequently accessed data.
# Example: plex_server_info_cache = TTLCache(maxsize=10, ttl=300) # 10 items, 5 min TTL
# Example: plex_libraries_cache = TTLCache(maxsize=5, ttl=3600) # 5 items, 1 hour TTL

# We'll initialize these caches within services or where appropriate to avoid global state issues at import time
# if they depend on app context or configuration that's not yet available.
# For now, just declaring the extension instances.
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