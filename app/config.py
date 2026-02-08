# File: app/config.py
import os
import secrets

class Config:
    """Base configuration class."""
    # Default secret key, will be overridden by database setting after setup
    # It's here as a fallback for the very initial app startup if something tries to access it
    # before the database is configured.
    SECRET_KEY = os.environ.get('SECRET_KEY') or secrets.token_hex(32)

    # Database configuration (PostgreSQL)
    # DATABASE_URL should be provided in production (e.g., docker-compose).
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL') or \
        'postgresql+psycopg://mum:mum_pass@localhost:5432/mum'
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        'pool_size': int(os.environ.get('DB_POOL_SIZE', 10)),
        'max_overflow': int(os.environ.get('DB_MAX_OVERFLOW', 20)),
        'pool_pre_ping': True,
        'pool_recycle': int(os.environ.get('DB_POOL_RECYCLE', 3600)),
        'pool_timeout': int(os.environ.get('DB_POOL_TIMEOUT', 30)),
    }

    # Flask-Session configuration (example, if using server-side sessions)
    # SESSION_TYPE = 'filesystem' # or 'sqlalchemy' if you want to use the db
    # SESSION_FILE_DIR = os.path.join(os.path.abspath(os.path.dirname(os.path.dirname(__file__))), 'instance', 'flask_session')
    # SESSION_SQLALCHEMY_TABLE = 'sessions' # if using sqlalchemy type
    # SESSION_PERMANENT = True
    # PERMANENT_SESSION_LIFETIME = timedelta(days=7)

    # Application specific settings (defaults that can be overridden by DB settings)
    APP_NAME = "MUM"
    APP_VERSION = "0.1.0" # You can update this as you develop

    # Default Plex connection check timeout
    PLEX_TIMEOUT = 10 # seconds

    # Default session monitoring interval
    SESSION_MONITORING_INTERVAL_SECONDS = 60 # Check every 60 seconds

    # Paths
    # Ensure the instance folder exists on app creation if not handled by Dockerfile volume mapping initially
    INSTANCE_FOLDER_PATH = os.path.join(os.path.abspath(os.path.dirname(os.path.dirname(__file__))), 'instance')


    # OAuth settings - these will primarily be placeholders as they'll be configured in the UI
    # and stored in the database.
    # PLEX_CLIENT_ID: For Plex SSO - Plex uses 'Plex Web' as client ID or a custom one if they provide an API for it.
    # For the X-Plex-Client-Identifier, it's usually a unique ID you generate for your app.
    PLEX_APP_CLIENT_IDENTIFIER = "MUM" # Example, generate a UUID for uniqueness in production if needed

    # Flask-Login settings
    LOGIN_DISABLED_FOR_SETUP = False # This might be toggled dynamically

    DEFAULT_ITEMS_PER_PAGE = 10 # A general default
    DEFAULT_USERS_PER_PAGE = 12
    DEFAULT_INVITES_PER_PAGE = 10
    DEFAULT_HISTORY_PER_PAGE = 20

    # JWT settings (secure defaults; can be overridden by DB settings)
    # Note: SECRET_KEY is separate; JWT uses its own key
    JWT_SECRET_KEY = os.environ.get('JWT_SECRET_KEY') or secrets.token_hex(32)
    # Access via Authorization header; Refresh via HttpOnly cookie
    JWT_TOKEN_LOCATION = ["headers", "cookies"]
    from datetime import timedelta as _td  # local alias to avoid top-level import collisions
    JWT_ACCESS_TOKEN_EXPIRES = _td(minutes=60)
    JWT_REFRESH_TOKEN_EXPIRES = _td(days=14)
    JWT_COOKIE_SECURE = False  # Set True in production with HTTPS
    JWT_COOKIE_HTTPONLY = True
    JWT_COOKIE_SAMESITE = "Strict"  # Browser-level CSRF protection for refresh cookie
    JWT_COOKIE_CSRF_PROTECT = False  # We rely on SameSite=Strict; no double-submit header
    JWT_REFRESH_COOKIE_PATH = "/"  # Ensure cookie is sent reliably
    JWT_HEADER_NAME = "Authorization"
    JWT_HEADER_TYPE = "Bearer"

    @staticmethod
    def init_app(app):
        # Create instance folder if it doesn't exist
        if not os.path.exists(app.instance_path):
            try:
                os.makedirs(app.instance_path)
                print(f"Instance folder created at {app.instance_path}")
            except OSError as e:
                print(f"Error creating instance folder at {app.instance_path}: {e}")

        # If using Flask-Session with filesystem, ensure its directory exists
        # session_file_dir = app.config.get('SESSION_FILE_DIR')
        # if app.config.get('SESSION_TYPE') == 'filesystem' and session_file_dir and not os.path.exists(session_file_dir):
        #     try:
        #         os.makedirs(session_file_dir)
        #         print(f"Session file directory created at {session_file_dir}")
        #     except OSError as e:
        #         print(f"Error creating session file directory at {session_file_dir}: {e}")
        pass


class DevelopmentConfig(Config):
    DEBUG = True
    # In development, you might want a more predictable SECRET_KEY if not set by .flaskenv
    # SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev_secret_key'
    # SQLALCHEMY_ECHO = True # Useful for debugging SQL queries


class TestingConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = os.environ.get('TEST_DATABASE_URL') or \
        'postgresql+psycopg://mum:mum_pass@localhost:5432/mum_test'
    WTF_CSRF_ENABLED = False # Disable CSRF for easier testing of forms
    SECRET_KEY = 'test_secret_key'


class ProductionConfig(Config):
    DEBUG = False
    # In production, SECRET_KEY MUST be set securely and come from the database after setup.
    # The default Config.SECRET_KEY is a fallback only for the very initial startup.
    # SESSION_COOKIE_SECURE = True
    # SESSION_COOKIE_HTTPONLY = True
    # SESSION_COOKIE_SAMESITE = 'Lax'


config = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig # Change to ProductionConfig for default deployment
}

# Helper function to get a specific setting from the database
# This will be used by the application after it's initialized and DB is accessible.
# For now, it's a placeholder. We'll integrate it properly in app/__init__.py
def get_setting_from_db(key, default=None):
    from app.models import Setting # Local import to avoid circular dependency at module load time
    setting = Setting.query.filter_by(key=key).first()
    if setting:
        # Basic type conversion, can be expanded
        if setting.value_type == 'integer':
            return int(setting.value)
        elif setting.value_type == 'boolean':
            return setting.value.lower() in ['true', '1', 'yes']
        # Add more types as needed (float, json, etc.)
        return setting.value
    return default
