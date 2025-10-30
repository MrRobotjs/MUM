# File: app/__init__.py
import os
import logging
from logging.handlers import RotatingFileHandler
import secrets
from werkzeug.middleware.proxy_fix import ProxyFix
from flask import request, redirect, url_for, current_app, send_from_directory, jsonify
from flask_openapi3 import OpenAPI, Info

from .config import config
from .extensions import (
    db,
    migrate,
    login_manager,
    csrf,
    scheduler,
    babel,
    socketio,
    cache
)
from .models import Setting
from sqlalchemy import inspect

"""Flask application factory and setup."""

def initialize_settings_from_db(app_instance):
    """Initialize settings from database, with robust error handling for missing tables"""
    # Set a default SECRET_KEY first
    if not app_instance.config.get('SECRET_KEY'): 
        app_instance.config['SECRET_KEY'] = secrets.token_hex(32)
    
    try:
        inspector = inspect(db.engine)
        if not inspector.has_table(Setting.__tablename__):
            app_instance.logger.warning("Settings table not found during init. Using defaults.")
            return

        # Try to query settings
        with app_instance.app_context():
            all_settings = Setting.query.all()
            settings_dict = {s.key: s.get_value() for s in all_settings}

            # Apply settings to app config
            for k, v in settings_dict.items():
                if k.isupper():
                    app_instance.config[k] = v

            # Handle SECRET_KEY specifically (kept as-is per request)
            db_sk = settings_dict.get('SECRET_KEY')
            if db_sk:
                app_instance.config['SECRET_KEY'] = db_sk

            app_instance.logger.info("Application settings loaded from database.")

    except Exception as e:
        app_instance.logger.warning(f"Could not load settings from database: {e}. Using defaults.")
        # Continue with defaults - don't fail the app startup

def register_error_handlers(app):
    @app.errorhandler(400)
    def bad_request_page(error):
        error_description = str(error.description) if hasattr(error, 'description') else "Bad request."
        response = jsonify({'error': {'code': 'BAD_REQUEST', 'message': error_description}})
        response.status_code = 400
        return response
    @app.errorhandler(403)
    def forbidden_page(error):
        response = jsonify({'error': {'code': 'FORBIDDEN', 'message': 'Access is forbidden.'}})
        response.status_code = 403
        return response
    @app.route('/favicon.ico')
    def favicon():
        return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/x-icon')

    @app.errorhandler(404)
    def page_not_found(error):
        return jsonify({'error': {'code': 'NOT_FOUND', 'message': 'Resource not found.'}}), 404

    @app.errorhandler(500)
    def server_error_page(error):
        current_app.logger.exception('Unhandled server error: %s', error)
        return jsonify({'error': {'code': 'SERVER_ERROR', 'message': 'An unexpected error occurred.'}}), 500
    
