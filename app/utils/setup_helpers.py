from __future__ import annotations

from flask import current_app
from sqlalchemy import inspect

from app.extensions import db
from app.models import User, Setting


def get_completed_steps() -> set[str]:
    completed: set[str] = set()
    owner_table_exists_steps = False
    try:
        inspector = inspect(db.engine)
        owner_table_exists_steps = inspector.has_table(User.__tablename__)
    except Exception as e:
        current_app.logger.error(f"DB inspection error in get_completed_steps: {e}")

    if owner_table_exists_steps and User.get_owner():
        completed.add('account')
    if Setting.get('APP_BASE_URL'):
        completed.add('app')

    # Check if plugins have been configured (enabled AND have servers)
    try:
        from app.models_plugins import Plugin, PluginStatus
        enabled_plugins_with_servers = Plugin.query.filter(
            Plugin.status == PluginStatus.ENABLED,
            Plugin.servers_count > 0
        ).all()
        if enabled_plugins_with_servers:
            completed.add('plugins')
    except Exception:
        # Plugin tables might not exist yet during early setup
        pass

    discord_enabled_setting_val = Setting.get('DISCORD_OAUTH_ENABLED')
    if discord_enabled_setting_val is not None:
        is_discord_truly_disabled = (
            isinstance(discord_enabled_setting_val, bool) and not discord_enabled_setting_val
        ) or (
            isinstance(discord_enabled_setting_val, str) and discord_enabled_setting_val.lower() == 'false'
        )
        is_discord_configured_if_enabled = Setting.get('DISCORD_CLIENT_ID') and Setting.get('DISCORD_CLIENT_SECRET')
        is_discord_truly_enabled = (
            isinstance(discord_enabled_setting_val, bool) and discord_enabled_setting_val
        ) or (
            isinstance(discord_enabled_setting_val, str) and discord_enabled_setting_val.lower() == 'true'
        )

        if is_discord_truly_disabled:
            completed.add('discord')
        elif is_discord_truly_enabled and is_discord_configured_if_enabled:
            completed.add('discord')

    return completed


def is_setup_finished() -> bool:
    """Check if the initial setup has been completed by the user."""
    setup_complete = Setting.get('SETUP_COMPLETE')
    if setup_complete is not None:
        if isinstance(setup_complete, bool):
            return setup_complete
        if isinstance(setup_complete, str):
            return setup_complete.lower() == 'true'
    return False


def mark_setup_complete() -> None:
    """Mark the initial setup as complete."""
    Setting.set('SETUP_COMPLETE', 'true')
    db.session.commit()

