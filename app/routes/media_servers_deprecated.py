"""DEPRECATED: Media servers SSR re-exporter.

Previously re-exported setup/admin SSR blueprints. SPA + API v2 supersede these.
Left for historical reference.
"""
from flask import Blueprint, redirect, url_for  # noqa: F401

from app.routes.media_servers_modules_deprecated.setup_deprecated import bp as media_servers_setup_bp  # noqa: F401
from app.routes.media_servers_modules_deprecated.admin_deprecated import bp as media_servers_admin_bp  # noqa: F401

bp_setup = media_servers_setup_bp  # noqa: F401
bp_admin = media_servers_admin_bp  # noqa: F401
