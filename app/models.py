# File: app/models.py
import enum
import json
import uuid
from datetime import datetime, timedelta
from app.utils.timezone_utils import utcnow
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin
from sqlalchemy.types import TypeDecorator, TEXT
from sqlalchemy.ext.mutable import MutableDict, MutableList
from app.extensions import db, JSONEncodedDict
import secrets
from flask import current_app 
from sqlalchemy import Table, Column, Integer, ForeignKey
from app.models_media_services import MediaServer

# Many-to-many relationship table for users and roles
app_user_roles = db.Table('app_user_roles',
    db.Column('app_user_id', db.Integer, db.ForeignKey('users.id'), primary_key=True),
    db.Column('role_id', db.Integer, db.ForeignKey('roles.id'), primary_key=True)
)

# Many-to-many relationship table for invites and servers
invite_servers = db.Table('invite_servers',
    db.Column('invite_id', db.Integer, db.ForeignKey('invites.id'), primary_key=True),
    db.Column('server_id', db.Integer, db.ForeignKey('media_servers.id'), primary_key=True)
)

class SettingValueType(enum.Enum): # ... (as before)
    STRING = "string"; INTEGER = "integer"; BOOLEAN = "boolean"; JSON = "json"; SECRET = "secret"

class EventType(enum.Enum): # ... (as before, will add bot-specific events later)
    APP_STARTUP = "APP_STARTUP"; APP_SHUTDOWN = "APP_SHUTDOWN"; SETTING_CHANGE = "SETTING_CHANGE"
    ADMIN_LOGIN_SUCCESS = "ADMIN_LOGIN_SUCCESS"; ADMIN_LOGIN_FAIL = "ADMIN_LOGIN_FAIL"; ADMIN_LOGOUT = "ADMIN_LOGOUT"
    ADMIN_PASSWORD_CHANGE = "ADMIN_PASSWORD_CHANGE"; PLEX_CONFIG_TEST_SUCCESS = "PLEX_CONFIG_TEST_SUCCESS"
    PLEX_CONFIG_TEST_FAIL = "PLEX_CONFIG_TEST_FAIL"; PLEX_CONFIG_SAVE = "PLEX_CONFIG_SAVE"
    PLEX_SYNC_USERS_START = "PLEX_SYNC_USERS_START"; PLEX_SYNC_USERS_COMPLETE = "PLEX_SYNC_USERS_COMPLETE"
    PLEX_USER_ADDED = "PLEX_USER_ADDED_TO_SERVER"; PLEX_USER_REMOVED = "PLEX_USER_REMOVED_FROM_SERVER"
    PLEX_USER_LIBS_UPDATED = "PLEX_USER_LIBS_UPDATED_ON_SERVER"; PLEX_SESSION_DETECTED = "PLEX_SESSION_DETECTED"
    MUM_USER_ADDED_FROM_PLEX = "MUM_USER_ADDED_FROM_PLEX"
    MUM_USER_REMOVED_MISSING_IN_PLEX = "MUM_USER_REMOVED_MISSING_IN_PLEX"
    MUM_USER_LIBRARIES_EDITED = "MUM_USER_LIBRARIES_EDITED"
    MUM_USER_DELETED_FROM_MUM = "MUM_USER_DELETED_FROM_MUM"; INVITE_CREATED = "INVITE_CREATED"
    INVITE_DELETED = "INVITE_DELETED"; INVITE_VIEWED = "INVITE_VIEWED"
    INVITE_USED_SUCCESS_PLEX = "INVITE_USED_SUCCESS_PLEX"
    INVITE_USED_SUCCESS_DISCORD = "INVITE_USED_SUCCESS_DISCORD"
    INVITE_USED_ACCOUNT_LINKED = "INVITE_USED_ACCOUNT_LINKED"
    INVITE_USER_ACCEPTED_AND_SHARED = "INVITE_USER_ACCEPTED_AND_SHARED"; INVITE_EXPIRED = "INVITE_EXPIRED"
    INVITE_MAX_USES_REACHED = "INVITE_MAX_USES_REACHED"; DISCORD_CONFIG_SAVE = "DISCORD_CONFIG_SAVE"
    DISCORD_ADMIN_LINK_SUCCESS = "DISCORD_ADMIN_LINK_SUCCESS"
    DISCORD_ADMIN_UNLINK = "DISCORD_ADMIN_UNLINK"; ERROR_GENERAL = "ERROR_GENERAL"
    ERROR_PLEX_API = "ERROR_PLEX_API"; ERROR_DISCORD_API = "ERROR_DISCORD_API"
    DISCORD_BOT_START = "DISCORD_BOT_START"
    DISCORD_BOT_STOP = "DISCORD_BOT_STOP"
    DISCORD_BOT_ERROR = "DISCORD_BOT_ERROR"
    DISCORD_BOT_USER_LEFT_SERVER = "DISCORD_BOT_USER_LEFT_SERVER" # User left Discord
    DISCORD_BOT_USER_REMOVED_FROM_PLEX = "DISCORD_BOT_USER_REMOVED_FROM_PLEX" # Bot removed user from Plex
    DISCORD_BOT_ROLE_ADDED_INVITE_SENT = "DISCORD_BOT_ROLE_ADDED_INVITE_SENT" # Bot sent invite due to role add
    DISCORD_BOT_ROLE_REMOVED_USER_REMOVED = "DISCORD_BOT_ROLE_REMOVED_USER_REMOVED" # Bot removed user due to role removal
    DISCORD_BOT_PURGE_DM_SENT = "DISCORD_BOT_PURGE_DM_SENT" # DM sent for app-initiated purge
    DISCORD_BOT_GUILD_MEMBER_CHECK_FAIL = "DISCORD_BOT_GUILD_MEMBER_CHECK_FAIL" # Failed guild check on invite page
    # Add Bot Specific Event Types Later, e.g., BOT_USER_PURGED, BOT_INVITE_SENT

