from flask import Blueprint

bp = Blueprint('public_api_v1', __name__)

# DEPRECATED: This v1 public API has been replaced by `/api/v2` public endpoints.
# It remains for backwards compatibility and will be removed in a future release.
from . import auth_deprecated as auth  # noqa: E402,F401
from . import me_deprecated as me  # noqa: E402,F401
from . import invites_deprecated as invites  # noqa: E402,F401
from . import invite_wizard_deprecated as invite_wizard  # noqa: E402,F401
