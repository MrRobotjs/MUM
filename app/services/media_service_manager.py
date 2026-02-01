# File: app/services/media_service_manager.py
from typing import Any, Dict, Iterable, List, Optional, Set, Union
from flask import current_app
from app.models_media_services import MediaServer, MediaLibrary, ServiceType, MediaItem
from app.models import User, UserType, Setting
from app.services.media_service_factory import MediaServiceFactory
from app.extensions import db
from datetime import datetime
from app.services import realtime_session_cache

class MediaServiceManager:
    """Centralized manager for all media services"""
    
    @staticmethod
    def get_all_servers(active_only: bool = True) -> List[MediaServer]:
        """Get all configured media servers"""
        query = MediaServer.query
        if active_only:
            query = query.filter_by(is_active=True)
        return query.all()
    
    @staticmethod
    def get_servers_by_type(service_type: ServiceType, active_only: bool = True) -> List[MediaServer]:
        """Get servers of a specific type"""
        query = MediaServer.query.filter_by(service_type=service_type)
        if active_only:
            query = query.filter_by(is_active=True)
        return query.all()
    
    @staticmethod
    def get_server_by_id(server_id: int) -> Optional[MediaServer]:
        """Get a server by ID"""
        return MediaServer.query.get(server_id)
    
    @staticmethod
    def test_server_connection(server_id: int) -> Dict[str, Any]:
        """Test connection to a specific server"""
        server = MediaServiceManager.get_server_by_id(server_id)
        if not server:
            return {'success': False, 'message': 'Server not found'}
        
        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return {'success': False, 'message': 'Service type not supported'}
        
        try:
            success, message = service.test_connection()
            return {'success': success, 'message': message}
        except Exception as e:
            return {'success': False, 'message': f'Connection test failed: {str(e)}'}
    
    @staticmethod
    def sync_server_libraries(server_id: int) -> Dict[str, Any]:
        """Sync libraries for a specific server"""
        server = MediaServiceManager.get_server_by_id(server_id)
        if not server:
            return {'success': False, 'message': 'Server not found'}
        
        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return {'success': False, 'message': 'Service type not supported'}
        
        try:
            current_app.logger.info(f"Starting library sync for server {server_id} ({server.server_nickname})")
            libraries_data = service.get_libraries()
            current_app.logger.info(f"Retrieved {len(libraries_data)} libraries from {server.server_nickname}")
            
            # Update database
            existing_libs = {lib.external_id: lib for lib in server.libraries}
            current_app.logger.info(f"Found {len(existing_libs)} existing libraries in database")
            updated_count = 0
            added_count = 0
            updated_libraries = []
            added_libraries = []
            
            for lib_data in libraries_data:
                external_id = lib_data['external_id']
                current_app.logger.debug(f"Processing library: {lib_data['name']} (ID: {external_id})")
                
                if external_id in existing_libs:
                    # Update existing library
                    lib = existing_libs[external_id]
                    changes = []
                    
                    if lib.name != lib_data['name']:
                        changes.append(f"Name changed from '{lib.name}' to '{lib_data['name']}'")
                        lib.name = lib_data['name']
                    
                    if lib.library_type != lib_data.get('type'):
                        changes.append(f"Type changed from '{lib.library_type}' to '{lib_data.get('type')}'")
                        lib.library_type = lib_data.get('type')
                    
                    if lib.item_count != lib_data.get('item_count'):
                        old_count = lib.item_count or 0
                        new_count = lib_data.get('item_count') or 0
                        changes.append(f"Item count changed from {old_count} to {new_count}")
                        lib.item_count = lib_data.get('item_count')
                    
                    if changes:
                        lib.updated_at = datetime.utcnow()
                        updated_count += 1
                        updated_libraries.append({
                            'name': lib_data['name'],
                            'server_name': server.server_nickname,
                            'changes': changes
                        })
                        current_app.logger.debug(f"Updated existing library: {lib_data['name']} - Changes: {changes}")
                    else:
                        current_app.logger.debug(f"No changes for library: {lib_data['name']}")
                else:
                    # Add new library
                    import uuid
                    internal_id = str(uuid.uuid4())
                    lib = MediaLibrary(
                        server_id=server_id,
                        external_id=external_id,
                        name=lib_data['name'],
                        library_type=lib_data.get('type'),
                        item_count=lib_data.get('item_count'),
                        internal_id=internal_id  # Explicitly set internal_id
                    )
                    current_app.logger.info(f"KAVITA DEBUG: Creating library '{lib_data['name']}' with external_id '{external_id}' and internal_id '{internal_id}'")
                    db.session.add(lib)
                    added_count += 1
                    added_libraries.append({
                        'name': lib_data['name'],
                        'server_name': server.server_nickname,
                        'type': lib_data.get('type'),
                        'item_count': lib_data.get('item_count')
                    })
                    current_app.logger.debug(f"Added new library: {lib_data['name']}")
            
            # Handle library removals - delete libraries that are no longer in the API response
            api_external_ids = {lib_data['external_id'] for lib_data in libraries_data}
            removed_count = 0
            removed_libraries = []
            
            for external_id, lib in existing_libs.items():
                if external_id not in api_external_ids:
                    current_app.logger.info(f"Removing library '{lib.name}' (ID: {external_id}) - no longer exists on server")
                    deleted_items = MediaItem.query.filter_by(library_id=lib.id).delete(synchronize_session=False)
                    if deleted_items:
                        current_app.logger.info(
                            f"Deleted {deleted_items} media items cached for library '{lib.name}' ({external_id})"
                        )
                    removed_libraries.append({
                        'name': lib.name,
                        'server_name': server.server_nickname,
                        'external_id': external_id
                    })
                    db.session.delete(lib)
                    removed_count += 1
            
            server.last_sync_at = datetime.utcnow()
            db.session.commit()
            current_app.logger.info(f"Library sync completed: {added_count} added, {updated_count} updated, {removed_count} removed")
            
            return {
                'success': True,
                'message': f'Synced {len(libraries_data)} libraries',
                'added': added_count,
                'updated': updated_count,
                'removed': removed_count,
                'added_libraries': added_libraries,
                'updated_libraries': updated_libraries,
                'removed_libraries': removed_libraries
            }
            
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error syncing libraries for server {server_id} ({server.server_nickname}): {e}", exc_info=True)
            return {'success': False, 'message': f'Sync failed: {str(e)}'}
    
    @staticmethod
    def sync_server_users(server_id: int) -> Dict[str, Any]:
        """Sync users for a specific server, tracking detailed changes."""
        server = MediaServiceManager.get_server_by_id(server_id)
        if not server:
            return {'success': False, 'message': 'Server not found'}

        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return {'success': False, 'message': 'Service type not supported'}

        try:
            # Test connection first before attempting to sync users
            connection_test = service.test_connection()
            if not connection_test[0]:  # test_connection returns (success, message)
                return {
                    'success': False, 
                    'message': f'Server {server.server_nickname} is offline or unreachable: {connection_test[1]}'
                }
            
            users_data = service.get_users()
            
            # If we get an empty list, double-check if this is expected or an error
            if not users_data:
                current_app.logger.warning(f"No users returned from {server.server_nickname}. This could indicate the server is offline or has no users.")
                # For safety, don't process removals if we get no users - this could indicate server issues
                return {
                    'success': False,
                    'message': f'No users returned from {server.server_nickname}. Server may be offline or experiencing issues.'
                }
            
            added_count = 0
            updated_count = 0
            removed_count = 0
            updated_details = []
            added_details = []
            removed_details = []

            # For enriching library change details - create lookup for both external_id and internal_id
            server_libraries = {}
            for lib in server.libraries:
                # Map external_id to name (for non-Kavita services)
                server_libraries[lib.external_id] = lib.name
                # Also map internal_id to name (for Kavita services using UUIDs)
                if hasattr(lib, 'internal_id') and lib.internal_id:
                    server_libraries[lib.internal_id] = lib.name
            external_user_ids_from_service = {str(u.get('id')) for u in users_data if u.get('id')}

            manage_downloads_role = server.service_type in {ServiceType.PLEX, ServiceType.JELLYFIN, ServiceType.EMBY}

            for user_data in users_data:
                user = MediaServiceManager._find_or_create_user(user_data, server)
                allow_downloads_from_sync = user_data.get('allow_downloads')
                is_owner_from_sync = None
                if 'is_media_server_owner' in user_data:
                    is_owner_from_sync = bool(user_data.get('is_media_server_owner'))
                elif server.service_type == ServiceType.PLEX and 'is_owner' in user_data:
                    is_owner_from_sync = bool(user_data.get('is_owner'))
                
                # Check if service user already exists for this server user
                access = None
                external_user_id = user_data.get('id')
                if external_user_id:
                    access = User.query.filter_by(
                        userType=UserType.SERVICE,
                        server_id=server_id,
                        external_user_id=external_user_id
                    ).first()
                
                # For Plex, also check by UUID
                if not access and server.service_type == ServiceType.PLEX:
                    uuid = user_data.get('uuid')
                    if uuid:
                        access = User.query.filter_by(
                            userType=UserType.SERVICE,
                            server_id=server_id,
                            external_user_alt_id=uuid
                        ).first()
                
                if not access:
                    # Check if there's already a service user for this linked user on this server
                    # This can happen when a user was created via invite but then we sync again
                    if user:
                        existing_linked_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                            linkedUserId=user.id,
                            server_id=server_id
                        ).first()
                        
                        if existing_linked_access:
                            current_app.logger.info(f"Found existing service user for linked user {user.get_display_name()} on server {server.server_nickname}")
                            access = existing_linked_access
                            # Update the existing record with fresh data
                            access.external_user_id = user_data.get('id')
                            access.external_username = user_data.get('username')
                            access.external_email = user_data.get('email')
                            # Convert external_ids to internal_ids for Kavita users
                            library_ids = user_data.get('library_ids', [])
                            access.allowed_library_ids = MediaServiceManager._convert_library_ids_for_kavita(server, library_ids)
                            raw_data_to_store = user_data.get('raw_data') or {}
                            current_app.logger.info(f"AudioBookshelf sync - Updating user {user_data.get('username')} raw_data: {type(raw_data_to_store)} with {len(str(raw_data_to_store))} chars")
                            access.user_raw_data = raw_data_to_store
                            access.is_active = True
                            access.updated_at = datetime.utcnow()
                            # Update the status via UserRole properties
                            access.is_home_user = user_data.get('is_home_user', False)
                            access.shares_back = user_data.get('shares_back', False)
                            if manage_downloads_role and allow_downloads_from_sync is not None:
                                access.allow_downloads = bool(allow_downloads_from_sync)
                                access.sync_downloads_role(allow_downloads_from_sync)
                            if is_owner_from_sync is not None:
                                owner_settings = dict(access.service_settings or {})
                                owner_settings.pop('is_owner', None)
                                owner_settings['is_media_server_owner'] = is_owner_from_sync
                                access.service_settings = owner_settings
                                access.sync_owner_role(is_owner_from_sync)
                            
                            # Set service-specific fields
                            if server.service_type == ServiceType.PLEX:
                                access.external_user_alt_id = user_data.get('uuid')
                                # Parse and set service_join_date from acceptedAt timestamp
                                accepted_at_str = user_data.get('accepted_at')
                                if accepted_at_str and str(accepted_at_str).isdigit():
                                    try:
                                        from datetime import timezone
                                        join_date_dt = datetime.fromtimestamp(int(accepted_at_str), tz=timezone.utc)
                                        access.service_join_date = join_date_dt.replace(tzinfo=None)
                                    except (ValueError, TypeError) as e:
                                        current_app.logger.warning(f"Failed to parse acceptedAt '{accepted_at_str}' for user {user_data.get('username')}: {e}")
                                
                                # Extract and store Plex avatar URL
                                thumb_url = user_data.get('thumb')
                                if thumb_url:
                                    if thumb_url.startswith('https://plex.tv/') or thumb_url.startswith('http://plex.tv/'):
                                        access.external_avatar_url = thumb_url
                                    else:
                                        access.external_avatar_url = f"/api/v2/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
                                    current_app.logger.info(f"Set Plex avatar URL for user {user_data.get('username')}: {access.external_avatar_url}")
                            elif server.service_type == ServiceType.AUDIOBOOKSHELF:
                                created_at = user_data.get('created_at')
                                if created_at and str(created_at).isdigit():
                                    try:
                                        from datetime import timezone
                                        join_date_dt = datetime.fromtimestamp(int(created_at) / 1000, tz=timezone.utc)
                                        access.service_join_date = join_date_dt.replace(tzinfo=None)
                                    except (ValueError, TypeError) as e:
                                        current_app.logger.warning(
                                            f"Failed to parse createdAt '{created_at}' for user {user_data.get('username')}: {e}"
                                        )
                            
                            elif server.service_type == ServiceType.KAVITA:
                                # Parse and set service_join_date from join_date field
                                if user_data.get('join_date'):
                                    try:
                                        access.service_join_date = user_data.get('join_date')
                                    except Exception as e:
                                        current_app.logger.warning(f"Failed to set join date for Kavita user {user_data.get('username')}: {e}")
                            
                            updated_count += 1
                            current_app.logger.info(f"Updated existing linked service user for {user.get_display_name()}")
                            continue  # Skip the creation logic below
                    
                    # Create new service user record
                    # Prepare fields based on server type
                    external_user_alt_id = None
                    if server.service_type == ServiceType.PLEX:
                        external_user_alt_id = user_data.get('uuid')  # Store Plex UUID in alt_id
                    
                    # Store service-specific raw data in service user
                    user_raw_data = user_data.get('raw_data') or {}
                    current_app.logger.info(f"AudioBookshelf sync - Creating new user {user_data.get('username')} raw_data: {type(user_raw_data)} with {len(str(user_raw_data))} chars")
                    initial_service_settings = {'is_media_server_owner': is_owner_from_sync} if is_owner_from_sync is not None else {}
                    
                    access = User(
                        userType=UserType.SERVICE,  # CRITICAL: Set userType for unified model
                        linkedUserId=user.id if user else None,  # May be None for standalone server users
                        server_id=server_id,
                        external_user_id=user_data.get('id'),  # For Plex: plex_user_id ; 
                        external_user_alt_id=external_user_alt_id,  # For Plex: plex_uuid
                        external_username=user_data.get('username'),
                        external_email=user_data.get('email'),
                        allowed_library_ids=MediaServiceManager._convert_library_ids_for_kavita(server, user_data.get('library_ids', [])),
                        user_raw_data=user_raw_data,  # Store raw data here instead of local user
                        service_settings=initial_service_settings,
                        is_active=True,
                        # Add the missing status fields
                        is_home_user=user_data.get('is_home_user', False),
                        shares_back=user_data.get('shares_back', False),
                        allow_downloads=bool(allow_downloads_from_sync) if manage_downloads_role and allow_downloads_from_sync is not None else False
                    )
                    if manage_downloads_role and allow_downloads_from_sync is not None:
                        access.sync_downloads_role(allow_downloads_from_sync)
                    if is_owner_from_sync is not None:
                        access.sync_owner_role(is_owner_from_sync)
                    
                    # Set service-specific fields for new users
                    if server.service_type == ServiceType.PLEX:
                        # Parse and set service_join_date from acceptedAt timestamp
                        accepted_at_str = user_data.get('accepted_at')
                        if accepted_at_str and str(accepted_at_str).isdigit():
                            try:
                                from datetime import timezone
                                join_date_dt = datetime.fromtimestamp(int(accepted_at_str), tz=timezone.utc)
                                access.service_join_date = join_date_dt.replace(tzinfo=None)
                            except (ValueError, TypeError) as e:
                                current_app.logger.warning(f"Failed to parse acceptedAt '{accepted_at_str}' for user {user_data.get('username')}: {e}")
                        
                        # Extract and store Plex avatar URL
                        thumb_url = user_data.get('thumb')
                        if thumb_url:
                            if thumb_url.startswith('https://plex.tv/') or thumb_url.startswith('http://plex.tv/'):
                                access.external_avatar_url = thumb_url
                            else:
                                access.external_avatar_url = f"/api/v2/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
                            current_app.logger.info(f"Set Plex avatar URL for new user {user_data.get('username')}: {access.external_avatar_url}")
                    elif server.service_type == ServiceType.AUDIOBOOKSHELF:
                        created_at = user_data.get('created_at')
                        if created_at and str(created_at).isdigit():
                            try:
                                from datetime import timezone
                                join_date_dt = datetime.fromtimestamp(int(created_at) / 1000, tz=timezone.utc)
                                access.service_join_date = join_date_dt.replace(tzinfo=None)
                            except (ValueError, TypeError) as e:
                                current_app.logger.warning(
                                    f"Failed to parse createdAt '{created_at}' for new user {user_data.get('username')}: {e}"
                                )
                    
                    elif server.service_type == ServiceType.KAVITA:
                        # Parse and set service_join_date from join_date field
                        if user_data.get('join_date'):
                            try:
                                access.service_join_date = user_data.get('join_date')
                            except Exception as e:
                                current_app.logger.warning(f"Failed to set join date for Kavita user {user_data.get('username')}: {e}")
                    
                    db.session.add(access)
                    added_count += 1
                    
                    # Use external_username for display since there might not be a linked local user
                    display_name = user.get_display_name() if user else user_data.get('username', 'Unknown')
                    added_details.append({
                        'username': display_name,
                        'server_name': server.server_nickname,
                        'service_type': server.service_type.value.capitalize(),
                        'linked_to_mum_account': user is not None
                    })
                else:
                    changes = []
                    if access.external_user_id != user_data.get('id'):
                        changes.append(f"External user ID changed from '{access.external_user_id}' to '{user_data.get('id')}'")
                        access.external_user_id = user_data.get('id')
                    
                    # Update Plex UUID if this is a Plex server
                    if server.service_type == ServiceType.PLEX:
                        plex_uuid = user_data.get('uuid')
                        if access.external_user_alt_id != plex_uuid:
                            changes.append(f"Plex UUID changed from '{access.external_user_alt_id}' to '{plex_uuid}'")
                            access.external_user_alt_id = plex_uuid
                    
                    if access.external_username != user_data.get('username'):
                        changes.append(f"Username changed from '{access.external_username}' to '{user_data.get('username')}'")
                        access.external_username = user_data.get('username')
                        
                        # For services like Kavita where username is the primary identifier,
                        # also update the user's username to keep them in sync
                        if server.service_type.value in ['kavita', 'jellyfin', 'emby', 'audiobookshelf', 'komga', 'romm']:
                            user.localUsername = user_data.get('username')
                    if access.external_email != user_data.get('email'):
                        changes.append(f"Email changed from '{access.external_email}' to '{user_data.get('email')}'")
                        access.external_email = user_data.get('email')
                    
                    # Update raw data for existing users
                    raw_data_to_store = user_data.get('raw_data') or {}
                    current_app.logger.info(f"AudioBookshelf sync - Updating existing standalone user {user_data.get('username')} raw_data: {type(raw_data_to_store)} with {len(str(raw_data_to_store))} chars")
                    access.user_raw_data = raw_data_to_store
                    if is_owner_from_sync is not None:
                        settings = access.service_settings or {}
                        current_owner_flag = bool(settings.get('is_media_server_owner', settings.get('is_owner')))
                        if current_owner_flag != is_owner_from_sync:
                            changes.append(f"Owner status changed from {current_owner_flag} to {is_owner_from_sync}")
                        owner_settings = dict(access.service_settings or {})
                        owner_settings.pop('is_owner', None)
                        owner_settings['is_media_server_owner'] = is_owner_from_sync
                        access.service_settings = owner_settings
                        access.sync_owner_role(is_owner_from_sync)
                    
                    # Update service-specific fields for existing standalone users
                    if server.service_type == ServiceType.PLEX:
                        # Update Plex avatar URL
                        thumb_url = user_data.get('thumb')
                        if thumb_url:
                            new_avatar_url = thumb_url if thumb_url.startswith(('https://plex.tv/', 'http://plex.tv/')) else f"/api/v2/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
                            if access.external_avatar_url != new_avatar_url:
                                changes.append(f"Avatar URL updated")
                                access.external_avatar_url = new_avatar_url
                                current_app.logger.info(f"Updated Plex avatar URL for existing user {user_data.get('username')}: {access.external_avatar_url}")
                        elif access.external_avatar_url:
                            # Avatar was removed
                            changes.append(f"Avatar URL removed")
                            access.external_avatar_url = None
                            current_app.logger.info(f"Removed Plex avatar URL for user {user_data.get('username')}")
                    elif server.service_type == ServiceType.AUDIOBOOKSHELF:
                        created_at = user_data.get('created_at')
                        if created_at and str(created_at).isdigit():
                            try:
                                from datetime import timezone
                                join_date_dt = datetime.fromtimestamp(int(created_at) / 1000, tz=timezone.utc)
                                access.service_join_date = join_date_dt.replace(tzinfo=None)
                            except (ValueError, TypeError) as e:
                                current_app.logger.warning(
                                    f"Failed to parse createdAt '{created_at}' for user {user_data.get('username')}: {e}"
                                )
                    
                    old_library_ids = set(access.allowed_library_ids or [])
                    new_library_ids = set(user_data.get('library_ids', []))
                    current_app.logger.debug(f"KAVITA SYNC: User {user_data.get('username', 'Unknown')} - Old IDs: {old_library_ids}, New IDs: {new_library_ids}")
                    if old_library_ids != new_library_ids:
                        added_ids = new_library_ids - old_library_ids
                        removed_ids = old_library_ids - new_library_ids
                        current_app.logger.debug(f"KAVITA SYNC: Added: {added_ids}, Removed: {removed_ids}")

                        if added_ids:
                            # Use library_names from user_data if available (for services like Kavita)
                            if 'library_names' in user_data:
                                # Create a mapping from library_ids to library_names
                                lib_ids = user_data.get('library_ids', [])
                                lib_names = user_data.get('library_names', [])
                                id_to_name = dict(zip(lib_ids, lib_names)) if len(lib_ids) == len(lib_names) else {}
                                added_names = [id_to_name.get(id, server_libraries.get(id, f"Unknown Library (ID: {id})")) for id in added_ids]
                            else:
                                added_names = [server_libraries.get(id, f"Unknown Library (ID: {id})") for id in added_ids]
                            changes.append(f"Gained access to: {', '.join(added_names)}")
                        
                        if removed_ids:
                            # Use library_names from user_data if available (for services like Kavita)
                            if 'library_names' in user_data:
                                # Create a mapping from library_ids to library_names
                                lib_ids = user_data.get('library_ids', [])
                                lib_names = user_data.get('library_names', [])
                                id_to_name = dict(zip(lib_ids, lib_names)) if len(lib_ids) == len(lib_names) else {}
                                removed_names = [id_to_name.get(id, server_libraries.get(id, f"Unknown Library (ID: {id})")) for id in removed_ids]
                            else:
                                removed_names = [server_libraries.get(id, f"Unknown Library (ID: {id})") for id in removed_ids]
                            changes.append(f"Lost access to: {', '.join(removed_names)}")

                        # Convert external_ids to internal_ids for Kavita users
                        library_ids = user_data.get('library_ids', [])
                        access.allowed_library_ids = MediaServiceManager._convert_library_ids_for_kavita(server, library_ids)
                    
                    # Check for changes in status fields (is_home_user, shares_back)
                    if access.is_home_user != user_data.get('is_home_user', False):
                        old_value = access.is_home_user
                        new_value = user_data.get('is_home_user', False)
                        changes.append(f"Home User status changed from {old_value} to {new_value}")
                        access.is_home_user = new_value

                    if access.shares_back != user_data.get('shares_back', False):
                        old_value = access.shares_back
                        new_value = user_data.get('shares_back', False)
                        changes.append(f"Shares Back status changed from {old_value} to {new_value}")
                        access.shares_back = new_value
                    if manage_downloads_role and allow_downloads_from_sync is not None and access.allow_downloads != bool(allow_downloads_from_sync):
                        old_value = access.allow_downloads
                        new_value = bool(allow_downloads_from_sync)
                        changes.append(f"Downloads permission changed from {old_value} to {new_value}")
                        access.allow_downloads = new_value
                        access.sync_downloads_role(new_value)
                    
                    if changes:
                        updated_count += 1
                        # Use external_username for display since there might not be a linked local user
                        display_name = user.get_display_name() if user else access.external_username or 'Unknown'
                        updated_details.append({
                            'username': display_name, 
                            'changes': changes,
                            'server_name': server.server_nickname,
                            'service_type': server.service_type.value.capitalize(),
                            'linked_to_mum_account': user is not None
                        })
                        access.updated_at = datetime.utcnow()

            # Process removals - only if we successfully got user data and it's not empty
            # This prevents accidental deletion when server is offline or experiencing issues
            if users_data and external_user_ids_from_service:
                access_records_to_check = User.query.filter_by(userType=UserType.SERVICE).filter_by(server_id=server_id).all()
                for access in access_records_to_check:
                    if str(access.external_user_id) not in external_user_ids_from_service:
                        # In unified model, get linked user via linkedUserId
                        user_to_check = None
                        if access.linkedUserId:
                            user_to_check = User.query.filter_by(userType=UserType.LOCAL, id=access.linkedUserId).first()
                        display_name = user_to_check.get_display_name() if user_to_check else access.external_username or 'Unknown'
                        current_app.logger.info(f"Removing user access: {display_name} from server {server.server_nickname}")
                        
                        # Track removal details before deleting
                        removed_details.append({
                            'username': display_name,
                            'server_name': server.server_nickname,
                            'service_type': server.service_type.value.capitalize(),
                            'linked_to_mum_account': user_to_check is not None
                        })
                        
                        db.session.delete(access)
                        removed_count += 1
                        
                        # Only delete the local user if:
                        # 1. There is a linked local user (user_to_check is not None)
                        # 2. They have NO other server access
                        if user_to_check:
                            # Use a fresh query to get accurate count after the deletion above
                            remaining_access_count = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=access.linkedUserId).count()
                            if remaining_access_count == 0:
                                current_app.logger.info(f"User {user_to_check.get_display_name()} has no remaining server access, deleting user completely")
                                db.session.delete(user_to_check)
                            else:
                                current_app.logger.info(f"User {user_to_check.get_display_name()} still has access to {remaining_access_count} other server(s), keeping user")
                        else:
                            current_app.logger.info(f"Standalone server user {display_name} removed (no linked MUM account)")
            else:
                current_app.logger.warning(f"Skipping user removal processing for {server.server_nickname} - no valid user data received")

            db.session.commit()
            
            return {
                'success': True,
                'message': f'Synced {len(users_data)} users',
                'added': added_count,
                'updated': updated_count,
                'removed': removed_count,
                'updated_details': updated_details,
                'added_details': added_details,
                'removed_details': removed_details
            }
            
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error syncing users for server {server_id}: {e}", exc_info=True)
            return {'success': False, 'message': f'Sync failed: {str(e)}'}
    
    @staticmethod
    def _find_or_create_user(user_data: Dict[str, Any], server: MediaServer) -> Optional[User]:
        """Find existing local user that should be linked to this server user.
        
        IMPORTANT: This method should NOT create new local user records.
        Local user records should only be created when users manually create 
        accounts via /settings/user_accounts. This method only finds existing ones.
        """
        
        username = user_data.get('username')
        email = user_data.get('email')
        external_user_id = str(user_data.get('id')) if user_data.get('id') else None

        if user_data.get('is_media_server_owner') or (
            server.service_type == ServiceType.PLEX and user_data.get('is_owner')
        ):
            current_app.logger.info(
                "Skipping auto-linking for media-server owner '%s' to avoid cross-server ambiguity.",
                username or email or "unknown",
            )
            return None
        
        # Try to find existing local user by checking if they already have access to this specific server
        user = None
        
        # First, check if this user already exists for this specific server
        if external_user_id:
            existing_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                server_id=server.id,
                external_user_id=external_user_id
            ).first()
            if existing_access:
                # In unified model, get linked user via linkedUserId
                user = None
                if existing_access.linkedUserId:
                    user = User.query.filter_by(userType=UserType.LOCAL, id=existing_access.linkedUserId).first()
                current_app.logger.debug(f"Found existing user via server access: {user.get_display_name() if user else 'None'}")
        
        # For Plex, also try to match by UUID via service user
        if not user and server.service_type == ServiceType.PLEX:
            uuid = user_data.get('uuid')
            if uuid:
                # Look for existing service user with this Plex UUID
                access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                    server_id=server.id,
                    external_user_alt_id=uuid
                ).first()
                if access:
                    # In unified model, get linked user via linkedUserId
                    user = None
                    if access.linkedUserId:
                        user = User.query.filter_by(userType=UserType.LOCAL, uuid=access.linkedUserId).first()
                    if user:
                        current_app.logger.debug(f"Found existing Plex user via UUID: {user.get_display_name()}")
                    else:
                        current_app.logger.debug(f"Found access record with Plex UUID {uuid} but no linked local user")
                else:
                    current_app.logger.debug(f"No existing user found with Plex UUID: {uuid}")
        
        # If no existing local user found, try to find one by username or email
        # This allows linking server users to existing MUM accounts
        if not user:
            # Try to find by username first
            if username:
                user = User.get_by_local_username(username)
                if user:
                    current_app.logger.info(f"Found existing local user by username: {username}")
            
            # If not found by username, try by email
            if not user and email:
                user = User.query.filter_by(userType=UserType.LOCAL).filter_by(email=email).first()
                if user:
                    current_app.logger.info(f"Found existing local user by email: {email}")
        
        # If still no local user found, this server user will be standalone
        # (not linked to any MUM account)
        if not user:
            current_app.logger.info(f"No existing local user found for server user '{username}' (email: {email}). "
                                  f"This user will exist only as server access without MUM account.")
            return None
        
        # Update existing user with server data if found
        if user:
            current_app.logger.info(f"Updating existing local user '{user.get_display_name()}' with server data")
            
            # Update raw data based on server type
            if server.service_type == ServiceType.PLEX and user_data.get('raw_data'):
                # Store raw data in UserMediaAccess instead of UserAppAccess
                pass  # Will be handled in UserMediaAccess creation
                
            elif server.service_type == ServiceType.JELLYFIN and user_data.get('raw_data'):
                # Store raw data in UserMediaAccess instead of UserAppAccess
                pass  # Will be handled in UserMediaAccess creation
            
            elif server.service_type == ServiceType.KAVITA and user_data.get('raw_data'):
                # Store raw data in UserMediaAccess instead of UserAppAccess
                pass  # Will be handled in UserMediaAccess creation

        return user
    
    @staticmethod
    def get_all_active_sessions(
        service_types: Optional[Iterable[Union[ServiceType, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Get active sessions from all (or selected) servers"""
        type_filter: Optional[Set[ServiceType]] = None
        if service_types is not None:
            type_filter = set()
            for svc_type in service_types:
                if isinstance(svc_type, ServiceType):
                    type_filter.add(svc_type)
                elif isinstance(svc_type, str):
                    try:
                        type_filter.add(ServiceType(svc_type.lower()))
                    except ValueError:
                        current_app.logger.warning(
                            "MediaServiceManager: Ignoring unknown service type '%s' in get_all_active_sessions filter",
                            svc_type,
                        )
                else:
                    current_app.logger.warning(
                        "MediaServiceManager: Unsupported service type filter value %s (%s)",
                        svc_type,
                        type(svc_type),
                    )

        if type_filter:
            current_app.logger.warning(
                "MediaServiceManager.get_all_active_sessions() called for service types: %s - THIS MAKES API CALLS TO MATCHING SERVERS",
                ", ".join(sorted(t.value for t in type_filter)),
            )
        else:
            current_app.logger.warning(
                "MediaServiceManager.get_all_active_sessions() called with no filter - THIS MAKES API CALLS TO ALL SERVERS"
            )

        all_sessions = []
        
        servers = MediaServiceManager.get_all_servers()
        if type_filter:
            servers = [server for server in servers if server.service_type in type_filter]

        current_app.logger.debug(
            "MediaServiceManager: Found %d servers to check for active sessions (filter=%s)",
            len(servers),
            ", ".join(sorted(t.value for t in type_filter)) if type_filter else "none",
        )
        
        for server in servers:
            current_app.logger.warning(f"MediaServiceManager: Making API call to server '{server.server_nickname}' ({server.service_type.value}) at {server.url}")
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                try:
                    # For Jellyfin/Emby we source sessions exclusively from the websocket cache
                    if server.service_type in {ServiceType.JELLYFIN, ServiceType.EMBY}:
                        sessions = realtime_session_cache.get_sessions(server.service_type.value, server.id)
                        current_app.logger.debug(
                            "MediaServiceManager: Using websocket cache for %s (%s) -> %d sessions",
                            server.server_nickname,
                            server.service_type.value,
                            len(sessions),
                        )
                    else:
                        current_app.logger.debug(f"MediaServiceManager: Calling get_active_sessions() for {server.server_nickname}")
                        sessions = service.get_active_sessions()
                        current_app.logger.debug(f"MediaServiceManager: Got {len(sessions)} sessions from {server.server_nickname}")
                    for session in sessions:
                        if isinstance(session, dict):
                            session['server_name'] = server.server_nickname
                            session['server_id'] = server.id
                            session['service_type'] = server.service_type.value
                        else:
                            setattr(session, 'server_name', server.server_nickname)
                            setattr(session, 'server_id', server.id)
                            setattr(session, 'service_type', server.service_type.value)
                    all_sessions.extend(sessions)
                except Exception as e:
                    current_app.logger.error(f"MediaServiceManager: Error getting sessions from {server.server_nickname}: {e}")
            else:
                current_app.logger.warning(f"MediaServiceManager: Could not create service for {server.server_nickname}")
        
        current_app.logger.warning(f"MediaServiceManager: Total sessions found across all servers: {len(all_sessions)}")
        return all_sessions
    
    @staticmethod
    def terminate_session(server_id: int, session_id: str, reason: str = None) -> bool:
        """Terminate a session on a specific server"""
        server = MediaServiceManager.get_server_by_id(server_id)
        if not server:
            return False
        
        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return False
        
        try:
            return service.terminate_session(session_id, reason)
        except Exception as e:
            current_app.logger.error(f"Error terminating session on {server.server_nickname}: {e}")
            return False
    
    @staticmethod
    def create_default_plex_server() -> Optional[MediaServer]:
        """Create a default Plex server from existing settings"""
        plex_url = Setting.get('PLEX_URL')
        plex_token = Setting.get('PLEX_TOKEN')
        
        if not plex_url or not plex_token:
            return None
        
        # Check if Plex server already exists
        existing = MediaServer.query.filter_by(
            service_type=ServiceType.PLEX,
            url=plex_url
        ).first()
        
        if existing:
            return existing
        
        server = MediaServer(
            server_nickname="Plex Media Server",
            service_type=ServiceType.PLEX,
            url=plex_url,
            api_key=plex_token,
            is_active=True
        )
        
        db.session.add(server)
        db.session.commit()
        
        return server
    
    @staticmethod
    def _convert_library_ids_for_kavita(server, library_ids):
        """Convert Kavita external_ids to internal_ids for proper storage"""
        if server.service_type.value != 'kavita':
            return library_ids
        
        from app.models_media_services import MediaLibrary
        all_server_libraries = MediaLibrary.query.filter_by(server_id=server.id).all()
        
        converted_ids = []
        has_all_libraries_permission = False
        
        for lib_id in library_ids:
            # Special handling for Kavita's "all libraries" permission
            if str(lib_id) == '0':
                if not has_all_libraries_permission:  # Only process '0' once
                    has_all_libraries_permission = True
                    # '0' means all libraries, convert to all available internal_ids
                    if all_server_libraries:
                        for lib in all_server_libraries:
                            if hasattr(lib, 'internal_id') and lib.internal_id:
                                if lib.internal_id not in converted_ids:  # Avoid duplicates
                                    converted_ids.append(lib.internal_id)
                    else:
                        current_app.logger.warning(f"Kavita server {server.server_nickname}: No libraries found to grant access to")
                continue  # Skip further processing of '0'
            
            # Handle specific library IDs
            library = MediaLibrary.query.filter_by(
                server_id=server.id,
                external_id=str(lib_id)
            ).first()
            
            if library and hasattr(library, 'internal_id') and library.internal_id:
                if library.internal_id not in converted_ids:  # Avoid duplicates
                    converted_ids.append(library.internal_id)
            else:
                current_app.logger.warning(f"Kavita library conversion: Could not find library with external_id '{lib_id}' on server {server.server_nickname}")
                if str(lib_id) not in converted_ids:  # Avoid duplicates
                    converted_ids.append(str(lib_id))  # Fallback to original
        
        return converted_ids
