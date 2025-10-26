# File: app/__init__.py
import os
import logging
from logging.handlers import RotatingFileHandler
import secrets
from datetime import datetime 
from werkzeug.middleware.proxy_fix import ProxyFix
from flask import Flask, g, request, redirect, url_for, current_app, render_template, flash, send_from_directory, jsonify
from flask_login import current_user

from .config import config
from .extensions import (
    db,
    migrate,
    login_manager,
    csrf,
    scheduler,
    babel,
    htmx,
    socketio,
    cache
)
from .models import User, UserType, Setting, EventType
from .utils import helpers 

def get_locale_for_babel():
    return 'en'

def initialize_settings_from_db(app_instance):
    """Initialize settings from database, with robust error handling for missing tables"""
    # Set a default SECRET_KEY first
    if not app_instance.config.get('SECRET_KEY'): 
        app_instance.config['SECRET_KEY'] = secrets.token_hex(32)
    
    engine_conn = None
    try:
        # Check if we can even connect to the database
        engine_conn = db.engine.connect()
        
        # Check if the settings table exists
        if not db.engine.dialect.has_table(engine_conn, Setting.__tablename__):
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
            
            # Handle SECRET_KEY specifically
            db_sk = settings_dict.get('SECRET_KEY')
            if db_sk: 
                app_instance.config['SECRET_KEY'] = db_sk
                
            app_instance.logger.info("Application settings loaded from database.")
            
    except Exception as e: 
        app_instance.logger.warning(f"Could not load settings from database: {e}. Using defaults.")
        # Continue with defaults - don't fail the app startup
    finally:
        if engine_conn: 
            try:
                engine_conn.close()
            except:
                pass

def register_error_handlers(app):
    @app.errorhandler(400)
    def bad_request_page(error): 
        # Check if this is a CSRF error
        error_description = str(error.description) if hasattr(error, 'description') else ""
        wants_json = (
            request.path.startswith('/admin/api/')
            or request.accept_mimetypes['application/json'] >= request.accept_mimetypes['text/html']
        )
        if wants_json:
            response = jsonify({
                'error': {
                    'code': 'BAD_REQUEST',
                    'message': error_description or 'Bad request.'
                }
            })
            response.status_code = 400
            return response
        return render_template("errors/400.html", error_description=error_description), 400
    @app.errorhandler(403)
    def forbidden_page(error): return render_template("errors/403.html"), 403
    @app.route('/favicon.ico')
    def favicon():
        return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/x-icon')

    @app.errorhandler(404)
    def page_not_found(error):
        from flask import current_app
        from flask_login import current_user

        if request.path.startswith('/admin') and current_user.is_authenticated:
            dist_path = os.path.join(current_app.root_path, 'static', 'dist')
            index_path = os.path.join(dist_path, 'index.html')
            if os.path.exists(index_path):
                current_app.logger.debug('Serving React SPA for 404 path: %s', request.path)
                return send_from_directory(dist_path, 'index.html')

        return render_template("errors/404.html"), 404

    @app.errorhandler(500)
    def server_error_page(error): return render_template("errors/500.html"), 500
    
