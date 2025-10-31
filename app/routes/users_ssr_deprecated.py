# File: app/routes/users.py
"""Main users module following Flask blueprint best practices"""

# Import the users blueprint from the user_modules package
# This automatically registers all routes from the submodules
from app.routes.users_modules_deprecated import users_bp as bp
# DEPRECATED: Legacy Flask SSR user routes. Replaced by React SPA.