class Role(db.Model):
    __tablename__ = 'roles'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)
    description = db.Column(db.String(255), nullable=True)
    # Permissions for this role will be stored as a simple JSON list of strings.
    permissions = db.Column(MutableList.as_mutable(JSONEncodedDict), nullable=True, default=list)
    color = db.Column(db.String(7), nullable=True, default='#808080') # Default to a neutral gray
    icon = db.Column(db.String(100), nullable=True)

    def __repr__(self):
        return f'<Role {self.name}>'

class UserType(enum.Enum):
    """User type enumeration for the unified User model"""
    OWNER = "owner"      # Single app owner with ultimate permissions (replaces Owner)
    LOCAL = "local"      # Local accounts that can login (replaces UserAppAccess)
    SERVICE = "service"  # Service-specific accounts (replaces UserMediaAccess)

class User(db.Model, UserMixin):
    """
    Unified User model that replaces Owner, UserAppAccess, and UserMediaAccess
    
    This single table handles all three user types with appropriate nullable fields
    and validation based on userType.
    """
    __tablename__ = 'users'
    
    # Core Identity Fields
    id = db.Column(db.Integer, primary_key=True)
    uuid = db.Column(db.String(36), unique=True, nullable=False, default=lambda: str(uuid.uuid4()), index=True)
    userType = db.Column(db.Enum(UserType), nullable=False, index=True)
    
    # Linking Field - Points to UUID of a LOCAL user for SERVICE users
    linkedUserId = db.Column(db.String(36), db.ForeignKey('users.uuid'), nullable=True, index=True)
    
    # Server Relationship (only for SERVICE users)
    server_id = db.Column(db.Integer, db.ForeignKey('media_servers.id'), nullable=True, index=True)
    
    # External Service Identity (only for SERVICE users)
    external_user_id = db.Column(db.String(255), nullable=True, index=True)
    external_user_alt_id = db.Column(db.String(255), nullable=True)
    external_username = db.Column(db.String(255), nullable=True)
    external_email = db.Column(db.String(120), nullable=True)
    
    # Service Access Permissions (only for SERVICE users)
    allowed_library_ids = db.Column(MutableList.as_mutable(JSONEncodedDict), default=list)
    allow_downloads = db.Column(db.Boolean, default=False, nullable=False)
    allow_4k_transcode = db.Column(db.Boolean, default=True, nullable=False)
    service_settings = db.Column(MutableDict.as_mutable(JSONEncodedDict), default=dict)
    
    # Status & Activity
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    last_activity_at = db.Column(db.DateTime, nullable=True)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=utcnow)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)
    last_login_at = db.Column(db.DateTime, nullable=True)
    
    # Additional Info
    notes = db.Column(db.Text, nullable=True)
    external_avatar_url = db.Column(db.String(512), nullable=True)
    used_invite_id = db.Column(db.Integer, db.ForeignKey('invites.id'), nullable=True, index=True)
    service_join_date = db.Column(db.DateTime, nullable=True, index=True)
    
    # Whitelist Settings
    is_discord_bot_whitelisted = db.Column(db.Boolean, default=False, nullable=False)
    is_purge_whitelisted = db.Column(db.Boolean, default=False, nullable=False)
    
    # Service-Specific Status (primarily for Plex)
    is_home_user = db.Column(db.Boolean, default=False, nullable=False)
    shares_back = db.Column(db.Boolean, default=False, nullable=False)
    
    # Discord Integration (can be global or service-specific)
    discord_user_id = db.Column(db.String(255), nullable=True, index=True)
    discord_username = db.Column(db.String(255), nullable=True)
    discord_avatar_hash = db.Column(db.String(255), nullable=True)
    discord_access_token = db.Column(db.String(255), nullable=True)
    discord_refresh_token = db.Column(db.String(255), nullable=True)
    discord_token_expires_at = db.Column(db.DateTime, nullable=True)
    discord_email = db.Column(db.String(255), nullable=True)
    discord_email_verified = db.Column(db.Boolean, nullable=True)
    
    # Access Expiration
    access_expires_at = db.Column(db.DateTime, nullable=True, index=True)
    
    # Raw Data Storage
    user_raw_data = db.Column(MutableDict.as_mutable(JSONEncodedDict), default=dict)
    stream_raw_data = db.Column(MutableDict.as_mutable(JSONEncodedDict), default=dict)
    
    # Overseerr Integration
    overseerr_user_id = db.Column(db.Integer, nullable=True, index=True)
    
    # Local Account Fields (only for LOCAL and OWNER users)
    localUsername = db.Column(db.String(255), nullable=True, index=True)
    password_hash = db.Column(db.String(256), nullable=True)
    email = db.Column(db.String(255), nullable=True, index=True)  # General email field for all user types
    
    # Owner-Specific Fields (only for OWNER users)
    preferred_user_list_view = db.Column(db.String(10), default='cards', nullable=False)
    force_password_change = db.Column(db.Boolean, default=False, nullable=False)
    
    # Plex Integration (for OWNER users)
    plex_uuid = db.Column(db.String(255), nullable=True)
    plex_username = db.Column(db.String(255), nullable=True)
    plex_thumb = db.Column(db.String(512), nullable=True)
    
    # Relationships
    linked_parent = db.relationship('User', remote_side=[uuid], backref='linked_children')
    roles = db.relationship('Role', secondary='app_user_roles', lazy='subquery',
                            backref=db.backref('users', lazy=True))
    server = db.relationship('MediaServer', foreign_keys=[server_id], back_populates='users')
    
    # Template compatibility property - returns linked service users for templates
    @property
    def linked_service_users(self):
        """Get linked service users for template compatibility"""
        if self.userType == UserType.LOCAL:
            return [child for child in self.linked_children if child.userType == UserType.SERVICE]
        elif self.userType == UserType.SERVICE:
            return [self]  # Service user returns itself
        return []
    
    # Template compatibility property - returns service users for templates  
    @property
    def service_users(self):
        """Get service users for template compatibility"""
        return self.linked_service_users
    
    def __repr__(self):
        if self.userType == UserType.OWNER:
            return f'<User(OWNER) {self.localUsername}>'
        elif self.userType == UserType.LOCAL:
            return f'<User(LOCAL) {self.localUsername}>'
        elif self.userType == UserType.SERVICE:
            server_name = self.server.server_nickname if self.server else 'Unknown'
            return f'<User(SERVICE) {self.external_username} on {server_name}>'
        return f'<User {self.uuid}>'
    
    # Authentication Methods
    def set_password(self, password):
        """Set password hash (only for LOCAL and OWNER users)"""
        if self.userType in [UserType.LOCAL, UserType.OWNER]:
            self.password_hash = generate_password_hash(password, method='pbkdf2:sha256')
    
    def check_password(self, password):
        """Check password (only for LOCAL and OWNER users)"""
        if self.userType in [UserType.LOCAL, UserType.OWNER] and self.password_hash:
            return check_password_hash(self.password_hash, password)
        return False
    
    # Display Methods
    def get_display_name(self):
        """Get the best display name for this user"""
        if self.userType == UserType.OWNER:
            return self.localUsername or self.plex_username or 'Owner'
        elif self.userType == UserType.LOCAL:
            return self.localUsername or 'Local User'
        elif self.userType == UserType.SERVICE:
            return self.external_username or 'Service User'
        return 'Unknown User'
    
    def get_avatar(self, fallback='/static/img/default_avatar.png'):
        """Get the avatar URL for this user"""
        if self.userType == UserType.OWNER and self.plex_thumb:
            return self.plex_thumb
        elif self.userType == UserType.SERVICE and self.external_avatar_url:
            return self.external_avatar_url
        return fallback
    
    def get_email(self):
        """Get the email for this user"""
        if self.userType == UserType.OWNER:
            return self.email
        elif self.userType == UserType.LOCAL:
            return self.email
        elif self.userType == UserType.SERVICE:
            return self.external_email
        return None
    
    # Permission Methods
    def has_permission(self, permission_name):
        """Check if user has a specific permission"""
        if self.userType == UserType.OWNER:
            return True  # Owners have all permissions
        elif self.userType == UserType.LOCAL:
            # Check role-based permissions for local users
            for role in self.roles:
                if permission_name in (role.permissions or []):
                    return True
            return False
        elif self.userType == UserType.SERVICE:
            return False  # Service users have no app permissions
        return False
    
    # Service-Specific Methods
    def get_service_type(self):
        """Get the service type (only for SERVICE users)"""
        if self.userType == UserType.SERVICE and self.server:
            return self.server.service_type.value
        return None
    
    def has_library_access(self, library_id):
        """Check if user has access to a specific library (only for SERVICE users)"""
        if self.userType == UserType.SERVICE and self.allowed_library_ids:
            return str(library_id) in [str(lib_id) for lib_id in self.allowed_library_ids]
        return False
    
    def is_expired(self):
        """Check if user access is expired"""
        if self.access_expires_at:
            from datetime import timezone
            now = datetime.now(timezone.utc)
            expires = self.access_expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            return now > expires
        return False
    
    # Linking Methods
    def get_linked_users(self):
        """Get all users linked to this user (only for LOCAL users)"""
        if self.userType == UserType.LOCAL:
            return User.query.filter_by(linkedUserId=self.uuid, userType=UserType.SERVICE).all()
        return []
    
    def get_linked_parent(self):
        """Get the parent local user (only for SERVICE users)"""
        if self.userType == UserType.SERVICE and self.linkedUserId:
            return User.query.filter_by(uuid=self.linkedUserId, userType=UserType.LOCAL).first()
        return None
    
    def link_to_local_user(self, local_user_uuid):
        """Link this service user to a local user"""
        if self.userType == UserType.SERVICE:
            self.linkedUserId = local_user_uuid
    
    def unlink_from_local_user(self):
        """Unlink this service user from its local user"""
        if self.userType == UserType.SERVICE:
            self.linkedUserId = None
    
    # Flask-Login Methods
    def get_id(self):
        """Return user ID with type prefix for Flask-Login"""
        return f"{self.userType.value}:{self.uuid}"
    
    @property
    def is_authenticated(self):
        """Check if user is authenticated"""
        return self.userType in [UserType.OWNER, UserType.LOCAL]
    
    @property
    def is_anonymous(self):
        """Check if user is anonymous"""
        return False
    
    # Compatibility Methods for existing code
    def get_media_accesses_by_service_type(self):
        """Get linked service users grouped by service type (for LOCAL users)"""
        if self.userType == UserType.LOCAL:
            linked_users = self.get_linked_users()
            accesses_by_type = {}
            for user in linked_users:
                if user.server:
                    service_type = user.server.service_type.value
                    if service_type not in accesses_by_type:
                        accesses_by_type[service_type] = []
                    accesses_by_type[service_type].append(user)
            return accesses_by_type
        return {}
    
    def get_all_servers(self):
        """Get all media servers this user has access to"""
        if self.userType == UserType.LOCAL:
            linked_users = self.get_linked_users()
            return [user.server for user in linked_users if user.server and user.is_active]
        elif self.userType == UserType.SERVICE:
            return [self.server] if self.server and self.is_active else []
        return []
    
    def has_access_to_server(self, server_id):
        """Check if user has access to a specific media server"""
        if self.userType == UserType.LOCAL:
            linked_users = self.get_linked_users()
            return any(user.server_id == server_id and user.is_active for user in linked_users)
        elif self.userType == UserType.SERVICE:
            return self.server_id == server_id and self.is_active
        return False
    
    def get_server_access(self, server_id):
        """Get User object for a specific server"""
        if self.userType == UserType.LOCAL:
            linked_users = self.get_linked_users()
            return next((user for user in linked_users if user.server_id == server_id), None)
        elif self.userType == UserType.SERVICE and self.server_id == server_id:
            return self
        return None
    
    # Class Methods for User Management
    @classmethod
    def create_owner(cls, username, password, email=None):
        """Create the single owner user"""
        if cls.query.filter_by(userType=UserType.OWNER).first():
            raise ValueError("Owner user already exists")
        
        owner = cls(
            userType=UserType.OWNER,
            localUsername=username,
            discord_email=email
        )
        owner.set_password(password)
        return owner
    
    @classmethod
    def create_local_user(cls, username, password, email=None):
        """Create a new local user"""
        user = cls(
            userType=UserType.LOCAL,
            localUsername=username,
            discord_email=email
        )
        user.set_password(password)
        return user
    
    @classmethod
    def create_service_user(cls, server_id, external_user_id, external_username=None, linked_user_uuid=None):
        """Create a new service user"""
        user = cls(
            userType=UserType.SERVICE,
            server_id=server_id,
            external_user_id=external_user_id,
            external_username=external_username,
            linkedUserId=linked_user_uuid
        )
        return user
    
    @classmethod
    def get_owner(cls):
        """Get the single owner user"""
        return cls.query.filter_by(userType=UserType.OWNER).first()
    
    @classmethod
    def get_by_local_username(cls, username):
        """Get user by local username (OWNER or LOCAL users)"""
        return cls.query.filter(
            cls.localUsername == username,
            cls.userType.in_([UserType.OWNER, UserType.LOCAL])
        ).first()
    
    @classmethod
    def get_by_external_id(cls, server_id, external_user_id):
        """Get service user by external ID"""
        return cls.query.filter_by(
            userType=UserType.SERVICE,
            server_id=server_id,
            external_user_id=external_user_id
        ).first()
    
    @classmethod
    def get_linked_users_for_local(cls, local_user_uuid):
        """Get all service users linked to a local user"""
        return cls.query.filter_by(
            userType=UserType.SERVICE,
            linkedUserId=local_user_uuid
        ).all()
    
    # Overseerr Integration Methods
    @classmethod
    def get_overseerr_user_id(cls, server_id, plex_user_id):
        """Get the Overseerr user ID for a given Plex user"""
        user = cls.query.filter_by(
            userType=UserType.SERVICE,
            server_id=server_id,
            external_user_id=plex_user_id
        ).first()
        
        return user.overseerr_user_id if user else None
    
    @classmethod
    def link_single_user(cls, server_id, plex_user_id, plex_username, plex_email=None):
        """Attempt to link a single Plex user to Overseerr on-demand"""
        from app.services.overseerr_service import OverseerrService
        from app.models_media_services import MediaServer
        from app.extensions import db
        from datetime import datetime
        
        try:
            # Get the server to access Overseerr
            server = MediaServer.query.get(server_id)
            if not server or not server.overseerr_enabled or not server.overseerr_url or not server.overseerr_api_key:
                return False, None, "Overseerr not properly configured for this server"
            
            # Find the service user record for this user
            user = cls.query.filter_by(
                userType=UserType.SERVICE,
                server_id=server_id,
                external_user_id=plex_user_id
            ).first()
            
            if not user:
                return False, None, "Service user not found"
            
            # Check if user is already linked
            if user.overseerr_user_id:
                return True, user.overseerr_user_id, "User already linked"
            
            # Try to find the user in Overseerr
            overseerr = OverseerrService(server.overseerr_url, server.overseerr_api_key)
            success, overseerr_user, message = overseerr.get_user_by_plex_username(plex_username)
            
            if not success:
                return False, None, f"Failed to check Overseerr: {message}"
            
            if not overseerr_user:
                return False, None, "User not found in Overseerr"
            
            # User found! Update the link
            overseerr_user_id = overseerr_user.get('id')
            user.overseerr_user_id = overseerr_user_id
            
            db.session.commit()
            return True, overseerr_user_id, f"Successfully linked to Overseerr user: {overseerr_user.get('username', overseerr_user.get('email', 'Unknown'))}"
            
        except Exception as e:
            db.session.rollback()
            return False, None, f"Error linking user: {str(e)}"

