"""DEPRECATED: Unified invite service (unused by API v2 + SPA)."""
from typing import List, Dict, Any, Optional
from flask import current_app
from datetime import datetime, timedelta
from app.models import Invite, User, UserType, Setting
from app.models_media_services import MediaServer
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.extensions import db
from app.utils.helpers import log_event
from app.models import User, UserType, EventType

class UnifiedInviteService:
    """Service for managing invites across all media services"""
    
    @staticmethod
    def create_multi_service_invite(
        admin_id: int,
        server_configs: List[Dict[str, Any]],
        expires_at: datetime = None,
        max_uses: int = None,
        custom_path: str = None,
        membership_duration_days: int = None,
        force_discord_auth: bool = None,
        force_guild_membership: bool = None,
        grant_purge_whitelist: bool = False,
        grant_bot_whitelist: bool = False
    ) -> Invite:
        """
        Create an invite that can grant access to multiple media servers
        
        server_configs format:
        [
            {
                'server_id': 1,
                'library_ids': ['1', '2'],
                'allow_downloads': True
            },
            ...
        ]
        """
        
        # Create the base invite
        invite = Invite(
            expires_at=expires_at,
            max_uses=max_uses,
            custom_path=custom_path,
            membership_duration_days=membership_duration_days,
            force_discord_auth=force_discord_auth,
            force_guild_membership=force_guild_membership,
            grant_purge_whitelist=grant_purge_whitelist,
            grant_bot_whitelist=grant_bot_whitelist,
            created_by_owner_id=admin_id
        )
        
        # Store server configurations in the invite's grant_library_ids as JSON
        # We'll extend this field to store multi-server config
        invite.grant_library_ids = server_configs
        
        db.session.add(invite)
        db.session.commit()
        
        log_event(
            EventType.INVITE_CREATED,
            f"Multi-service invite created for {len(server_configs)} servers",
            admin_id=admin_id,
            invite_id=invite.id
        )
        
        return invite
    
    @staticmethod
    def accept_multi_service_invite(
        invite: Invite,
        user_data: Dict[str, Any],
        ip_address: str = None
    ) -> Dict[str, Any]:
        """
        Accept an invite and grant access to all configured servers
        
        user_data format:
        {
            'username': 'user123',
            'email': 'user@example.com',
            'plex_uuid': 'abc123',  # if from Plex OAuth
            'discord_user_id': '456789',  # if from Discord OAuth
            ...
        }
        """
        
        if not invite.is_usable:
            return {
                'success': False,
                'message': 'Invite is no longer valid'
            }
        
        try:
            # Find or create user
            user = UnifiedInviteService._find_or_create_user_from_invite(user_data, invite)
            
            # Process each server configuration
            server_configs = invite.grant_library_ids or []
            successful_servers = []
            failed_servers = []
            
            for config in server_configs:
                server_id = config.get('server_id')
                library_ids = config.get('library_ids', [])
                allow_downloads = config.get('allow_downloads', False)
                
                server = MediaServiceManager.get_server_by_id(server_id)
                if not server:
                    failed_servers.append(f"Server ID {server_id} not found")
                    continue
                
                try:
                    # Create user on the service if needed
                    service = MediaServiceFactory.create_service_from_db(server)
                    if service and service.supports_feature('user_management'):
                        # Try to create user on the service
                        service_result = service.create_user(
                            username=user_data.get('username'),
                            email=user_data.get('email'),
                            library_ids=library_ids,
                            allow_downloads=allow_downloads
                        )
                        external_user_id = service_result.get('user_id')
                    else:
                        external_user_id = None
                    
                    # Create or update service user
                    access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                        service_account_id=user.id,
                        server_id=server_id
                    ).first()
                    
                    if not access:
                        # Prepare external_user_alt_id for Plex servers
                        external_user_alt_id = None
                        if server.service_type == ServiceType.PLEX and user_data.get('plex_uuid'):
                            external_user_alt_id = user_data.get('plex_uuid')
                        
                        access = User(
                            service_account_id=user.id,
                            server_id=server_id,
                            external_user_id=external_user_id,
                            external_user_alt_id=external_user_alt_id,
                            external_username=user_data.get('username'),
                            external_email=user_data.get('email'),
                            allowed_library_ids=library_ids,
                            allow_downloads=allow_downloads,
                            is_active=True
                        )
                        
                        # Set expiration if specified
                        if invite.membership_duration_days:
                            access.access_expires_at = datetime.utcnow() + timedelta(days=invite.membership_duration_days)
                        
                        db.session.add(access)
                    else:
                        # Update existing access
                        access.allowed_library_ids = library_ids
                        access.allow_downloads = allow_downloads
                        access.is_active = True
                        access.updated_at = datetime.utcnow()
                    
                    successful_servers.append(server.server_nickname)
                    
                except Exception as e:
                    current_app.logger.error(f"Error granting access to {server.server_nickname}: {e}")
                    failed_servers.append(f"{server.server_nickname}: {str(e)}")
            
            # Update invite usage
            invite.current_uses += 1
            
            # Set user expiration if specified
            if invite.membership_duration_days and not user.access_expires_at:
                user.access_expires_at = datetime.utcnow() + timedelta(days=invite.membership_duration_days)
            
            # Apply whitelist settings
            if invite.grant_purge_whitelist:
                user.is_purge_whitelisted = True
            if invite.grant_bot_whitelist:
                user.is_discord_bot_whitelisted = True
            
            user.used_invite_id = invite.id
            
            db.session.commit()
            
            # Log the event
            log_event(
                EventType.INVITE_USED_SUCCESS_PLEX,
                f"Multi-service invite accepted by {user.get_display_name()}. "
                f"Access granted to {len(successful_servers)} servers.",
                user_id=user.id,
                invite_id=invite.id
            )
            
            return {
                'success': True,
                'user': user,
                'successful_servers': successful_servers,
                'failed_servers': failed_servers,
                'message': f"Access granted to {len(successful_servers)} servers"
            }
            
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error accepting multi-service invite: {e}")
            return {
                'success': False,
                'message': f"Error processing invite: {str(e)}"
            }
    
    @staticmethod
    def _find_or_create_user_from_invite(user_data: Dict[str, Any], invite: Invite) -> ServiceAccount:
        """Find existing user or create new one from invite data"""
        username = user_data.get('username')
        email = user_data.get('email')
        plex_uuid = user_data.get('plex_uuid')
        discord_user_id = user_data.get('discord_user_id')
        
        # Try to find existing user
        user = None
        
        # Try by Plex UUID first via service user
        if plex_uuid:
            from app.models_media_services import ServiceType, MediaServer
            plex_server = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
            if plex_server:
                access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                    server_id=plex_server.id,
                    external_user_alt_id=plex_uuid
                ).first()
                if access:
                    user = access.service_account
                else:
                    user = None
            else:
                user = None
        
        # Try by Discord user ID
        if not user and discord_user_id:
            user = User.query.filter_by(userType=UserType.LOCAL).filter_by(discord_user_id=discord_user_id).first()
        
        # Try by primary username
        if not user and username:
            user = User.get_by_local_username(username)
        
        # Try by primary email
        if not user and email:
            user = User.query.filter_by(userType=UserType.LOCAL).filter_by(email=email).first()
        
        if not user:
            # Create new user
            user = User(
                username=username or email or f"user_{datetime.utcnow().timestamp()}",
                email=email,
                avatar_url=user_data.get('avatar_url')
            )
            
            # Set service-specific fields
            if plex_uuid:
                # Plex UUID is now stored in User.external_user_alt_id
                user.localUsername = username
                user.plex_email = email
                user.plex_thumb_url = user_data.get('plex_thumb_url')
            
            if discord_user_id:
                user.discord_user_id = discord_user_id
                user.discord_username = user_data.get('discord_username')
                user.discord_email = user_data.get('discord_email')
                user.discord_avatar_hash = user_data.get('discord_avatar_hash')
            
            db.session.add(user)
            db.session.flush()  # Get the ID
        
        return user
    
    @staticmethod
    def get_invite_server_configs(invite: Invite) -> List[Dict[str, Any]]:
        """Get server configurations for an invite with server details"""
        configs = invite.grant_library_ids or []
        detailed_configs = []
        
        for config in configs:
            server_id = config.get('server_id')
            server = MediaServiceManager.get_server_by_id(server_id)
            
            if server:
                # Get library names
                library_names = []
                library_ids = config.get('library_ids', [])
                for lib in server.libraries:
                    if lib.external_id in library_ids:
                        library_names.append(lib.name)
                
                detailed_configs.append({
                    'server': server,
                    'library_ids': library_ids,
                    'library_names': library_names,
                    'allow_downloads': config.get('allow_downloads', False)
                })
        
        return detailed_configs
    
    @staticmethod
    def update_invite_server_configs(invite_id: int, server_configs: List[Dict[str, Any]]) -> bool:
        """Update server configurations for an existing invite"""
        invite = Invite.query.get(invite_id)
        if not invite:
            return False
        
        try:
            invite.grant_library_ids = server_configs
            invite.updated_at = datetime.utcnow()
            db.session.commit()
            return True
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error updating invite server configs: {e}")
            return False
