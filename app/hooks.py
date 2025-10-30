from __future__ import annotations

from flask import current_app, g, request, redirect, url_for, flash
from flask_login import current_user

from app.extensions import login_manager, db
from sqlalchemy import inspect
from app.models import User, UserType, Setting


def register_app_hooks(app):
    @login_manager.user_loader
    def load_user(user_id):
        try:
            with app.app_context():
                if ':' in str(user_id):
                    user_type_str, user_uuid = str(user_id).split(':', 1)
                    type_mapping = {
                        'owner': UserType.OWNER,
                        'local': UserType.LOCAL,
                        'service': UserType.SERVICE,
                    }
                    user_type_enum = type_mapping.get(user_type_str.lower())
                    if user_type_enum:
                        user = User.query.filter_by(uuid=user_uuid, userType=user_type_enum).first()
                        return user

                try:
                    user = User.query.filter_by(uuid=str(user_id)).first()
                    if user:
                        return user
                except Exception:
                    pass

                try:
                    actual_id = int(user_id)
                    user = User.query.get(actual_id)
                    if user:
                        return user
                except ValueError:
                    pass

                return None
        except Exception as e_load_user:
            app.logger.error(f"hooks.load_user(): Error loading user: {e_load_user}")
            return None

    @app.before_request
    def check_force_password_change():
        if not current_user.is_authenticated:
            return None
        if not getattr(current_user, 'force_password_change', False):
            return None
        allowed_prefixes = (
            '/admin/api/v2/auth/change-password',
            '/admin/api/v2/auth/set-password',
            '/admin/api/v2/auth/logout',
        )
        if request.path.startswith(allowed_prefixes):
            return None
        if request.method == 'GET' and request.path.startswith('/admin') and not request.path.startswith('/admin/api'):
            flash("For security, please change your password before proceeding.", "warning")
            return redirect('/admin/account')
        return None

    @app.before_request
    def before_request_tasks():
        g.app_name = current_app.config.get('APP_NAME', 'Multimedia User Manager')
        g.plex_url = None
        g.app_base_url = None
        g.discord_oauth_enabled_for_invite = False
        g.setup_complete = False

        try:
            from app.services.plugin_manager import plugin_manager
            from app.models_plugins import Plugin

            if not hasattr(plugin_manager, '_initialized'):
                try:
                    inspector = inspect(db.engine)
                    if inspector.has_table(Plugin.__tablename__):
                        plugin_manager.initialize_core_plugins()
                        plugin_manager.load_all_enabled_plugins()
                        plugin_manager._initialized = True
                        current_app.logger.info("Plugin system initialized successfully after migrations.")
                except Exception as e:
                    current_app.logger.debug(f"Plugin system inspection/init failed: {e}")
        except Exception as e:
            current_app.logger.debug(f"Plugin system initialization check: {e}")

        try:
            settings_table_exists = False
            try:
                inspector = inspect(db.engine)
                settings_table_exists = inspector.has_table(Setting.__tablename__)
            except Exception as e_db_check:
                current_app.logger.warning(f"before_request_tasks(): DB inspection error: {e_db_check}")

            if settings_table_exists:
                g.app_name = Setting.get('APP_NAME', current_app.config.get('APP_NAME', 'MUM'))
                g.plex_url = Setting.get('PLEX_URL')
                g.app_base_url = Setting.get('APP_BASE_URL')
                discord_setting_val = Setting.get('DISCORD_OAUTH_ENABLED', False)
                g.discord_oauth_enabled_for_invite = (
                    discord_setting_val if isinstance(discord_setting_val, bool) else str(discord_setting_val).lower() == 'true'
                )

                owner_present = False
                try:
                    owner_present = User.get_owner() is not None
                except Exception as e:
                    current_app.logger.debug(f"Error checking owner presence: {e}")
                    owner_present = False

                app_config_done = bool(g.app_base_url)
                g.setup_complete = owner_present and app_config_done

                plugins_configured = False
                try:
                    from app.models_plugins import Plugin, PluginStatus
                    enabled_plugins_with_servers = Plugin.query.filter(
                        Plugin.status == PluginStatus.ENABLED, Plugin.servers_count > 0
                    ).all()
                    plugins_configured = len(enabled_plugins_with_servers) > 0
                except Exception as e:
                    current_app.logger.warning(f"Could not check plugin status: {e}")
                    plugins_configured = False
            else:
                g.setup_complete = False
        except Exception as e_g_hydrate:
            current_app.logger.error(f"before_request_tasks(): Error hydrating g values: {e_g_hydrate}", exc_info=True)

        current_app.config['SETUP_COMPLETE'] = g.setup_complete

        setup_allowed_endpoints = [
            'setup.',
            'auth.',
            'static',
            'api.',
            'plugin_management.',
            'media_servers.',
            'setup.plugins',
            'dashboard.settings_plugins',
            'plugins.enable_plugin',
            'plugins.disable_plugin',
            'plugins.reload_plugins',
            'plugins.install_plugin',
            'plugins.uninstall_plugin',
        ]

        if (
            not g.setup_complete
            and request.endpoint
            and not any(
                request.endpoint.startswith(prefix) or request.endpoint == prefix.rstrip('.')
                for prefix in setup_allowed_endpoints
            )
        ):
            try:
                owner_exists = False
                try:
                    owner_exists = User.get_owner() is not None
                except Exception as e:
                    current_app.logger.debug(f"Error checking owner for redirect: {e}")
                    owner_exists = False

                if not owner_exists:
                    if request.endpoint != 'setup.account_setup' and request.endpoint != 'setup.plex_sso_callback_setup_admin':
                        current_app.logger.info("Redirecting to account_setup (no owner).")
                        return redirect(url_for('setup.account_setup'))
            except Exception as e_setup_redirect:
                current_app.logger.error(
                    f"before_request_tasks(): DB error during setup redirection logic: {e_setup_redirect}",
                    exc_info=True,
                )

        try:
            from app.models_plugins import Plugin, PluginStatus
            try:
                apps_settings_table_exists = False
                try:
                    inspector = inspect(db.engine)
                    apps_settings_table_exists = inspector.has_table(Setting.__tablename__)
                except Exception:
                    apps_settings_table_exists = False

                if apps_settings_table_exists:
                    # Determine if any enabled plugin has at least one active server by querying ground truth
                    plugins_enabled = False
                    try:
                        enabled_plugin_ids = [p.plugin_id for p in Plugin.query.filter(Plugin.status == PluginStatus.ENABLED).all()]
                        if enabled_plugin_ids:
                            from app.models_media_services import MediaServer, ServiceType
                            enabled_types = []
                            for pid in enabled_plugin_ids:
                                try:
                                    enabled_types.append(ServiceType(pid))
                                except Exception:
                                    # Skip plugin IDs that are not service types
                                    pass
                            if enabled_types:
                                count = MediaServer.query.filter(
                                    MediaServer.is_active.is_(True),
                                    MediaServer.service_type.in_(enabled_types)
                                ).count()
                                plugins_enabled = count > 0
                    except Exception as e:
                        current_app.logger.warning(f"Error while checking plugins enabled: {e}")

                    if g.setup_complete and not plugins_enabled:
                        # React SPA handles plugin management at /admin/settings/plugins
                        # Avoid url_for to a removed blueprint endpoint.
                        allowed_paths = (
                            '/admin/settings/plugins',
                        )
                        current_path = request.path or ''
                        if current_path not in allowed_paths:
                            current_app.logger.info("No plugins enabled, redirecting to plugins settings.")
                            return redirect('/admin/settings/plugins')
            except Exception as e_plugin_check:
                current_app.logger.error(
                    f"before_request_tasks(): DB error during plugin validation: {e_plugin_check}",
                    exc_info=True,
                )
        except Exception:
            pass
