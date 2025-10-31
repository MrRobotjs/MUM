"""DEPRECATED: SSR invites blueprints (replaced by SPA + API v2 public endpoints)."""

# Import the invites blueprint from the invite_modules package
# This automatically registers all routes from the submodules
from app.routes.invite_modules_deprecated import invites_public_bp as bp_public, invites_admin_bp as bp_admin