# Legacy aliases removed - use unified User model directly

class Setting(db.Model): # ... (Setting model remains the same structure, new keys will be added via UI/code) ...
    __tablename__ = 'settings'; id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(100), unique=True, nullable=False, index=True)
    value = db.Column(db.Text, nullable=True)
    value_type = db.Column(db.Enum(SettingValueType), default=SettingValueType.STRING, nullable=False)
    name = db.Column(db.String(100), nullable=True); description = db.Column(db.Text, nullable=True)
    is_public = db.Column(db.Boolean, default=False); created_at = db.Column(db.DateTime, default=utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    def __repr__(self): return f'<Setting {self.key}>'
    def get_value(self):
        if self.value is None: return None
        if self.value_type == SettingValueType.INTEGER: return int(self.value)
        elif self.value_type == SettingValueType.BOOLEAN: return self.value.lower() in ['true', '1', 'yes', 'on']
        elif self.value_type == SettingValueType.JSON:
            try: return json.loads(self.value)
            except json.JSONDecodeError: return None
        return self.value
    @staticmethod
    def get(key_name, default=None):
        if current_app:
            engine_conn_setting_get = None
            try:
                engine_conn_setting_get = db.engine.connect()
                if db.engine.dialect.has_table(engine_conn_setting_get, Setting.__tablename__):
                    setting_obj = Setting.query.filter_by(key=key_name).first()
                    if setting_obj: return setting_obj.get_value()
            except Exception as e: current_app.logger.debug(f"Setting.get({key_name}): DB query failed: {e}")
            finally:
                if engine_conn_setting_get: engine_conn_setting_get.close()
            if key_name in current_app.config: return current_app.config.get(key_name, default)
        return default
    @staticmethod
    def set(key_name, value, v_type=SettingValueType.STRING, name=None, description=None, is_public=False):
        setting = Setting.query.filter_by(key=key_name).first()
        if not setting: setting = Setting(key=key_name); db.session.add(setting)
        setting.value_type = v_type; setting.name = name or setting.name; setting.description = description or setting.description; setting.is_public = is_public
        if v_type == SettingValueType.JSON and not isinstance(value, str): setting.value = json.dumps(value)
        elif isinstance(value, bool) and v_type == SettingValueType.BOOLEAN: setting.value = 'true' if value else 'false'
        elif isinstance(value, int) and v_type == SettingValueType.INTEGER: setting.value = str(value)
        elif value is None: setting.value = None # Allow unsetting/nulling a value
        else: setting.value = str(value)
        db.session.commit()
        if current_app and key_name.isupper(): current_app.config[key_name] = setting.get_value()
        return setting
    @staticmethod
    def get_bool(key_name, default=False):
        val_str = Setting.get(key_name) # Setting.get already handles defaults and app.config fallback
        if val_str is None: # If Setting.get returned None (meaning not found and no default from .get itself)
            return default
        if isinstance(val_str, bool): # If Setting.get somehow returned a bool already
            return val_str
        return str(val_str).lower() in ['true', '1', 'yes', 'on']
    # --- END OF get_bool ---

# AdminAccount model removed - replaced by Owner and AppUser models


# UserAppAccess class removed - replaced by User model with userType='local'

# ServiceAccount model removed - replaced by UserAppAccess + UserMediaAccess architecture

# (Invite, InviteUsage, HistoryLog models as before - no immediate changes for bot setup yet)
class Invite(db.Model):
    __tablename__ = 'invites'; id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(64), unique=True, nullable=False, index=True, default=lambda: secrets.token_urlsafe(8))
    custom_path = db.Column(db.String(100), unique=True, nullable=True, index=True); expires_at = db.Column(db.DateTime, nullable=True)
    max_uses = db.Column(db.Integer, nullable=True); current_uses = db.Column(db.Integer, default=0, nullable=False) # Added nullable=False
    grant_library_ids = db.Column(MutableList.as_mutable(JSONEncodedDict), default=list)
    allow_downloads = db.Column(db.Boolean, default=False, nullable=False)
    created_by_owner_id = db.Column(db.Integer, db.ForeignKey('users.id')); owner_creator = db.relationship('User', foreign_keys=[created_by_owner_id])
    created_at = db.Column(db.DateTime, default=utcnow); updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)
    is_active = db.Column(db.Boolean, default=True, nullable=False, index=True) # Added nullable=False
    invite_usages = db.relationship('InviteUsage', back_populates='invite', cascade="all, delete-orphan")
    membership_duration_days = db.Column(db.Integer, nullable=True) # Duration in days set at invite creation
    require_discord_auth = db.Column(db.Boolean, nullable=True)
    require_discord_guild_membership = db.Column(db.Boolean, nullable=True)
    grant_purge_whitelist = db.Column(db.Boolean, nullable=True, default=False)
    grant_bot_whitelist = db.Column(db.Boolean, nullable=True, default=False)
    invite_to_plex_home = db.Column(db.Boolean, nullable=True, default=False)
    allow_live_tv = db.Column(db.Boolean, nullable=True, default=False)
    servers = db.relationship('MediaServer', secondary=invite_servers, lazy='subquery',
                              backref=db.backref('invites', lazy=True))
    def __repr__(self): return f'<Invite {self.custom_path or self.token}>'
    @property
    def is_expired(self): 
        if not self.expires_at:
            return False
        # Ensure both datetimes are timezone-aware for comparison
        from datetime import timezone
        now = utcnow()
        expires = self.expires_at
        
        # If expires_at is naive, assume it's UTC
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        
        return now > expires
    @property
    def has_reached_max_uses(self): return self.max_uses is not None and self.current_uses >= self.max_uses
    @property
    def is_usable(self): return self.is_active and not self.is_expired and not self.has_reached_max_uses
    def get_full_url(self, app_base_url):
        if not app_base_url: return "#INVITE_URL_NOT_CONFIGURED"
        path_part = self.custom_path if self.custom_path else self.token
        return f"{app_base_url.rstrip('/')}/invite/{path_part}"

