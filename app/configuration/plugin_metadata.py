"""
Plugin metadata configuration - Single source of truth for plugin information.
This module defines all metadata for built-in media service plugins.
"""

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional


@dataclass
class PluginMetadata:
    """Metadata for a media service plugin."""
    plugin_id: str
    name: str
    description: str
    author: str
    icon_type: str  # 'svg', 'fontawesome'
    icon_identifier: str  # FontAwesome class or 'plex' for custom SVG
    color_theme: str  # Service-specific color theme (e.g., 'plex', 'jellyfin')
    features: List[str]
    requires_api_key: bool
    supports_websocket: bool = False
    icon_class: Optional[str] = None  # FontAwesome class for small badges/icons
    config_schema: Dict[str, Any] = field(default_factory=dict)


# Plugin metadata registry
PLUGIN_METADATA: Dict[str, PluginMetadata] = {
    'plex': PluginMetadata(
        plugin_id='plex',
        name='Plex',
        description='Connect to Plex Media Server for movies, TV shows, music, and more',
        author='MUM Team',
        icon_type='svg',
        icon_identifier='plex',
        icon_class='fa-solid fa-play',
        color_theme='plex',
        features=['streaming', 'libraries', 'users', 'webhooks', 'overseerr', 'tautulli'],
        requires_api_key=True,
        supports_websocket=True,
        config_schema={
            'websocket_refresh_interval': {
                'type': 'integer',
                'default': 30,
                'min': 2,
                'max': 300,
                'description': 'WebSocket refresh interval in seconds'
            }
        }
    ),
    'jellyfin': PluginMetadata(
        plugin_id='jellyfin',
        name='Jellyfin',
        description='Connect to Jellyfin Media Server - free and open-source media system',
        author='MUM Team',
        icon_type='fontawesome',
        icon_identifier='fa-solid fa-cube',
        icon_class='fa-solid fa-cube',
        color_theme='jellyfin',
        features=['streaming', 'libraries', 'users', 'webhooks'],
        requires_api_key=True,
        supports_websocket=False,
    ),
    'emby': PluginMetadata(
        plugin_id='emby',
        name='Emby',
        description='Connect to Emby Media Server for comprehensive media management',
        author='MUM Team',
        icon_type='fontawesome',
        icon_identifier='fa-solid fa-play-circle',
        icon_class='fa-solid fa-play-circle',
        color_theme='emby',
        features=['streaming', 'libraries', 'users', 'webhooks'],
        requires_api_key=True,
        supports_websocket=False,
    ),
    'kavita': PluginMetadata(
        plugin_id='kavita',
        name='Kavita',
        description='Connect to Kavita for manga, comics, and ebook management',
        author='MUM Team',
        icon_type='fontawesome',
        icon_identifier='fa-solid fa-book',
        icon_class='fa-solid fa-book',
        color_theme='kavita',
        features=['libraries', 'users'],
        requires_api_key=True,
        supports_websocket=False,
    ),
    'audiobookshelf': PluginMetadata(
        plugin_id='audiobookshelf',
        name='AudioBookshelf',
        description='Connect to AudioBookshelf for audiobooks and podcasts',
        author='MUM Team',
        icon_type='fontawesome',
        icon_identifier='fa-solid fa-headphones',
        icon_class='fa-solid fa-headphones',
        color_theme='audiobookshelf',
        features=['libraries', 'users'],
        requires_api_key=True,
        supports_websocket=False,
    ),
    'komga': PluginMetadata(
        plugin_id='komga',
        name='Komga',
        description='Connect to Komga media server for comics and manga',
        author='MUM Team',
        icon_type='fontawesome',
        icon_identifier='fa-solid fa-book-open',
        icon_class='fa-solid fa-book-open',
        color_theme='komga',
        features=['libraries', 'users'],
        requires_api_key=True,
        supports_websocket=False,
    ),
    'romm': PluginMetadata(
        plugin_id='romm',
        name='RomM',
        description='Connect to RomM for retro gaming ROM management',
        author='MUM Team',
        icon_type='fontawesome',
        icon_identifier='fa-solid fa-gamepad',
        icon_class='fa-solid fa-gamepad',
        color_theme='romm',
        features=['libraries', 'users'],
        requires_api_key=True,
        supports_websocket=False,
    ),
}


def get_plugin_metadata(plugin_id: str) -> Optional[PluginMetadata]:
    """Get metadata for a specific plugin."""
    return PLUGIN_METADATA.get(plugin_id.lower())


def get_all_plugin_metadata() -> Dict[str, PluginMetadata]:
    """Get all plugin metadata."""
    return PLUGIN_METADATA.copy()
