"""Admin SPA route handler

Serves the React SPA for /admin UI routes while preserving API routes.

IMPORTANT: This blueprint should be registered LAST to act as a catch-all
for any /admin routes not handled by API or legacy blueprints.
"""

from flask import Blueprint, send_from_directory, current_app, request
from app.utils.helpers import setup_required
import os

# Create blueprint with high url_prefix specificity to avoid conflicts
admin_spa_bp = Blueprint('admin_spa', __name__)


@admin_spa_bp.route('/', defaults={'path': ''})
@admin_spa_bp.route('/<path:path>')
@setup_required
def serve_spa(path):
    """
    Serve the React SPA for /admin UI routes.

    This is a catch-all route that serves the React app for any path under /admin
    that hasn't been handled by other blueprints (like API routes).

    The React app is built to app/static/dist/ during the build process.
    React Router handles client-side routing once the app loads.

    Examples of paths handled:
    - /admin → Dashboard
    - /admin/dashboard → Dashboard
    - /admin/users → Users list
    - /admin/users/abc-123 → User detail
    - /admin/settings/general → General settings

    API routes (/admin/api/*) are NOT handled here - they're handled by api_bp.
    """
    # Path to the React build output
    dist_path = os.path.join(current_app.root_path, 'static', 'dist')
    index_path = os.path.join(dist_path, 'index.html')

    # Check if the React build exists
    if not os.path.exists(index_path):
        current_app.logger.error(f"React SPA build not found at {index_path}")
        current_app.logger.error("Please run: cd frontend && npm run build")
        current_app.logger.error(f"Expected path: {index_path}")
        return (
            "<h1>React App Not Built</h1>"
            "<p>The React admin interface has not been built yet.</p>"
            "<p>Please run: <code>cd frontend && npm run build</code></p>"
        ), 500

    # Log SPA serving for debugging (can be removed in production)
    current_app.logger.debug(f"Serving React SPA for path: /admin/{path}")

    # Serve the React app's index.html for all UI routes
    # React Router will parse the path and render the appropriate component
    return send_from_directory(dist_path, 'index.html')
