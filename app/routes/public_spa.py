"""Public SPA route handler

Serves the React SPA for public UI routes, including invite flows and
setup UI pages, replacing legacy server-rendered templates.
"""

from flask import Blueprint, send_from_directory, current_app, redirect
from app.utils.helpers import setup_required
from app.utils.helpers import log_event
from app.models import EventType
import os

public_spa_bp = Blueprint('public_spa', __name__)


def _serve_index():
    dist_path = os.path.join(current_app.root_path, 'static', 'dist')
    index_path = os.path.join(dist_path, 'index.html')

    if not os.path.exists(index_path):
        current_app.logger.error(f"React SPA build not found at {index_path}")
        return (
            "<h1>React App Not Built</h1>"
            "<p>The React admin interface has not been built yet.</p>"
            "<p>Please run: <code>cd frontend && npm run build</code></p>",
            500,
        )

    return send_from_directory(dist_path, 'index.html')


# ----- Invite SPA routes -----

@public_spa_bp.route('/invite', methods=['GET'])
@public_spa_bp.route('/invite/', methods=['GET'])
@setup_required
def invite_landing_spa():
    return _serve_index()


@public_spa_bp.route('/invite/<invite_path_or_token>', methods=['GET'])
@setup_required
def invite_token_spa(invite_path_or_token: str):
    try:
        # Log invite view when valid (best-effort; SPA will validate via API)
        from app.services import invite_service
        invite, error_message = invite_service.validate_invite_usability(invite_path_or_token)
        if invite and not error_message:
            log_event(
                EventType.INVITE_VIEWED,
                f"Invite '{invite.custom_path or invite.token}' (ID: {invite.id}) viewed/accessed.",
                invite_id=invite.id,
            )
    except Exception as exc:
        current_app.logger.debug(f"Invite view log skipped: {exc}")
    return _serve_index()


@public_spa_bp.route('/invite/success', methods=['GET'])
@setup_required
def invite_success_spa():
    return _serve_index()


@public_spa_bp.route('/invite/<path:subpath>', methods=['GET'])
@setup_required
def invite_catch_all_spa(subpath: str):
    return _serve_index()


# ----- Setup SPA routes -----

@public_spa_bp.route('/setup', methods=['GET'])
def setup_root_redirect():
    # Friendly redirect to SPA entry
    return redirect('/setup/ui/account')


@public_spa_bp.route('/setup/<path:subpath>', methods=['GET'])
def setup_any_spa(subpath: str):
    return _serve_index()


@public_spa_bp.route('/setup/ui', methods=['GET'])
@public_spa_bp.route('/setup/ui/<path:path>', methods=['GET'])
def setup_ui_spa(path: str | None = None):
    return _serve_index()

# ----- User portal SPA routes -----

@public_spa_bp.route('/user', methods=['GET'])
@public_spa_bp.route('/user/<path:path>', methods=['GET'])
def user_portal_spa(path: str | None = None):
    return _serve_index()

# ----- Auth SPA routes -----

@public_spa_bp.route('/auth/login', methods=['GET'])
def auth_login_spa():
    return _serve_index()
