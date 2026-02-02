from flask_openapi3 import APIBlueprint, Tag

# Define tags used across api_v2 (assigned per-endpoint, not globally)
account_tag = Tag(name="Account", description="Account management endpoints")
public_session_tag = Tag(name="PublicSession", description="Public authentication, session and identity")
public_invite_tag = Tag(name="PublicInvites", description="Public invite validation endpoints")
public_wizard_tag = Tag(name="PublicWizard", description="Invite wizard flow endpoints")

# Create the API v2 blueprint (OpenAPI-aware)
# Do NOT include a url_prefix here; we set it when registering on the app.
# Avoid global tags to prevent endpoints appearing under multiple tag groups.
api_v2 = APIBlueprint(
    name="api_v2",
    import_name=__name__,
    abp_security=[{"BearerAuth": []}],
)

# Ensure module sub-imports register their routes on api_v2
from . import account  # noqa: E402,F401
from . import servers  # noqa: E402,F401
from . import users  # noqa: E402,F401
from . import invites  # noqa: E402,F401
from . import users_detail  # noqa: E402,F401
from . import users_actions  # noqa: E402,F401
from . import users_history  # noqa: E402,F401
from . import users_service_accounts  # noqa: E402,F401
from . import users_overseerr  # noqa: E402,F401
from . import users_settings  # noqa: E402,F401
from . import users_bulk  # noqa: E402,F401
from . import users_sync  # noqa: E402,F401
from . import sync_status  # noqa: E402,F401
from . import users_purge  # noqa: E402,F401
from . import users_debug  # noqa: E402,F401
from . import users_merge  # noqa: E402,F401
from . import invites_bulk  # noqa: E402,F401
from . import invite_public  # noqa: E402,F401
from . import streams_api  # noqa: E402,F401
from . import libraries  # noqa: E402,F401
from . import libraries_actions  # noqa: E402,F401
from . import library_sync_status  # noqa: E402,F401
from . import servers_libraries  # noqa: E402,F401
from . import settings_general  # noqa: E402,F401
from . import settings_user_accounts  # noqa: E402,F401
from . import settings_advanced  # noqa: E402,F401
from . import settings_discord  # noqa: E402,F401
from . import settings_streaming  # noqa: E402,F401
from . import plugins  # noqa: E402,F401
from . import admins  # noqa: E402,F401
from . import admin_roles  # noqa: E402,F401
from . import user_roles  # noqa: E402,F401
from . import metrics  # noqa: E402,F401
from . import setup  # noqa: E402,F401
from . import dashboard  # noqa: E402,F401
from . import streams  # noqa: E402,F401
from . import statistics  # noqa: E402,F401
from . import history  # noqa: E402,F401
from . import auth  # noqa: E402,F401
from . import media_proxy  # noqa: E402,F401
from . import tools_api_debug  # noqa: E402,F401
from . import notifications  # noqa: E402,F401
from . import session  # noqa: E402,F401
from . import invite_wizard  # noqa: E402,F401
