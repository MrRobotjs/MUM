# File: app/services/plugin_manager.py
import os
import sys
import json
import importlib
from typing import Dict, List, Optional, Type, Any
from flask import current_app
from app.models_plugins import Plugin, PluginStatus, PluginType
from app.services.base_media_service import BaseMediaService
from app.extensions import db
from datetime import datetime
import subprocess
import tempfile
import shutil

class PluginManager:
    """Manages plugin loading, installation, and lifecycle"""
    
    def __init__(self):
        self._loaded_plugins: Dict[str, Type[BaseMediaService]] = {}
        self._plugin_instances: Dict[str, BaseMediaService] = {}
        self._core_plugins = {
            'plex': {
                'name': 'Plex',
                'module_path': 'app.services.plex_media_service',
                'service_class': 'PlexMediaService',
                'description': 'Plex Media Server integration with full feature support',
                'supported_features': ['user_management', 'library_access', 'active_sessions', 'downloads', 'transcoding', 'sharing', 'invitations'],
                'config_schema': {
                    'type': 'object',
                    'properties': {
                        'timeout': {'type': 'integer', 'default': 10, 'minimum': 5, 'maximum': 60}
                    }
                }
            },
            'emby': {
                'name': 'Emby',
                'module_path': 'app.services.emby_media_service',
                'service_class': 'EmbyMediaService',
                'description': 'Emby Server integration with user management and streaming',
                'supported_features': ['user_management', 'library_access', 'active_sessions', 'downloads', 'transcoding']
            },
            'jellyfin': {
                'name': 'Jellyfin',
                'module_path': 'app.services.jellyfin_media_service',
                'service_class': 'JellyfinMediaService',
                'description': 'Jellyfin Server integration with user management and streaming',
                'supported_features': ['user_management', 'library_access', 'active_sessions', 'downloads', 'transcoding']
            },
            'kavita': {
                'name': 'Kavita',
                'module_path': 'app.services.kavita_media_service',
                'service_class': 'KavitaMediaService',
                'description': 'Kavita comic/manga server integration',
                'supported_features': ['user_management', 'library_access', 'downloads']
            },
            'audiobookshelf': {
                'name': 'AudiobookShelf',
                'module_path': 'app.services.audiobookshelf_media_service',
                'service_class': 'AudiobookShelfMediaService',
                'description': 'AudiobookShelf audiobook server integration',
                'supported_features': ['user_management', 'library_access', 'active_sessions', 'downloads']
            },
            'komga': {
                'name': 'Komga',
                'module_path': 'app.services.komga_media_service',
                'service_class': 'KomgaMediaService',
                'description': 'Komga comic server integration',
                'supported_features': ['user_management', 'library_access', 'downloads']
            },
            'romm': {
                'name': 'RomM',
                'module_path': 'app.services.romm_media_service',
                'service_class': 'RommMediaService',
                'description': 'RomM retro gaming server integration',
                'supported_features': ['user_management', 'library_access', 'downloads']
            }
        }
    
    def initialize_core_plugins(self):
        """Initialize core plugins in the database"""
        try:
            # Check if plugins table exists by attempting a simple query
            Plugin.query.first()
        except Exception as e:
            # If plugins table doesn't exist yet (during migrations), skip initialization
            current_app.logger.warning(f"Plugins table not available during initialization: {e}")
            return
            
        for plugin_id, plugin_info in self._core_plugins.items():
            existing = Plugin.query.filter_by(plugin_id=plugin_id).first()
            
            if not existing:
                plugin = Plugin(
                    plugin_id=plugin_id,
                    name=plugin_info['name'],
                    description=plugin_info['description'],
                    version='1.0.0',
                    plugin_type=PluginType.CORE,
                    status=PluginStatus.DISABLED,  # Start disabled, user chooses
                    enabled_by_user=False,
                    module_path=plugin_info['module_path'],
                    service_class=plugin_info['service_class'],
                    supported_features=plugin_info['supported_features'],
                    config_schema=plugin_info.get('config_schema', {}),
                    author='MUM Team',
                    license='None'
                )
                db.session.add(plugin)
        
        db.session.commit()
    
    def get_available_plugins(self) -> List[Plugin]:
        """Get all available plugins"""
        return Plugin.query.all()
    
    def get_enabled_plugins(self) -> List[Plugin]:
        """Get only enabled plugins"""
        return Plugin.query.filter_by(enabled_by_user=True).all()
    
    def enable_plugin(self, plugin_id: str) -> bool:
        """Enable a plugin"""
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
        if not plugin:
            return False
        
        try:
            # Load the plugin
            service_class = self._load_plugin(plugin)
            if not service_class:
                plugin.status = PluginStatus.ERROR
                plugin.last_error = "Failed to load plugin class"
                plugin.enabled_by_user = True
                db.session.commit()
                return False
            
            # Test instantiation
            test_config = {
                'id': 0,
                'name': 'test',
                'service_type': plugin_id,
                'url': 'http://test',
                'api_key': 'test',
                'config': {}
            }
            
            try:
                test_instance = service_class(test_config)
                # Store the loaded class
                self._loaded_plugins[plugin_id] = service_class
            except Exception as e:
                plugin.status = PluginStatus.ERROR
                plugin.last_error = f"Plugin instantiation failed: {str(e)}"
                plugin.enabled_by_user = True
                db.session.commit()
                return False
            
            plugin.status = PluginStatus.ENABLED
            plugin.enabled_by_user = True
            plugin.last_error = None
            plugin.last_updated = datetime.utcnow()
            
            db.session.commit()
            
            current_app.logger.info(f"Plugin '{plugin_id}' enabled successfully")
            return True
            
        except Exception as e:
            plugin.status = PluginStatus.ERROR
            plugin.last_error = str(e)
            db.session.commit()
            current_app.logger.error(f"Failed to enable plugin '{plugin_id}': {e}")
            return False
    
    def disable_plugin(self, plugin_id: str) -> bool:
        """Disable a plugin and deactivate its servers"""
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
        if not plugin:
            return False
        
        try:
            # Allow disabling the last plugin - user will be trapped on plugins page until they enable another
            
            # Remove from loaded plugins
            if plugin_id in self._loaded_plugins:
                del self._loaded_plugins[plugin_id]
            
            if plugin_id in self._plugin_instances:
                del self._plugin_instances[plugin_id]
            
            plugin.status = PluginStatus.DISABLED
            plugin.enabled_by_user = False
            plugin.last_error = None
            db.session.commit()
            
            current_app.logger.info(f"Plugin '{plugin_id}' disabled successfully")
            return True
            
        except Exception as e:
            plugin.last_error = str(e)
            db.session.commit()
            current_app.logger.error(f"Failed to disable plugin '{plugin_id}': {e}")
            return False
    
    def _load_plugin(self, plugin: Plugin) -> Optional[Type[BaseMediaService]]:
        """Load a plugin class from its module"""
        try:
            # Import the module
            module = importlib.import_module(plugin.module_path)
            
            # Get the service class
            service_class = getattr(module, plugin.service_class)
            
            # Verify it's a BaseMediaService subclass
            if not issubclass(service_class, BaseMediaService):
                raise ValueError(f"Plugin class {plugin.service_class} is not a BaseMediaService subclass")
            
            return service_class
            
        except ImportError as e:
            current_app.logger.error(f"Failed to import plugin module {plugin.module_path}: {e}")
            return None
        except AttributeError as e:
            current_app.logger.error(f"Plugin class {plugin.service_class} not found in {plugin.module_path}: {e}")
            return None
        except Exception as e:
            current_app.logger.error(f"Error loading plugin {plugin.plugin_id}: {e}")
            return None

    def _load_plugin_with_error(self, plugin: Plugin) -> tuple[Optional[Type[BaseMediaService]], Optional[str]]:
        """Load a plugin class and return a detailed error message if it fails"""
        try:
            module = importlib.import_module(plugin.module_path)
            service_class = getattr(module, plugin.service_class)
            if not issubclass(service_class, BaseMediaService):
                return None, f"Plugin class {plugin.service_class} is not a BaseMediaService subclass"
            return service_class, None
        except ImportError as e:
            return None, f"Failed to import plugin module {plugin.module_path}: {e}"
        except AttributeError as e:
            return None, f"Plugin class {plugin.service_class} not found in {plugin.module_path}: {e}"
        except Exception as e:
            return None, f"Error loading plugin {plugin.plugin_id}: {e}"
    
    def get_plugin_class(self, plugin_id: str) -> Optional[Type[BaseMediaService]]:
        """Get a loaded plugin class"""
        if plugin_id in self._loaded_plugins:
            return self._loaded_plugins[plugin_id]
        
        # Try to load if not already loaded
        plugin = Plugin.query.filter_by(plugin_id=plugin_id, enabled_by_user=True).first()
        if plugin:
            service_class = self._load_plugin(plugin)
            if service_class:
                self._loaded_plugins[plugin_id] = service_class
                return service_class
        
        return None
    
    def load_all_enabled_plugins(self):
        """Load all enabled plugins at startup"""
        enabled_plugins = self.get_enabled_plugins()
        
        for plugin in enabled_plugins:
            try:
                service_class, load_error = self._load_plugin_with_error(plugin)
                if service_class:
                    self._loaded_plugins[plugin.plugin_id] = service_class
                    current_app.logger.info(f"Loaded plugin: {plugin.plugin_id}")
                    plugin.status = PluginStatus.ENABLED
                    plugin.last_error = None
                else:
                    current_app.logger.error(
                        f"Failed to load enabled plugin: {plugin.plugin_id}. {load_error}"
                    )
                    plugin.status = PluginStatus.ERROR
                    plugin.last_error = load_error or "Failed to load at startup"
            except Exception as e:
                current_app.logger.error(f"Error loading plugin {plugin.plugin_id}: {e}")
                plugin.status = PluginStatus.ERROR
                plugin.last_error = str(e)
        
        db.session.commit()
    
    def install_plugin_from_file(self, file_path: str) -> bool:
        """Install a plugin from a file"""
        try:
            # Extract and validate plugin
            with tempfile.TemporaryDirectory() as temp_dir:
                # Extract plugin archive
                shutil.unpack_archive(file_path, temp_dir)
                
                # Look for plugin manifest
                manifest_path = os.path.join(temp_dir, 'plugin.json')
                if not os.path.exists(manifest_path):
                    raise ValueError("Plugin manifest (plugin.json) not found")
                
                with open(manifest_path, 'r') as f:
                    manifest = json.load(f)
                
                # Validate manifest
                required_fields = ['plugin_id', 'name', 'version', 'module_path', 'service_class']
                for field in required_fields:
                    if field not in manifest:
                        raise ValueError(f"Required field '{field}' missing from manifest")
                
                # Check if plugin already exists
                existing = Plugin.query.filter_by(plugin_id=manifest['plugin_id']).first()
                if existing and existing.plugin_type == PluginType.CORE:
                    raise ValueError("Cannot override core plugins")
                
                # Install plugin files
                plugin_dir = os.path.join(current_app.instance_path, 'plugins', manifest['plugin_id'])
                os.makedirs(plugin_dir, exist_ok=True)
                
                # Copy plugin files
                for item in os.listdir(temp_dir):
                    src = os.path.join(temp_dir, item)
                    dst = os.path.join(plugin_dir, item)
                    if os.path.isdir(src):
                        shutil.copytree(src, dst, dirs_exist_ok=True)
                    else:
                        shutil.copy2(src, dst)
                
                # Install Python requirements if specified
                if 'python_requirements' in manifest:
                    self._install_requirements(manifest['python_requirements'])
                
                # Create or update plugin record
                if existing:
                    plugin = existing
                    plugin.version = manifest['version']
                    plugin.last_updated = datetime.utcnow()
                else:
                    plugin = Plugin(
                        plugin_id=manifest['plugin_id'],
                        plugin_type=PluginType.COMMUNITY,
                        installed_at=datetime.utcnow()
                    )
                    db.session.add(plugin)
                
                # Update plugin fields from manifest
                plugin.name = manifest['name']
                plugin.description = manifest.get('description', '')
                plugin.version = manifest['version']
                plugin.module_path = f"plugins.{manifest['plugin_id']}.{manifest['module_path']}"
                plugin.service_class = manifest['service_class']
                plugin.author = manifest.get('author', 'Unknown')
                plugin.homepage = manifest.get('homepage')
                plugin.license = manifest.get('license')
                plugin.supported_features = manifest.get('supported_features', [])
                plugin.config_schema = manifest.get('config_schema', {})
                plugin.default_config = manifest.get('default_config', {})
                plugin.min_mum_version = manifest.get('min_mum_version')
                plugin.max_mum_version = manifest.get('max_mum_version')
                plugin.status = PluginStatus.DISABLED  # Start disabled
                
                db.session.commit()
                
                current_app.logger.info(f"Plugin '{manifest['plugin_id']}' installed successfully")
                return True
                
        except Exception as e:
            current_app.logger.error(f"Failed to install plugin: {e}")
            return False
    
    def _install_requirements(self, requirements: List[str]):
        """Install Python requirements for a plugin"""
        for requirement in requirements:
            try:
                subprocess.check_call([
                    sys.executable, '-m', 'pip', 'install', requirement
                ])
            except subprocess.CalledProcessError as e:
                raise ValueError(f"Failed to install requirement '{requirement}': {e}")
    
    def uninstall_plugin(self, plugin_id: str) -> bool:
        """Uninstall a plugin"""
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
        if not plugin:
            return False
        
        if plugin.plugin_type == PluginType.CORE:
            return False  # Cannot uninstall core plugins
        
        if not plugin.can_be_disabled():
            return False  # Cannot uninstall if in use
        
        try:
            # Disable first
            self.disable_plugin(plugin_id)
            
            # Remove plugin files
            plugin_dir = os.path.join(current_app.instance_path, 'plugins', plugin_id)
            if os.path.exists(plugin_dir):
                shutil.rmtree(plugin_dir)
            
            # Remove from database
            db.session.delete(plugin)
            db.session.commit()
            
            current_app.logger.info(f"Plugin '{plugin_id}' uninstalled successfully")
            return True
            
        except Exception as e:
            current_app.logger.error(f"Failed to uninstall plugin '{plugin_id}': {e}")
            return False
    
    def get_plugin_info(self, plugin_id: str) -> Optional[Dict[str, Any]]:
        """Get detailed information about a plugin"""
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
        if not plugin:
            return None
        
        return {
            'plugin_id': plugin.plugin_id,
            'name': plugin.name,
            'description': plugin.description,
            'version': plugin.version,
            'status': plugin.status.value,
            'plugin_type': plugin.plugin_type.value,
            'author': plugin.author,
            'homepage': plugin.homepage,
            'license': plugin.license,
            'supported_features': plugin.supported_features,
            'servers_count': plugin.servers_count,
            'can_be_disabled': plugin.can_be_disabled(),
            'last_error': plugin.last_error,
            'installed_at': plugin.installed_at,
            'last_updated': plugin.last_updated
        }
    
    def refresh_servers_count(self):
        """Refresh plugin servers count to ensure accuracy"""
        try:
            from app.models_media_services import MediaServer, ServiceType
            
            plugins = Plugin.query.all()
            for plugin in plugins:
                try:
                    # Find the corresponding ServiceType enum value
                    service_type = None
                    for st in ServiceType:
                        if st.value == plugin.plugin_id:
                            service_type = st
                            break
                    
                    if service_type:
                        # Count actual servers
                        actual_count = MediaServer.query.filter_by(service_type=service_type).count()
                        if plugin.servers_count != actual_count:
                            plugin.servers_count = actual_count
                            db.session.add(plugin)
                            current_app.logger.debug(f"Updated plugin {plugin.plugin_id} servers_count from {plugin.servers_count} to {actual_count}")
                    else:
                        # For plugins without corresponding ServiceType, set to 0
                        if plugin.servers_count != 0:
                            current_app.logger.debug(f"Setting plugin {plugin.plugin_id} servers_count to 0 (no ServiceType)")
                            plugin.servers_count = 0
                            db.session.add(plugin)
                except Exception as e:
                    current_app.logger.error(f"Error updating servers_count for plugin {plugin.plugin_id}: {e}")
            
            db.session.commit()
            current_app.logger.info("Plugin servers count refresh completed")
        except Exception as e:
            current_app.logger.error(f"Error refreshing plugin servers count: {e}")
            db.session.rollback()

# Global plugin manager instance
plugin_manager = PluginManager()
