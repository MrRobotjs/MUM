"""
Invites module package following Flask blueprint best practices

This package contains all invite functionality split into focused modules:
- main: Core invite processing and public functionality
- manage: Admin management (list, create, toggle, delete)
- auth: Authentication initiation (Plex and Discord)
- callbacks: OAuth callback handlers
- edit: Invite editing functionality  
- bulk_operations: Bulk operations on multiple invites
"""

from flask import Blueprint

# Public invites blueprint (keeps endpoint name 'invites' for backward-compatible url_for)
invites_public_bp = Blueprint("invites", __name__)

# Admin invites blueprint (separate endpoint name)
invites_admin_bp = Blueprint("invites_admin", __name__)

# Import submodules so their routes are registered to the appropriate blueprint
# Public modules (deprecated; SPA + v2 now handle these flows)
# from . import auth
# from . import callbacks

# Admin modules (deprecated SSR/legacy endpoints); not imported/registered
# from . import manage
# from . import edit
# from . import bulk_operations