def create_app(config_name=None):
    if config_name is None:
        config_name = os.environ.get('FLASK_ENV', 'default')
    
    app = Flask(__name__, instance_relative_config=True)
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
    htmx.init_app(app)
    babel.init_app(app, locale_selector=get_locale_for_babel)
    socketio.init_app(app)

    # Initialize Flask-Caching with simple in-memory backend
    # For production with multiple workers, change to Redis
    cache.init_app(app, config={
        'CACHE_TYPE': 'simple',  # In-memory cache for single worker
        'CACHE_DEFAULT_TIMEOUT': 3600  # 1 hour default timeout
    })
    
    # Define custom unauthorized handler to route to correct login page based on requested endpoint
    @login_manager.unauthorized_handler
    def unauthorized():
        # Get the endpoint that was being requested
        requested_endpoint = request.endpoint
        next_url = request.full_path if request.full_path != '/' else None
        
        # Get the path being requested
        requested_path = request.path
        
        # If the path or endpoint is related to admin area, redirect to admin login
        admin_path_prefixes = ['/admin/', '/admin?', '/admin#']
        admin_endpoint_prefixes = [
            'dashboard.', 'settings.', 'plugin_management.', 'admin_management.',
            'role_management.', 'users.', 'invites_admin.', 'media_servers_admin.',
            'plugins.', 'streaming.', 'libraries.'
        ]
        
        is_admin_path = any(requested_path.startswith(prefix) for prefix in admin_path_prefixes)
        is_admin_endpoint = requested_endpoint and any(
            requested_endpoint.startswith(prefix) for prefix in admin_endpoint_prefixes
        )
        
        if is_admin_path or is_admin_endpoint:
            return redirect(url_for('auth.admin_login', next=next_url))
        
        # If user accounts are enabled and not an admin endpoint, route to user login
        allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
        if allow_user_accounts:
            # For user portal endpoints or any other non-admin endpoint
            return redirect(url_for('auth.user_login', next=next_url))
        
        # Default fallback to admin login
        return redirect(url_for('auth.admin_login', next=next_url))

    with app.app_context():
        initialize_settings_from_db(app)
        
        # Initialize plugin system only if plugins table exists
        try:
            from app.services.plugin_manager import plugin_manager
            from app.models_plugins import Plugin
            
            # Check if plugins table exists before initializing
            engine_conn = None
            try:
                engine_conn = db.engine.connect()
                if db.engine.dialect.has_table(engine_conn, Plugin.__tablename__):
                    plugin_manager.initialize_core_plugins()
                    plugin_manager.load_all_enabled_plugins()
                    current_app.logger.info("Plugin system initialized successfully.")
                else:
                    current_app.logger.warning("Plugins table not found during initialization. Plugin system will be initialized after migrations.")
            finally:
                if engine_conn:
                    engine_conn.close()
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
                        engine_conn_scheduler = None
                        try:
                            engine_conn_scheduler = db.engine.connect()
                            if db.engine.dialect.has_table(engine_conn_scheduler, Setting.__tablename__):
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
                        finally:
                            if engine_conn_scheduler:
                                engine_conn_scheduler.close()
                else:
                    pass  # Task scheduling skipped for this worker

            except Exception as e_scheduler_init:
                app.logger.error(f"Init.py - Failed to initialize/start APScheduler or prepare for task scheduling: {e_scheduler_init}", exc_info=True)
        else:
            app.logger.info("APScheduler already running")

    app.jinja_env.filters['format_datetime_human'] = helpers.format_datetime_human
    app.jinja_env.filters['time_ago'] = helpers.time_ago
    app.jinja_env.filters['humanize_time'] = helpers.humanize_time
    from app.utils.timezone_utils import format_datetime, format_datetime_user
    app.jinja_env.filters['format_datetime_tz'] = format_datetime
    app.jinja_env.filters['format_datetime_user'] = format_datetime_user
    app.jinja_env.globals['get_text_color_for_bg'] = helpers.get_text_color_for_bg
    app.jinja_env.filters['format_duration'] = helpers.format_duration
    app.jinja_env.filters['format_json'] = helpers.format_json
    app.jinja_env.filters['extract_jellyfin_user_info'] = helpers.extract_jellyfin_user_info
    app.jinja_env.globals['EventType'] = EventType
    
    # Make datetime functions available in templates
    app.jinja_env.globals['datetime'] = datetime

    @app.context_processor
    def inject_current_year():
        from app.utils.timezone_utils import now
        return {'current_year': now().year}
    
    @app.context_processor
    def inject_url_helpers():
        from app.utils.helpers import encode_url_component, generate_url_slug
        return {
            'encode_url_component': encode_url_component,
            'generate_url_slug': generate_url_slug
        }

    @login_manager.user_loader
    def load_user(user_id):
        # Updated user loader for unified User model with userType:uuid format
        try:
            with app.app_context():
                # Handle the new format: "userType:uuid"
                if ':' in str(user_id):
                    user_type_str, user_uuid = str(user_id).split(':', 1)
                    
                    # Map userType strings to UserType enum values
                    type_mapping = {
                        'owner': UserType.OWNER,
                        'local': UserType.LOCAL, 
                        'service': UserType.SERVICE
                    }
                    
                    user_type_enum = type_mapping.get(user_type_str.lower())
                    if user_type_enum:
                        # Look up user by UUID and userType
                        user = User.query.filter_by(uuid=user_uuid, userType=user_type_enum).first()
                        return user
                
                # Fallback: try as direct UUID lookup (for backward compatibility)
                try:
                    user = User.query.filter_by(uuid=str(user_id)).first()
                    if user:
                        return user
                except Exception:
                    pass
                
                # Legacy fallback: try as numeric ID
                try:
                    actual_id = int(user_id)
                    # Try to find by ID in the unified User table
                    user = User.query.get(actual_id)
                    if user:
                        return user
                except ValueError:
                    pass  # Not a numeric ID
                
                return None
        except Exception as e_load_user:
            app.logger.error(f"Init.py - load_user(): Error loading user: {e_load_user}")
            return None

    @app.before_request
    def check_force_password_change():
        if current_user.is_authenticated and \
           getattr(current_user, 'force_password_change', False) and \
           request.endpoint not in ['settings.account', 'dashboard.account', 'static', 'auth.logout']:
            flash("For security, you must change your temporary password before proceeding.", "warning")
            return redirect(url_for('dashboard.account'))

    @app.before_request
    def before_request_tasks():
        g.app_name = current_app.config.get('APP_NAME', 'Multimedia User Manager')
        g.plex_url = None; g.app_base_url = None
        g.discord_oauth_enabled_for_invite = False; g.setup_complete = False 

        # Initialize plugin system if not already done and tables exist
        try:
            from app.services.plugin_manager import plugin_manager
            from app.models_plugins import Plugin
            
            if not hasattr(plugin_manager, '_initialized'):
                engine_conn = None
                try:
                    engine_conn = db.engine.connect()
                    if db.engine.dialect.has_table(engine_conn, Plugin.__tablename__):
                        plugin_manager.initialize_core_plugins()
                        plugin_manager.load_all_enabled_plugins()
                        plugin_manager._initialized = True
                        current_app.logger.info("Plugin system initialized successfully after migrations.")
                finally:
                    if engine_conn:
                        engine_conn.close()
        except Exception as e:
            current_app.logger.debug(f"Plugin system initialization check: {e}")

        # Debug endpoint tracking removed for cleaner logs

        try:
            engine_conn_br = None; settings_table_exists = False
            try:
                engine_conn_br = db.engine.connect()
                settings_table_exists = db.engine.dialect.has_table(engine_conn_br, Setting.__tablename__)
            except Exception as e_db_check:
                current_app.logger.warning(f"Init.py - before_request_tasks(): DB connection/table check error: {e_db_check}")
            finally:
                if engine_conn_br: engine_conn_br.close()

            if settings_table_exists:
                g.app_name = Setting.get('APP_NAME', current_app.config.get('APP_NAME', 'MUM'))
                g.plex_url = Setting.get('PLEX_URL')
                g.app_base_url = Setting.get('APP_BASE_URL')
                discord_setting_val = Setting.get('DISCORD_OAUTH_ENABLED', False)
                g.discord_oauth_enabled_for_invite = discord_setting_val if isinstance(discord_setting_val, bool) else str(discord_setting_val).lower() == 'true'

                # Check if Owner exists
                owner_present = False
                try:
                    owner_present = User.get_owner() is not None
                except Exception as e:
                    current_app.logger.debug(f"Error checking owner presence: {e}")
                    owner_present = False
                
                app_config_done = bool(g.app_base_url)
                
                # Setup is complete if owner account exists and basic app config is done
                # Plugin configuration is handled separately and doesn't affect setup completion
                g.setup_complete = owner_present and app_config_done
                
                # Check if at least one plugin is enabled (separate from setup completion)
                plugins_configured = False
                try:
                    from app.models_plugins import Plugin, PluginStatus
                    enabled_plugins_with_servers = Plugin.query.filter(
                        Plugin.status == PluginStatus.ENABLED,
                        Plugin.servers_count > 0
                    ).all()
                    plugins_configured = len(enabled_plugins_with_servers) > 0
                    # Plugin count logging removed for cleaner logs
                except Exception as e:
                    current_app.logger.warning(f"Could not check plugin status: {e}")
                    plugins_configured = False
                
                # Setup status logging removed for cleaner logs
            else: 
                g.setup_complete = False
                # Settings table status logging removed for cleaner logs
        except Exception as e_g_hydrate:
            current_app.logger.error(f"Init.py - before_request_tasks(): Error hydrating g values: {e_g_hydrate}", exc_info=True)
        
        current_app.config['SETUP_COMPLETE'] = g.setup_complete

        # Allow access to setup-related endpoints and auth endpoints
        setup_allowed_endpoints = [
            'setup.',
            'auth.',
            'static',
            'api.',
            # Plugin management endpoints - needed during setup
            'plugin_management.',
            # Media server routes - needed for setup
            'media_servers.',
            'setup.plugins',
            # Allow plugin management endpoints in both setup and normal flows
            'dashboard.settings_plugins',
            'plugins.enable_plugin',
            'plugins.disable_plugin',
            'plugins.reload_plugins',
            'plugins.install_plugin',
            'plugins.uninstall_plugin'
        ]
        
        # --- Setup redirection logic (only when setup is incomplete) ---
        if not g.setup_complete and \
           request.endpoint and \
           not any(request.endpoint.startswith(prefix) or request.endpoint == prefix.rstrip('.') 
                  for prefix in setup_allowed_endpoints):
            
            # Setup redirect logging removed for cleaner logs
            try:
                # Check if Owner exists for setup redirection
                owner_exists = False
                try:
                    owner_exists = User.get_owner() is not None
                except Exception as e:
                    current_app.logger.debug(f"Error checking owner for redirect: {e}")
                    owner_exists = False
                
                if not owner_exists:
                    if request.endpoint != 'setup.account_setup' and request.endpoint != 'setup.plex_sso_callback_setup_admin':
                        current_app.logger.info(f"Init.py - before_request_tasks(): Redirecting to account_setup (no owner).")
                        return redirect(url_for('setup.account_setup'))
            except Exception as e_setup_redirect:
                current_app.logger.error(f"Init.py - before_request_tasks(): DB error during setup redirection logic: {e_setup_redirect}", exc_info=True)
                if request.endpoint != 'setup.account_setup':
                     pass # Avoid redirect loop if account_setup itself errors
        
        # --- Plugin validation logic (only runs after setup is complete) ---
        # This ensures users can't access the app without at least one plugin enabled
        # BUT only applies this restriction if setup is complete
        if g.setup_complete:
            try:
                plugins_configured = False
                try:
                    from app.models_plugins import Plugin, PluginStatus
                    # Check plugin configuration status for access control
                    # Ensure any pending database changes are committed and refresh the session
                    db.session.commit()
                    db.session.close()  # Close current session to ensure fresh data
                    enabled_plugins = Plugin.query.filter(Plugin.status == PluginStatus.ENABLED).all()
                    plugins_configured = len(enabled_plugins) > 0
                    # Plugin status logging removed for cleaner logs
                except Exception as e:
                    current_app.logger.error(f"Init.py - before_request_tasks(): Error checking plugins configuration: {e}")
                    plugins_configured = False
                
                if not plugins_configured:
                    # When no plugins are enabled and setup is complete, only allow access to plugin management endpoints
                    # and essential auth/static endpoints
                    allowed_endpoints = [
                        'plugin_management.index', 'plugins.enable_plugin', 'plugins.disable_plugin',
                        'plugins.reload_plugins', 'plugins.install_plugin', 'plugins.uninstall_plugin',
                        'auth.app_login', 'auth.admin_login', 'auth.logout', 'static', 'api.health',
                        # Plugin management endpoints for server configuration
                        'plugin_management.configure', 'plugin_management.edit_server', 'plugin_management.add_server',
                        'plugin_management.disable_server', 'plugin_management.enable_server', 'plugin_management.delete_server',
                        'plugin_management.test_connection', 'plugin_management.test_existing_server_connection',
                        'plugin_management.get_raw_server_info',
                        # Media server setup endpoints
                        'media_servers_setup.setup_list_servers', 'media_servers_setup.add_server_setup', 'media_servers_setup.setup_edit_server', 'media_servers_setup.test_connection_setup', 'media_servers_setup.delete_server_setup'
                    ]
                    
                    # Block ALL routes except the explicitly allowed ones when no plugins are configured
                    # This prevents bypassing the lockdown via any route (users, invites, dashboard, etc.)
                    should_redirect = (not request.endpoint or request.endpoint not in allowed_endpoints)
                    
                    # Plugin redirect logging removed for cleaner logs
                    
                    if should_redirect:
                        # Prevent redirect loop - don't redirect if we're already on the plugin management page
                        if request.endpoint != 'plugin_management.index':
                            current_app.logger.info(f"Init.py - before_request_tasks(): No plugins enabled, blocking access to '{request.endpoint}', redirecting to plugins settings.")
                            return redirect(url_for('plugin_management.index'))
            except Exception as e_plugin_check:
                current_app.logger.error(f"Init.py - before_request_tasks(): DB error during plugin validation: {e_plugin_check}", exc_info=True)


    # Register blueprints
    # Authentication blueprint - register without url_prefix to enable root-level routes
    from .routes.auth import bp as auth_bp
    app.register_blueprint(auth_bp)
    from .routes.setup import bp as setup_bp
    app.register_blueprint(setup_bp, url_prefix='/setup')
    from .routes.dashboard import bp as dashboard_bp
    app.register_blueprint(dashboard_bp, url_prefix='/admin') # Admin dashboard now under /admin
    from .routes.settings import bp as settings_bp
    app.register_blueprint(settings_bp, url_prefix='/admin/settings')
    from .routes.plugin_management import bp as plugin_management_bp
    app.register_blueprint(plugin_management_bp, url_prefix='/admin/settings/plugins')
    from .routes.admin_management import bp as admin_management_bp
    app.register_blueprint(admin_management_bp, url_prefix='/admin/settings/admins')
    from .routes.role_management import bp as role_management_bp
    app.register_blueprint(role_management_bp, url_prefix='/admin/settings/admin/roles')
    # Legacy users blueprint disabled - now using React SPA for /admin/users
    # from .routes.users import bp as users_bp
    # app.register_blueprint(users_bp, url_prefix='/admin/users')
    from .routes.admin_user import admin_user_bp
    app.register_blueprint(admin_user_bp, url_prefix='/admin/user')
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
    from .routes.user import bp as user_bp
    app.register_blueprint(user_bp)
    # Media servers - needed for setup routes
    from .routes.media_servers import bp_setup as media_servers_setup_bp, bp_admin as media_servers_admin_bp
    app.register_blueprint(media_servers_setup_bp)  # Setup routes stay at /setup/plugins/...
    app.register_blueprint(media_servers_admin_bp, url_prefix='/admin')  # Admin routes at /admin/servers/...
    from .routes.plugins import bp as plugins_bp
    app.register_blueprint(plugins_bp, url_prefix='/admin')
    from .routes.user_preferences import user_preferences_bp
    app.register_blueprint(user_preferences_bp, url_prefix='/settings/preferences')
    from .routes.streaming import bp as streaming_bp
    app.register_blueprint(streaming_bp, url_prefix='/admin')
    # Legacy libraries blueprint disabled - now using React SPA for /admin/libraries
    # from .routes.libraries import bp as libraries_bp
    # app.register_blueprint(libraries_bp, url_prefix='/admin')
    from .routes.websockets import bp as websockets_bp
    app.register_blueprint(websockets_bp)
    # OpenAPI documentation endpoint
    from .routes.openapi import openapi_bp
    app.register_blueprint(openapi_bp, url_prefix='/admin/api')

    # Register React SPA blueprint LAST to act as catch-all for /admin UI routes
    # This serves the React app for any /admin path not handled by the above blueprints
    # IMPORTANT: Must be registered after all other /admin blueprints
    from .routes.admin_spa import admin_spa_bp
    app.register_blueprint(admin_spa_bp, url_prefix='/admin')

    def _serve_admin_settings_spa():
        dist_path = os.path.join(app.root_path, 'static', 'dist')
        index_path = os.path.join(dist_path, 'index.html')
        if not os.path.exists(index_path):
            current_app.logger.error('React SPA build not found at %s', index_path)
            return (
                '<h1>React App Not Built</h1>'
                '<p>The React admin interface has not been built yet.</p>'
                '<p>Please run: <code>cd frontend && npm run build</code></p>'
            ), 500

        return send_from_directory(dist_path, 'index.html')

    @app.before_request
    def _intercept_admin_settings_spa():
        if request.method != 'GET':
            return None

        path = request.path.rstrip('/')
        if not path.startswith('/admin/settings'):
            return None

        if path.startswith('/admin/api'):
            return None

        if path == '/admin/settings' or path.startswith('/admin/settings'):
            return _serve_admin_settings_spa()

        return None


    register_error_handlers(app)

    # Register template filters
    from app.utils.timezone_utils import format_datetime_user
    from datetime import timezone
    
    @app.template_filter('format_datetime_with_user_timezone')
    def format_datetime_with_user_timezone_filter(dt, format_str='%Y-%m-%d %H:%M'):
        """Template filter to format datetime with user's timezone preference."""
        if dt is None:
            return "N/A"
        
        from flask_login import current_user
        from app.models import User, UserType, UserPreferences
        
        if not current_user.is_authenticated:
            # Fallback to UTC if no user
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.strftime(format_str)
        
        prefs = UserPreferences.get_timezone_preference(current_user.id)
        preference = prefs.get('preference', 'local')
        local_timezone_str = prefs.get('local_timezone')
        time_format = prefs.get('time_format', '12')
        
        # Adjust format string based on user's time format preference
        if '%H' in format_str and time_format == '12':
            format_str = format_str.replace('%H:%M', '%I:%M %p')
        elif '%I' in format_str and time_format == '24':
            format_str = format_str.replace('%I:%M %p', '%H:%M')
        
        if preference == 'utc':
            # Show in UTC
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            utc_dt = dt.astimezone(timezone.utc)
            return utc_dt.strftime(format_str)
        
        if local_timezone_str:
            try:
                import pytz
                from flask import current_app
                
                local_tz = pytz.timezone(local_timezone_str)
                #current_app.logger.debug(f"Timezone conversion: original dt = {dt}, timezone = {local_timezone_str}")
                
                # Ensure datetime has timezone info before conversion
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                    #current_app.logger.debug(f"Timezone conversion: added UTC timezone, dt = {dt}")
                
                local_dt = dt.astimezone(local_tz)
                #current_app.logger.debug(f"Timezone conversion: converted to local, local_dt = {local_dt}")
                
                formatted = local_dt.strftime(format_str)
                #current_app.logger.debug(f"Timezone conversion: formatted result = {formatted}")
                return formatted
            except pytz.UnknownTimeZoneError as e:
                current_app.logger.error(f"Unknown timezone: {local_timezone_str}, error: {e}")
                pass
            except Exception as e:
                current_app.logger.error(f"Timezone conversion error: {e}")
                pass
        
        # Fallback to UTC
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.strftime(format_str)
    
    # Make the function available as a global template function too
    app.jinja_env.globals['format_datetime_with_user_timezone'] = format_datetime_with_user_timezone_filter
    
    return app
