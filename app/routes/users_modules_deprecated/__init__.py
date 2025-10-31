"""
DEPRECATED: Legacy SSR users module package. The admin Users UI migrated to the React SPA
and communicates via `/admin/api/v2`. This package remains only for historical reference.
"""

from flask import Blueprint

# Create the main users blueprint
users_bp = Blueprint("users", __name__)

# Import deprecated submodules so their routes are registered to the blueprint
from . import main_deprecated as main
from . import sync_deprecated as sync
from . import delete_deprecated as delete
from . import mass_edit_deprecated as mass_edit
from . import linking_deprecated as linking
from . import api_deprecated as api
from . import debug_deprecated as debug
from . import helpers_deprecated as helpers
