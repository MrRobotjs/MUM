"""
Configuration package for MUM application.
Contains plugin metadata and other configuration modules.
"""

from .plugin_metadata import (
    PluginMetadata,
    PLUGIN_METADATA,
    get_plugin_metadata,
    get_all_plugin_metadata,
)

__all__ = [
    'PluginMetadata',
    'PLUGIN_METADATA',
    'get_plugin_metadata',
    'get_all_plugin_metadata',
]