def create_app(config_name=None):
    if config_name is None:
        config_name = os.environ.get('FLASK_ENV', 'default')
    
    # Use OpenAPI (subclass of Flask) to enable automatic OpenAPI 3.1 generation for api_v2
    # Do NOT set servers with a base path because paths registered below already
    # include '/admin/api/v2', and adding a server with that prefix would duplicate it in examples.
    info = Info(title="Media User Manager API", version="2.0.0")
    app = OpenAPI(
        __name__,
        info=info,
        instance_relative_config=True,
        # Expose docs and JSON under admin namespace to avoid conflicts
        doc_prefix="/admin/api/v2/openapi",
        doc_url="/openapi.json",
    )
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
    app.jinja_env.add_extension('jinja2.ext.do')
    
    app.config.from_object(config[config_name])
    config[config_name].init_app(app)

    try:
        if not os.path.exists(app.instance_path):
            os.makedirs(app.instance_path)
    except OSError as e:
        print(f"Init.py - create_app(): Could not create instance path at {app.instance_path}: {e}")

    log_level_name = os.environ.get('FLASK_LOG_LEVEL', 'INFO').upper()
    log_level = getattr(logging, log_level_name, logging.INFO)
    app.logger.setLevel(log_level)

    if not app.debug and not app.testing:
        log_dir = 'logs'
        if not os.path.exists(log_dir):
            try: os.mkdir(log_dir)
            except OSError: app.logger.error(f"Init.py - create_app(): Could not create '{log_dir}' directory for file logging.")
        
        if os.path.exists(log_dir): 
            try:
                file_handler = RotatingFileHandler(os.path.join(log_dir, 'mum.log'), maxBytes=10240, backupCount=10)
                file_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'))
                file_handler.setLevel(log_level) 
                app.logger.handlers.clear()
                app.logger.addHandler(file_handler)
                app.logger.propagate = False
                app.logger.info(f"Init.py - create_app(): File logging configured. Level: {log_level_name}")
            except Exception as e_fh:
                app.logger.error(f"Init.py - create_app(): Failed to configure file logging: {e_fh}")
    
    app.logger.info(f'Multimedia User Manager starting (log level: {log_level_name})')

    db.init_app(app)
    migrate.init_app(app, db)
    login_manager.init_app(app)
    csrf.init_app(app)
    babel.init_app(app)
    socketio.init_app(app)

    # Initialize Flask-Caching honoring existing app.config. If unset, provide safe defaults.
    if not app.config.get('CACHE_TYPE'):
        app.config.setdefault('CACHE_TYPE', 'simple')  # In-memory cache for single worker
        app.config.setdefault('CACHE_DEFAULT_TIMEOUT', 3600)  # 1 hour default
    cache.init_app(app)
    
    # Define custom unauthorized handler to route to correct login page or return JSON for APIs
    @login_manager.unauthorized_handler
    def unauthorized():
        requested_endpoint = request.endpoint
        requested_path = request.path
        next_url = request.full_path if request.full_path != '/' else None

        # Prefer JSON when client asks for it or hitting explicit API paths
        accepts = request.accept_mimetypes
        prefers_json = accepts.accept_json and (
            not accepts.accept_html or accepts['application/json'] >= accepts['text/html']
        )
        is_api_path = requested_path.startswith('/admin/api/') or requested_path.startswith('/api/v2')
        if prefers_json or is_api_path:
            return jsonify({'error': {'code': 'UNAUTHORIZED', 'message': 'Authentication required.'}}), 401

        # Admin area → admin login
        admin_path_prefixes = ['/admin/', '/admin?', '/admin#']
        admin_endpoint_prefixes = [
            'dashboard.', 'settings.', 'plugin_management.', 'admin_management.',
            'role_management.', 'users.', 'invites_admin.', 'media_servers_admin.',
            'plugins.', 'streaming.', 'libraries.'
        ]
        is_admin_path = any(requested_path.startswith(prefix) for prefix in admin_path_prefixes)
        is_admin_endpoint = bool(requested_endpoint) and any(
            requested_endpoint.startswith(prefix) for prefix in admin_endpoint_prefixes
        )
        if is_admin_path or is_admin_endpoint:
            return redirect(url_for('auth.admin_login', next=next_url))

        # Public portal → user login when enabled, else admin login
        allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
        if allow_user_accounts:
            return redirect(url_for('auth.user_login', next=next_url))
        return redirect(url_for('auth.admin_login', next=next_url))

    with app.app_context():
        initialize_settings_from_db(app)
        
        # Initialize plugin system only if plugins table exists
        try:
            from app.services.plugin_manager import plugin_manager
            from app.models_plugins import Plugin
            
            inspector = inspect(db.engine)
            if inspector.has_table(Plugin.__tablename__):
                plugin_manager.initialize_core_plugins()
                plugin_manager.load_all_enabled_plugins()
                current_app.logger.info("Plugin system initialized successfully.")
            else:
                current_app.logger.warning("Plugins table not found during initialization. Plugin system will be initialized after migrations.")
        except Exception as e:
            current_app.logger.error(f"Error initializing plugin system: {e}", exc_info=True)

        # Automatic migration of legacy Plex settings
        try:
            from app.models_media_services import MediaServer, ServiceType
            plex_url = Setting.get('PLEX_URL')
            plex_token = Setting.get('PLEX_TOKEN')
            if plex_url and plex_token:
                plex_server_exists = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
                if not plex_server_exists:
                    plex_server = MediaServer(
                        name='Plex Media Server',
                        service_type=ServiceType.PLEX,
                        url=plex_url,
                        api_key=plex_token,
                        is_active=True
                    )
                    db.session.add(plex_server)
                    db.session.commit()
                    app.logger.info("Successfully migrated legacy Plex settings to the new media server model.")
        except Exception as e:
            app.logger.error(f"Could not migrate legacy Plex settings: {e}")

    if app.config.get('SCHEDULER_API_ENABLED', True):
        if not scheduler.running:
            try:
                scheduler.init_app(app)
                scheduler.start(paused=app.config.get('SCHEDULER_PAUSED_ON_START', False))
                app.logger.info("APScheduler started successfully")
                
                is_werkzeug_main_process = os.environ.get("WERKZEUG_RUN_MAIN") == "true"
                should_schedule_tasks = False

                if is_werkzeug_main_process:
                    should_schedule_tasks = True
                elif not app.testing: # Not Flask's reloader, and not testing (e.g., Gunicorn worker or direct python run.py)
                    should_schedule_tasks = True
                else: 
                    should_schedule_tasks = False

                if should_schedule_tasks:
                    with app.app_context():
                        try:
                            inspector = inspect(db.engine)
                            if inspector.has_table(Setting.__tablename__):
                                from .services import task_service
                                task_service.schedule_all_tasks()
                                app.logger.info("Scheduled background tasks successfully.")

                                try:
                                    from .services.plex_websocket_monitor import start_plex_websocket_monitor
                                    start_plex_websocket_monitor(app)
                                except Exception as plex_ws_error:
                                    app.logger.error(
                                        "Failed to start Plex WebSocket monitor: %s",
                                        plex_ws_error,
                                        exc_info=True,
                                    )
                            else:
                                app.logger.warning("Init.py - Settings table not found when trying to schedule tasks; task scheduling that depends on DB settings is skipped.")
                        except Exception as e_task_sched:
                            app.logger.error(f"Init.py - Error during task scheduling DB interaction or call: {e_task_sched}", exc_info=True)
                else:
                    pass  # Task scheduling skipped for this worker

            except Exception as e_scheduler_init:
                app.logger.error(f"Init.py - Failed to initialize/start APScheduler or prepare for task scheduling: {e_scheduler_init}", exc_info=True)
        else:
            app.logger.info("APScheduler already running")

    # Register runtime hooks from a dedicated module (user_loader, before_request hooks).
    from .hooks import register_app_hooks
    register_app_hooks(app)
    
    # Register blueprints
    # Authentication blueprint - register without url_prefix to enable root-level routes
    from .routes.auth import bp as auth_bp
    app.register_blueprint(auth_bp)
    from .routes.setup import bp as setup_bp
    app.register_blueprint(setup_bp, url_prefix='/setup')
    # Deprecated HTML admin UI blueprints disabled in favor of React SPA
    # from .routes.dashboard import bp as dashboard_bp
    # app.register_blueprint(dashboard_bp, url_prefix='/admin')  # React SPA handles /admin
    # from .routes.settings import bp as settings_bp
    # app.register_blueprint(settings_bp, url_prefix='/admin/settings')
    # from .routes.plugin_management import bp as plugin_management_bp
    # app.register_blueprint(plugin_management_bp, url_prefix='/admin/settings/plugins')
    # from .routes.admin_management import bp as admin_management_bp
    # app.register_blueprint(admin_management_bp, url_prefix='/admin/settings/admins')
    # from .routes.role_management import bp as role_management_bp
    # app.register_blueprint(role_management_bp, url_prefix='/admin/settings/admin/roles')
    # Legacy users blueprint disabled - now using React SPA for /admin/users
    # from .routes.users import bp as users_bp
    # app.register_blueprint(users_bp, url_prefix='/admin/users')
    # from .routes.admin_user import admin_user_bp
    # app.register_blueprint(admin_user_bp, url_prefix='/admin/user')
    # Legacy invites blueprints - admin disabled, public still active for invite acceptance
    from .routes.invites import bp_public as invites_public_bp, bp_admin as invites_admin_bp
    app.register_blueprint(invites_public_bp)  # Keep public invites active for accepting invites
    # app.register_blueprint(invites_admin_bp, url_prefix='/admin/invites')  # Disabled - using React SPA
    from .routes.api import bp as api_bp
    app.register_blueprint(api_bp, url_prefix='/admin/api')
    from .routes.public_api_v1 import bp as public_api_v1_bp
    app.register_blueprint(public_api_v1_bp, url_prefix='/api/v1')
    from .routes.api_v1 import bp as api_v1_bp
    app.register_blueprint(api_v1_bp, url_prefix='/admin/api/v1')
    # Register OpenAPI3-powered API v2 (admin)
    try:
        from .routes.api_v2 import api_v2 as api_v2_bp
        app.register_api(api_v2_bp, url_prefix='/admin/api/v2')
    except Exception as e:
        app.logger.error(f"Failed to register api_v2 (OpenAPI): {e}")
    # Register OpenAPI3-powered Public API v2
    try:
        from .routes.api_v2.public import api_v2_public as api_v2_public_bp
        app.register_api(api_v2_public_bp, url_prefix='/api/v2')
    except Exception as e:
        app.logger.error(f"Failed to register api_v2_public (OpenAPI): {e}")
    from .routes.user import bp as user_bp
    app.register_blueprint(user_bp)
    # Media servers - needed for setup routes
    from .routes.media_servers import bp_setup as media_servers_setup_bp, bp_admin as media_servers_admin_bp
    app.register_blueprint(media_servers_setup_bp)  # Setup routes stay at /setup/plugins/...
    # app.register_blueprint(media_servers_admin_bp, url_prefix='/admin')  # Disabled - React SPA
    # from .routes.plugins import bp as plugins_bp
    # app.register_blueprint(plugins_bp, url_prefix='/admin')
    from .routes.user_preferences import user_preferences_bp
    app.register_blueprint(user_preferences_bp, url_prefix='/settings/preferences')
    # from .routes.streaming import bp as streaming_bp
    # app.register_blueprint(streaming_bp, url_prefix='/admin')
    # Legacy libraries blueprint disabled - now using React SPA for /admin/libraries
    # from .routes.libraries import bp as libraries_bp
    # app.register_blueprint(libraries_bp, url_prefix='/admin')
    from .routes.websockets import bp as websockets_bp
    app.register_blueprint(websockets_bp)
    # (legacy handcrafted OpenAPI spec removed; v2 auto docs are used)

    # Register React SPA blueprint LAST to act as catch-all for /admin UI routes
    # This serves the React app for any /admin path not handled by the above blueprints
    # IMPORTANT: Must be registered after all other /admin blueprints
    from .routes.admin_spa import admin_spa_bp
    app.register_blueprint(admin_spa_bp, url_prefix='/admin')

    # Public SPA (invite + setup UI)
    from .routes.public_spa import public_spa_bp
    app.register_blueprint(public_spa_bp)

    # Removed legacy admin settings SPA interception helpers.
    
    register_error_handlers(app)

    return app
