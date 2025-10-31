# File: app/routes/user.py
"""Main user module following Flask blueprint best practices"""

# Import the user blueprint from the user_modules package
# This automatically registers all routes from the submodules
from app.routes.user_modules import user_bp as bp
"""DEPRECATED: Legacy user SSR blueprint. Replaced by React SPA at /user."""
