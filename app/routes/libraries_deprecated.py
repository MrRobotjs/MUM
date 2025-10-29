"""Main libraries module following Flask blueprint best practices (DEPRECATED COPY)"""

# Import the libraries blueprint from the library_modules package
# This automatically registers all routes from the submodules
from app.routes.library_modules import libraries_bp as bp

