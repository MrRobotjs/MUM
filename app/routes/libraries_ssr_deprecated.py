"""Main libraries module following Flask blueprint best practices"""

# Import the libraries blueprint from the library_modules package
# This automatically registers all routes from the submodules
from app.routes.library_modules_deprecated import libraries_bp as bp
# DEPRECATED: Legacy Flask SSR library routes. Replaced by React SPA.
