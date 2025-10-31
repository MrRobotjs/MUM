"""
Libraries module package following Flask blueprint best practices

This package contains all library management functionality split into focused modules:
- main: Core library listing and overview functionality
- sync: Library synchronization with external services  
- details: Library, media, and episode detail views
- statistics: Charts, analytics, and statistical data
- api: API endpoints for library operations
- helpers: Shared utility functions and classes
"""

from flask import Blueprint

# Create the main libraries blueprint
libraries_bp = Blueprint("libraries", __name__)

# DEPRECATED: SSR libraries blueprint modules are not used by the React SPA.
# Leave blueprint defined for reference; do not register submodules.
# from . import main
# from . import sync
# from . import details
# from . import api
# from . import helpers
# from . import statistics
