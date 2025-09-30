# File: app/services/unified_user_service.py
from typing import List, Dict, Any, Optional
from flask import current_app
from sqlalchemy.exc import IntegrityError
from datetime import datetime
from app.models_media_services import MediaServer, ServiceType
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.extensions import db
from app.utils.helpers import log_event
from app.models import User, UserType, EventType

class UnifiedUserService:
    """Service for managing users across all media services"""
    
    @staticmethod
    def sync_all_users() -> Dict[str, Any]:
        """Sync users from all active media servers"""
        servers = MediaServiceManager.get_all_servers()
        total_added = 0
        total_updated = 0
        total_removed = 0
        total_errors = 0
        error_messages = []
        all_updated_details = []
        all_added_details = []
        all_removed_details = []
        successful_servers = []
        failed_servers = []
        libraries_synced = []

        # First, check if any servers need library sync and sync them automatically
        for server in servers:
            try:
                # Check if server has libraries synced
                library_count = len(server.libraries)
                if library_count == 0:
                    current_app.logger.info(f"No libraries found for {server.server_nickname}, syncing libraries first...")
                    # Sync libraries for this server before syncing users
                    library_sync_result = MediaServiceManager.sync_server_libraries(server.id)
                    if library_sync_result.get('success'):
                        libraries_synced.append(server.server_nickname)
                        current_app.logger.info(f"Successfully synced libraries for {server.server_nickname}: {library_sync_result.get('added', 0)} libraries added")
                    else:
                        current_app.logger.warning(f"Failed to sync libraries for {server.server_nickname}: {library_sync_result.get('message', 'Unknown error')}")
            except Exception as e:
                current_app.logger.error(f"Error checking/syncing libraries for {server.server_nickname}: {e}")

        for server in servers:
            try:
                current_app.logger.info(f"Syncing users from server: {server.server_nickname} ({server.service_type.value})")
                result = MediaServiceManager.sync_server_users(server.id)
                if result['success']:
                    total_added += result.get('added', 0)
                    total_updated += result.get('updated', 0)
                    total_removed += result.get('removed', 0)
                    if result.get('updated_details'):
                        all_updated_details.extend(result['updated_details'])
                    if result.get('added_details'):
                        all_added_details.extend(result['added_details'])
                    if result.get('removed_details'):
                        all_removed_details.extend(result['removed_details'])
                    
                    # Track successful server sync
                    successful_servers.append({
                        'name': server.server_nickname,
                        'service_type': server.service_type.value.capitalize(),
                        'added': result.get('added', 0),
                        'updated': result.get('updated', 0),
                        'removed': result.get('removed', 0),
                        'added_details': result.get('added_details', []),
                        'updated_details': result.get('updated_details', []),
                        'removed_details': result.get('removed_details', [])
                    })
                    current_app.logger.info(f"Successfully synced {server.server_nickname}: +{result.get('added', 0)} users, ~{result.get('updated', 0)} updated, -{result.get('removed', 0)} removed")
                else:
                    total_errors += 1
                    # Use service type name instead of server name to avoid redundancy
                    service_name = server.service_type.value.capitalize()
                    error_message = f"{service_name}: {result['message']}"
                    error_messages.append(error_message)
                    
                    # Track failed server sync
                    failed_servers.append({
                        'name': server.server_nickname,
                        'service_type': service_name,
                        'error': result['message']
                    })
                    current_app.logger.warning(f"Failed to sync users from {server.server_nickname}: {result['message']}")
                    
                    # If server is offline, this is expected and shouldn't be treated as a critical error
                    if 'offline' in result['message'].lower() or 'unreachable' in result['message'].lower():
                        current_app.logger.info(f"Server {server.server_nickname} appears to be offline - this is normal and users will be preserved")
            except Exception as e:
                total_errors += 1
                # Use service type name instead of server name to avoid redundancy
                service_name = server.service_type.value.capitalize()
                error_message = f"{service_name}: {str(e)}"
                error_messages.append(error_message)
                
                # Track failed server sync
                failed_servers.append({
                    'name': server.server_nickname,
                    'service_type': service_name,
                    'error': str(e)
                })
                current_app.logger.error(f"Error syncing users from {server.server_nickname}: {e}", exc_info=True)

        # Group linked accounts for better display
        grouped_results = UnifiedUserService._group_linked_accounts(
            all_added_details, all_updated_details, all_removed_details
        )

        # Create a success message that includes library sync information
        success_message = f"User sync completed successfully"
        if libraries_synced:
            success_message += f". Libraries automatically synced for: {', '.join(libraries_synced)}"

        return {
            'success': total_errors == 0,
            'added': total_added,
            'updated': total_updated,
            'removed': total_removed,
            'errors': total_errors,
            'error_messages': error_messages,
            'servers_synced': len(servers),
            'libraries_synced': libraries_synced,
            'libraries_synced_count': len(libraries_synced),
            'message': success_message,
            'successful_servers': successful_servers,
            'failed_servers': failed_servers,
            'updated_details': all_updated_details,
            'added_details': all_added_details,
            'removed_details': all_removed_details,
            'grouped_updated_details': grouped_results['updated'],
            'grouped_added_details': grouped_results['added'],
            'grouped_removed_details': grouped_results['removed']
        }
    
    @staticmethod
    def _group_linked_accounts(added_details, updated_details, removed_details):
        """Group service account changes by local user for better display"""
        # Local users now unified into User model
        
        grouped = {
            'added': [],
            'updated': [],
            'removed': []
        }
        
        # Helper function to group details by local user
        def group_details_by_local_user(details_list, action_type):
            local_user_groups = {}
            standalone_accounts = []
            
            for detail in details_list:
                username = detail.get('username', 'Unknown')
                server_name = detail.get('server_name', 'Unknown')
                service_type = detail.get('service_type', 'Unknown')
                changes = detail.get('changes', [])
                
                # Find the local user record by username
                # In the new architecture, the username in sync details comes from user.get_display_name()
                # which is the User.localUsername
                local_user = None
                if action_type != 'removed':  # For removed users, they might already be deleted
                    # Try to find local user by username directly
                    local_user = User.get_by_local_username(username)
                    
                    # If not found by direct username match, try finding by external_username in service users
                    if not local_user:
                        # Get the server to help with the search
                        from app.models_media_services import MediaServer
                        server = MediaServer.query.filter_by(server_nickname=server_name).first()
                        if server:
                            # Look for service user records on this server with this external_username
                            user_access = User.query.filter_by(
                            userType=UserType.SERVICE,
                                server_id=server.id,
                                external_username=username
                            ).first()
                            # In unified model, get linked local user via linkedUserId
                            if user_access and user_access.linkedUserId:
                                local_user = User.query.filter_by(userType=UserType.LOCAL, id=user_access.linkedUserId).first()
                            else:
                                local_user = None
                
                if local_user:
                    # Group by the local user
                    local_username = local_user.localUsername
                    local_user_id = local_user.id
                    
                    if local_user_id not in local_user_groups:
                        local_user_groups[local_user_id] = {
                            'app_username': local_username,
                            'app_user_id': local_user_id,
                            'service_accounts': [],
                            'total_services': 0
                        }
                    
                    local_user_groups[local_user_id]['service_accounts'].append({
                        'username': username,
                        'server_name': server_name,
                        'service_type': service_type,
                        'changes': changes
                    })
                    local_user_groups[local_user_id]['total_services'] = len(local_user_groups[local_user_id]['service_accounts'])
                else:
                    # No local user found, treat as standalone
                    standalone_accounts.append(detail)
            
            # Convert grouped accounts to list format
            result = []
            
            # Add grouped accounts (linked accounts)
            for local_user_id, group_data in local_user_groups.items():
                result.append({
                    'type': 'linked_group',
                    'app_username': group_data['app_username'],
                    'app_user_id': group_data['app_user_id'],
                    'service_accounts': group_data['service_accounts'],
                    'total_services': group_data['total_services']
                })
            
            # Add standalone accounts
            for detail in standalone_accounts:
                result.append({
                    'type': 'standalone',
                    'username': detail.get('username'),
                    'server_name': detail.get('server_name'),
                    'service_type': detail.get('service_type'),
                    'changes': detail.get('changes', [])
                })
            
            return result
        
        # Group each type of change
        grouped['added'] = group_details_by_local_user(added_details, 'added')
        grouped['updated'] = group_details_by_local_user(updated_details, 'updated')
        grouped['removed'] = group_details_by_local_user(removed_details, 'removed')
        
        return grouped
    
    @staticmethod
    def get_user_with_access_info(user_id: int) -> Optional[Dict[str, Any]]:
        """Get user with their access information across all servers"""
        user = User.query.filter_by(userType=UserType.LOCAL).get(user_id)
        if not user:
            return None
        
        # Get access information for all servers
        access_info = []
        for access in user.media_accesses:
            server = access.server
            service = MediaServiceFactory.create_service_from_db(server)
            
            # Get library names
            library_names = []
            if access.allowed_library_ids:
                for lib in server.libraries:
                    if lib.external_id in access.allowed_library_ids:
                        library_names.append(lib.name)
            
            access_info.append({
                'server_id': server.id,
                'server_name': server.server_nickname,
                'service_type': server.service_type.value,
                'external_user_id': access.external_user_id,
                'external_username': access.external_username,
                'allowed_library_ids': access.allowed_library_ids,
                'library_names': library_names,
                'allow_downloads': access.allow_downloads,
                'is_active': access.is_active,
                'last_activity': access.last_activity_at,
                'supports_downloads': service.supports_feature('downloads') if service else False,
                'supports_transcoding': service.supports_feature('transcoding') if service else False
            })
        
        return {
            'user': user,
            'access_info': access_info,
            'total_servers': len(access_info),
            'active_servers': len([a for a in access_info if a['is_active']])
        }
    
    @staticmethod
    def update_user_access_on_server(user_id: int, server_id: int, 
                                   library_ids: List[str] = None, 
                                   allow_downloads: bool = None,
                                   admin_id: int = None) -> bool:
        """Update user's access on a specific server"""
        user = User.query.filter_by(userType=UserType.LOCAL).get(user_id)
        server = MediaServiceManager.get_server_by_id(server_id)
        
        if not user or not server:
            return False
        
        # Get or create service user
        access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
            linkedUserId=user_id,
            server_id=server_id
        ).first()
        
        if not access:
            current_app.logger.warning(f"No access record found for user {user_id} on server {server_id}")
            return False
        
        # Update local database first
        changes_made = False
        
        if library_ids is not None:
            access.allowed_library_ids = library_ids
            changes_made = True
        
        if allow_downloads is not None:
            access.allow_downloads = allow_downloads
            changes_made = True
        
        if changes_made:
            access.updated_at = datetime.utcnow()
        
        # Update on the actual service
        service = MediaServiceFactory.create_service_from_db(server)
        if service and access.external_user_id:
            try:
                service_success = service.update_user_access(
                    access.external_user_id,
                    library_ids=library_ids,
                    allow_downloads=allow_downloads
                )
                
                if not service_success:
                    current_app.logger.warning(f"Service update failed for user {user_id} on {server.server_nickname}")
                    # Don't return False here - local update might still be valuable
                
            except Exception as e:
                current_app.logger.error(f"Error updating user access on {server.server_nickname}: {e}")
                # Continue with local update even if service update fails
        
        if changes_made:
            try:
                db.session.commit()
                log_event(
                    EventType.MUM_USER_LIBRARIES_EDITED,
                    f"Updated access for '{user.get_display_name()}' on {server.server_nickname}",
                    user_id=user_id,
                    admin_id=admin_id
                )
                return True
            except Exception as e:
                db.session.rollback()
                current_app.logger.error(f"Error saving user access changes: {e}")
                return False
        
        return True
    
    @staticmethod
    def remove_user_from_server(user_id: int, server_id: int, admin_id: int = None) -> bool:
        """Remove user's access from a specific server"""
        user = User.query.filter_by(userType=UserType.LOCAL).get(user_id)
        server = MediaServiceManager.get_server_by_id(server_id)
        
        if not user or not server:
            return False
        
        # Get access record
        access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
            linkedUserId=user_id,
            server_id=server_id
        ).first()
        
        if not access:
            return True  # Already removed
        
        # Remove from service first
        service = MediaServiceFactory.create_service_from_db(server)
        if service and access.external_user_id:
            try:
                service.delete_user(access.external_user_id)
            except Exception as e:
                current_app.logger.error(f"Error removing user from {server.server_nickname}: {e}")
                # Continue with local removal even if service removal fails
        
        # Remove from local database
        try:
            db.session.delete(access)
            db.session.commit()
            
            log_event(
                EventType.PLEX_USER_REMOVED,
                f"Removed '{user.get_display_name()}' from {server.server_nickname}",
                user_id=user_id,
                admin_id=admin_id
            )
            
            return True
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error removing user access from database: {e}")
            return False
    
    @staticmethod
    def delete_user_completely(user_id: int, admin_id: int = None) -> bool:
        """Delete user from all services and MUM database"""
        user = User.query.filter_by(userType=UserType.LOCAL, id=user_id).first()
        if not user:
            return False
        
        username = user.get_display_name()
        
        # Remove from all services
        for access in user.media_accesses:
            try:
                UnifiedUserService.remove_user_from_server(user_id, access.server_id, admin_id)
            except Exception as e:
                current_app.logger.error(f"Error removing user from {access.server.server_nickname}: {e}")
        
        # Delete user from MUM database
        try:
            db.session.delete(user)
            db.session.commit()
            
            log_event(
                EventType.MUM_USER_DELETED_FROM_MUM,
                f"Deleted user '{username}' completely from MUM",
                admin_id=admin_id
            )
            
            return True
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error deleting user from database: {e}")
            return False
    
    @staticmethod
    def get_users_with_pagination(page: int = 1, per_page: int = 12, 
                                search: str = None) -> Dict[str, Any]:
        """Get users with pagination and search"""
        query = User.query.filter_by(userType=UserType.LOCAL)
        
        if search:
            search_term = f"%{search}%"
            query = query.filter(
                db.or_(
                    User.localUsername.ilike(search_term),
                    User.discord_email.ilike(search_term)
                )
            )
        
        pagination = query.paginate(
            page=page,
            per_page=per_page,
            error_out=False
        )
        
        # Add access info for each user
        users_with_access = []
        for user in pagination.items:
            linked_users = user.get_linked_users() if user.userType == UserType.LOCAL else []
            access_count = len([access for access in linked_users if access.is_active])
            users_with_access.append({
                'user': user,
                'active_servers': access_count,
                'last_activity': user.last_login_at
            })
        
        return {
            'users': users_with_access,
            'pagination': pagination,
            'total': pagination.total,
            'pages': pagination.pages,
            'current_page': page,
            'per_page': per_page,
            'has_prev': pagination.has_prev,
            'has_next': pagination.has_next
        }
