"""
Unified User Model Design - Step 1.1 of User Unification Plan

This file contains the new unified User model that will replace:
- Owner (app/models.py:76)
- UserAppAccess (app/models.py:215) 
- UserMediaAccess (app/models_media_services.py:149)

Created: 2025-01-26
Status: DESIGN PHASE - NOT YET IMPLEMENTED
"""

import enum
import uuid
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy.ext.mutable import MutableDict, MutableList
from app.extensions import db, JSONEncodedDict
from app.utils.timezone_utils import utcnow

class UserType(enum.Enum):
    """User type enumeration for the unified User model"""
    OWNER = "owner"      # Single app owner with ultimate permissions (replaces Owner)
    LOCAL = "local"      # Local accounts that can login (replaces UserAppAccess)
    SERVICE = "service"  # Service-specific accounts (replaces UserMediaAccess)

class User(db.Model):
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
    external_user_id = db.Column(db.String(255), nullable=True, index=True)  # Plex user ID, Jellyfin user ID, etc.
    external_user_alt_id = db.Column(db.String(255), nullable=True)  # Plex UUID for SSO, etc.
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
    localUsername = db.Column(db.String(255), nullable=True, index=True)  # Local login username
    password_hash = db.Column(db.String(256), nullable=True)
    
    # Owner-Specific Fields (only for OWNER users)
    preferred_user_list_view = db.Column(db.String(10), default='cards', nullable=False)
    force_password_change = db.Column(db.Boolean, default=False, nullable=False)
    
    # Plex Integration (for OWNER users)
    plex_uuid = db.Column(db.String(255), nullable=True)
    plex_username = db.Column(db.String(255), nullable=True)
    plex_thumb = db.Column(db.String(512), nullable=True)
    
    # Relationships
    server = db.relationship('MediaServer', backref='users')
    invite = db.relationship('Invite', backref='users_created')
    linked_parent = db.relationship('User', remote_side=[uuid], backref='linked_children')
    
    # Table Constraints
    __table_args__ = (
        # Unique constraints based on user type
        db.UniqueConstraint('localUsername', name='uq_users_local_username'),
        db.UniqueConstraint('external_user_id', 'server_id', name='uq_users_external_server'),
        db.UniqueConstraint('linkedUserId', 'server_id', name='uq_users_linked_server'),
        db.UniqueConstraint('discord_user_id', name='uq_users_discord_user_id'),
        db.UniqueConstraint('plex_uuid', name='uq_users_plex_uuid'),
        
        # Indexes for performance
        db.Index('idx_users_type_server', 'userType', 'server_id'),
        db.Index('idx_users_linked_active', 'linkedUserId', 'is_active'),
        db.Index('idx_users_external_user', 'external_user_id', 'server_id'),
        db.Index('idx_users_local_username', 'localUsername'),
        db.Index('idx_users_activity', 'last_activity_at'),
        db.Index('idx_users_expiration', 'access_expires_at'),
        db.Index('idx_users_service_join', 'service_join_date'),
    )
    
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
            return self.discord_email  # Owners use discord email typically
        elif self.userType == UserType.LOCAL:
            return self.discord_email  # Local users might have discord email
        elif self.userType == UserType.SERVICE:
            return self.external_email or self.discord_email
        return None
    
    # Permission Methods
    def has_permission(self, permission_name):
        """Check if user has a specific permission"""
        if self.userType == UserType.OWNER:
            return True  # Owners have all permissions
        elif self.userType == UserType.LOCAL:
            # Check role-based permissions for local users
            # TODO: Implement role checking logic
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
    
    # Class Methods for User Management
    @classmethod
    def create_owner(cls, username, password, email=None):
        """Create the single owner user"""
        if cls.query.filter_by(userType=UserType.OWNER).first():
            raise ValueError("Owner user already exists")
        
        owner = cls(
            userType=UserType.OWNER,
            localUsername=username,
            discord_email=email  # Store email in discord_email field
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

# Data Migration Mapping Documentation
"""
MIGRATION MAPPING:

From Owner -> User(userType=OWNER):
- id -> id
- username -> localUsername  
- email -> discord_email
- password_hash -> password_hash
- plex_uuid -> plex_uuid
- plex_username -> plex_username
- plex_thumb -> plex_thumb
- discord_* -> discord_*
- created_at -> created_at
- last_login_at -> last_login_at
- preferred_user_list_view -> preferred_user_list_view
- force_password_change -> force_password_change

From UserAppAccess -> User(userType=LOCAL):
- id -> id (keep for FK references during migration)
- uuid -> uuid
- username -> localUsername
- email -> discord_email
- password_hash -> password_hash
- created_at -> created_at
- updated_at -> updated_at
- last_login_at -> last_login_at
- is_active -> is_active
- notes -> notes
- used_invite_id -> used_invite_id
- access_expires_at -> access_expires_at
- discord_* -> discord_*

From UserMediaAccess -> User(userType=SERVICE):
- id -> id (keep for FK references during migration)
- uuid -> uuid
- linkedUserId -> linkedUserId (via UUID lookup)
- server_id -> server_id
- external_user_id -> external_user_id
- external_user_alt_id -> external_user_alt_id
- external_username -> external_username
- external_email -> external_email
- allowed_library_ids -> allowed_library_ids
- allow_downloads -> allow_downloads
- allow_4k_transcode -> allow_4k_transcode
- service_settings -> service_settings
- is_active -> is_active
- last_activity_at -> last_activity_at
- created_at -> created_at
- updated_at -> updated_at
- notes -> notes
- external_avatar_url -> external_avatar_url
- used_invite_id -> used_invite_id
- service_join_date -> service_join_date
- is_discord_bot_whitelisted -> is_discord_bot_whitelisted
- is_purge_whitelisted -> is_purge_whitelisted
- is_home_user -> is_home_user
- shares_back -> shares_back
- discord_user_id -> discord_user_id
- discord_username -> discord_username
- access_expires_at -> access_expires_at
- user_raw_data -> user_raw_data
- stream_raw_data -> stream_raw_data
- overseerr_user_id -> overseerr_user_id
"""
