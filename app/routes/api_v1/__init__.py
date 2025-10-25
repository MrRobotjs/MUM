from flask import Blueprint

bp = Blueprint('api_v1', __name__)

# Import modules to register routes with the blueprint
from . import dashboard, streams, statistics, history, auth, users, users_detail, users_actions, users_history, users_service_accounts, users_overseerr, users_settings, users_bulk, users_sync, users_purge, users_debug, sync_status, invites, invites_bulk, invite_public, streams_api, servers, libraries, settings_general, settings_user_accounts, settings_advanced, settings_logs, settings_discord, settings_streaming, plugins, admins, admin_roles, user_roles, metrics, setup, account  # noqa: E402,F401