class InviteUsage(db.Model): # ... (as before)
    __tablename__ = 'invite_usages'; id = db.Column(db.Integer, primary_key=True)
    invite_id = db.Column(db.Integer, db.ForeignKey('invites.id'), nullable=False); invite = db.relationship('Invite', back_populates='invite_usages')
    used_at = db.Column(db.DateTime, default=utcnow); ip_address = db.Column(db.String(45), nullable=True)
    plex_user_uuid = db.Column(db.String(255), nullable=True); plex_username = db.Column(db.String(255), nullable=True)
    plex_email = db.Column(db.String(120), nullable=True); plex_thumb = db.Column(db.String(512), nullable=True)
    plex_auth_successful = db.Column(db.Boolean, default=False, nullable=False); discord_user_id = db.Column(db.String(255), nullable=True) # Added nullable=False
    discord_username = db.Column(db.String(255), nullable=True); discord_auth_successful = db.Column(db.Boolean, default=False, nullable=False) # Added nullable=False
    userId = db.Column(db.String(36), db.ForeignKey('users.uuid'), nullable=True, index=True); user = db.relationship('User', foreign_keys=[userId])
    accepted_invite = db.Column(db.Boolean, default=False, nullable=False); status_message = db.Column(db.String(255), nullable=True) # Added nullable=False

