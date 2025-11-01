# File: app/services/__init__.py

# This file makes 'services' a Python package.
# You can also import service functions here for easier access if desired, e.g.:
# from .plex_service import get_plex_instance, get_plex_libraries
# from .user_service import sync_users_from_plex, update_user_details
# from .invite_service import validate_invite, accept_invite_and_grant_access
# from .task_service import schedule_plex_session_monitoring

# For now, keeping it simple.

# Deprecated services re-exports for backwards compatibility in deprecated routes
try:
    from . import history_service_deprecated as history_service  # noqa: F401
except Exception:
    pass
