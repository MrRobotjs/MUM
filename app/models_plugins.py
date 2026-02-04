# File: app/models_plugins.py
import enum
import json
from datetime import datetime
from app.utils.timezone_utils import utcnow
from sqlalchemy.types import TypeDecorator, TEXT
from sqlalchemy.ext.mutable import MutableDict
from app.extensions import db
from app.extensions import JSONEncodedDict

class PluginStatus(enum.Enum):
    DISABLED = "disabled"
    ENABLED = "enabled"
    ERROR = "error"
    INSTALLING = "installing"
    UPDATING = "updating"

class PluginType(enum.Enum):
    CORE = "core"           # Built-in services
    OFFICIAL = "official"   # Official extensions
    COMMUNITY = "community" # Community plugins
    CUSTOM = "custom"       # User-created plugins

class Plugin(db.Model):
    """Represents a service plugin/module"""
    __tablename__ = 'plugins'
    
    id = db.Column(db.Integer, primary_key=True)
    
    # Plugin identification
    plugin_id = db.Column(db.String(100), unique=True, nullable=False, index=True)  # e.g., "plex", "emby"
    name = db.Column(db.String(100), nullable=False)  # Display name
    description = db.Column(db.Text, nullable=True)
    version = db.Column(db.String(20), nullable=False)
    
    # Plugin metadata
    plugin_type = db.Column(db.Enum(PluginType), nullable=False, default=PluginType.CORE)
    status = db.Column(db.Enum(PluginStatus), nullable=False, default=PluginStatus.DISABLED)
    enabled_by_user = db.Column(db.Boolean, nullable=False, default=False)
    
    # Plugin details
    author = db.Column(db.String(100), nullable=True)
    homepage = db.Column(db.String(512), nullable=True)
    repository = db.Column(db.String(512), nullable=True)
    license = db.Column(db.String(50), nullable=True)
    
    # Technical details
    module_path = db.Column(db.String(255), nullable=False)  # Python module path
    service_class = db.Column(db.String(255), nullable=False)  # Class name
    config_schema = db.Column(MutableDict.as_mutable(JSONEncodedDict), default=dict)  # JSON schema for config
    default_config = db.Column(MutableDict.as_mutable(JSONEncodedDict), default=dict)
    
    # Requirements and compatibility
    min_mum_version = db.Column(db.String(20), nullable=True)
    max_mum_version = db.Column(db.String(20), nullable=True)
    python_requirements = db.Column(JSONEncodedDict, default=list)  # pip packages
    
    # Features supported by this plugin
    supported_features = db.Column(JSONEncodedDict, default=list)  # List of supported features
    
    # Installation and status
    installed_at = db.Column(db.DateTime, nullable=True)
    last_updated = db.Column(db.DateTime, nullable=True)
    last_error = db.Column(db.Text, nullable=True)
    
    # Usage statistics
    servers_count = db.Column(db.Integer, default=0)  # Number of servers using this plugin
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def __repr__(self):
        return f'<Plugin {self.plugin_id} ({self.status.value})>'
    
    @property
    def is_enabled(self):
        return bool(self.enabled_by_user)
    
    @property
    def is_core(self):
        return self.plugin_type == PluginType.CORE
    
    def can_be_disabled(self):
        """Check if plugin can be disabled (core plugins with active servers cannot)"""
        if self.plugin_type == PluginType.CORE and self.servers_count > 0:
            return False
        return True
    
    def get_config_with_defaults(self, user_config=None):
        """Merge user config with default config"""
        config = self.default_config.copy() if self.default_config else {}
        if user_config:
            config.update(user_config)
        return config

class PluginRepository(db.Model):
    """Represents a plugin repository source"""
    __tablename__ = 'plugin_repositories'
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    url = db.Column(db.String(512), nullable=False)
    description = db.Column(db.Text, nullable=True)
    
    is_enabled = db.Column(db.Boolean, default=True, nullable=False)
    is_official = db.Column(db.Boolean, default=False, nullable=False)
    
    # Authentication for private repos
    auth_type = db.Column(db.String(20), nullable=True)  # 'token', 'basic', etc.
    auth_data = db.Column(db.Text, nullable=True)  # Encrypted auth data
    
    last_sync = db.Column(db.DateTime, nullable=True)
    last_error = db.Column(db.Text, nullable=True)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def __repr__(self):
        return f'<PluginRepository {self.name}>'