class HistoryLog(db.Model): # ... (as before)
    __tablename__ = 'history_logs'; id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, default=utcnow, index=True)
    event_type = db.Column(db.Enum(EventType), nullable=False, index=True); message = db.Column(db.Text, nullable=False)
    details = db.Column(MutableDict.as_mutable(JSONEncodedDict), nullable=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True); owner = db.relationship('User', foreign_keys='HistoryLog.owner_id')
    local_user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True); affected_local_user = db.relationship('User', foreign_keys='HistoryLog.local_user_id')
    invite_id = db.Column(db.Integer, db.ForeignKey('invites.id'), nullable=True); related_invite = db.relationship('Invite')
    def __repr__(self): return f'<HistoryLog {self.timestamp} [{self.event_type.name}]: {self.message[:50]}>'

# StreamHistory model removed - replaced by MediaStreamHistory in models_media_services.py

class UserPreferences(db.Model):
    __tablename__ = 'user_preferences'
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey('users.id'), unique=True, nullable=False)
    
    # This field will store the user's choice: 'local' or 'utc'
    timezone_preference = db.Column(db.String(10), default='local', nullable=False)
    
    # This field will store the browser-detected timezone name (e.g., 'America/New_York')
    local_timezone = db.Column(db.String(100), nullable=True)
    
    # This field will store the user's time format preference: '12' or '24'
    time_format = db.Column(db.String(2), default='12', nullable=False)
    
    def __repr__(self):
        return f'<UserPreferences for Owner {self.owner_id}>'
    
    @staticmethod
    def get_timezone_preference(owner_id):
        prefs = UserPreferences.query.filter_by(owner_id=owner_id).first()
        if prefs:
            return {
                "preference": prefs.timezone_preference,
                "local_timezone": prefs.local_timezone,
                "time_format": prefs.time_format
            }
        return {"preference": "local", "local_timezone": None, "time_format": "12"}
    
    @staticmethod
    def set_timezone_preference(owner_id, preference, local_timezone=None, time_format=None):
        prefs = UserPreferences.query.filter_by(owner_id=owner_id).first()
        if not prefs:
            prefs = UserPreferences(owner_id=owner_id)
            db.session.add(prefs)
        
        prefs.timezone_preference = preference
        if preference == 'local' and local_timezone:
            prefs.local_timezone = local_timezone
        if time_format:
            prefs.time_format = time_format
        
        db.session.commit()
        return prefs
