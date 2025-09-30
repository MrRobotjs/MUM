# File: app/services/user_service.py
from flask import current_app
from sqlalchemy.exc import IntegrityError
from datetime import datetime, timezone, timedelta
from sqlalchemy import func, case, or_
from app.models import User, UserType, EventType
from app.models_media_services import ServiceType, MediaServer, MediaStreamHistory
from app.extensions import db
from app.utils.helpers import log_event, format_duration
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory

# parse_user_id function completely removed - now using UUID-based identification only

def sync_users_from_plex():
    current_app.logger.info("User_Service.py - sync_users_from_plex(): Starting Plex user synchronization.")
    
    plex_servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX)
    if not plex_servers:
        current_app.logger.error("User_Service.py - sync_users_from_plex(): Plex server not configured.")
        return {'added': [], 'updated': [], 'removed': [], 'errors': 1, 'error_messages': ["Plex server not configured."]}
    
    server = plex_servers[0]
    plex_service = MediaServiceFactory.create_service_from_db(server)
    if not plex_service:
        current_app.logger.error("User_Service.py - sync_users_from_plex(): Plex service not found.")
        return {'added': [], 'updated': [], 'removed': [], 'errors': 1, 'error_messages': ["Plex service not found."]}

    raw_plex_users_with_access = plex_service.get_users()

    if raw_plex_users_with_access is None:
        current_app.logger.error("User_Service.py - sync_users_from_plex(): Plex user sync failed: Could not retrieve users from Plex service (returned None).")
        # Return a structure indicating failure for the route to handle
        return {'added': [], 'updated': [], 'removed': [], 'errors': 1, 'error_messages': ["Failed to retrieve users from Plex service."]}

    # Get all LOCAL users and their linked service users
    mum_users_all = User.query.filter_by(userType=UserType.LOCAL).all()
    
    # Get Plex user mappings from unified User model
    plex_server = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
    if plex_server:
        plex_accesses = User.query.filter_by(userType=UserType.SERVICE, server_id=plex_server.id).all()
        mum_users_map_by_plex_id = {access.external_user_id: access for access in plex_accesses if access.external_user_id}
        mum_users_map_by_plex_uuid = {access.external_user_alt_id: access for access in plex_accesses if access.external_user_alt_id}
    else:
        mum_users_map_by_plex_id = {}
        mum_users_map_by_plex_uuid = {}
    
    # --- Initialize lists to store details of changes ---
    added_users_details = []
    updated_users_details = [] # List of dicts: {'username': str, 'changes': [str_description_of_change]}
    removed_users_details = [] # List of dicts: {'username': str, 'plex_id': int/str}
    error_count = 0
    error_messages = []
    # --- End init lists ---

    current_plex_user_ids_on_server = set()
    for plex_user_data_item in raw_plex_users_with_access:
        if plex_user_data_item.get('id') is not None:
            current_plex_user_ids_on_server.add(plex_user_data_item['id'])

    for plex_user_data in raw_plex_users_with_access:
        plex_id = plex_user_data.get('id')
        plex_uuid_from_sync = plex_user_data.get('uuid')
        plex_username_from_sync = plex_user_data.get('username')

        if plex_id is None and plex_uuid_from_sync is None:
            msg = f"Plex user data missing 'id' and 'uuid' for potential user: {plex_username_from_sync or 'Unknown'}. Skipping."
            current_app.logger.warning(msg)
            error_count += 1; error_messages.append(msg)
            continue

        mum_user = None
        if plex_id is not None: mum_user = mum_users_map_by_plex_id.get(str(plex_id))  # Convert to string for consistency
        if not mum_user and plex_uuid_from_sync: mum_user = mum_users_map_by_plex_uuid.get(plex_uuid_from_sync)
        
        new_library_ids_from_plex_list = list(plex_user_data.get('allowed_library_ids_on_server', []))
        plex_email_from_sync = plex_user_data.get('email')
        plex_thumb_from_sync = plex_user_data.get('thumb')
        is_home_user_from_sync = plex_user_data.get('is_home_user', False)
        shares_back_from_sync = plex_user_data.get('shares_back', False)
        is_friend_from_sync = plex_user_data.get('is_friend', False)

        if mum_user: # Existing user
            changes_for_this_user = []
            original_username = mum_user.get_display_name() # For logging if username itself changes

            # Note: ServiceAccount model doesn't have plex_user_id or plex_uuid fields
            # if plex_id is not None and mum_user.plex_user_id != plex_id:
            #     changes_for_this_user.append(f"Plex User ID corrected from {mum_user.plex_user_id} to {plex_id}")
            #     mum_user.plex_user_id = plex_id
            # if plex_uuid_from_sync and mum_user.plex_uuid != plex_uuid_from_sync:
            #     changes_for_this_user.append(f"Plex UUID updated from {mum_user.plex_uuid} to {plex_uuid_from_sync}")
            #     mum_user.plex_uuid = plex_uuid_from_sync
            if mum_user.localUsername != plex_username_from_sync:
                changes_for_this_user.append(f"Username changed from '{mum_user.localUsername}' to '{plex_username_from_sync}'")
                mum_user.localUsername = plex_username_from_sync
            if mum_user.plex_email != plex_email_from_sync:
                changes_for_this_user.append(f"Email updated") # Don't log old/new email for privacy
                mum_user.plex_email = plex_email_from_sync
            if mum_user.plex_thumb_url != plex_thumb_from_sync:
                changes_for_this_user.append("Thumbnail updated")
                mum_user.plex_thumb_url = plex_thumb_from_sync
            
            current_mum_libs = mum_user.allowed_library_ids if mum_user.allowed_library_ids is not None else []
            if set(current_mum_libs) != set(new_library_ids_from_plex_list):
                changes_for_this_user.append(f"Libraries updated (Old: {len(current_mum_libs)}, New: {len(new_library_ids_from_plex_list)})")
                mum_user.allowed_library_ids = new_library_ids_from_plex_list
            if mum_user.is_home_user != is_home_user_from_sync:
                changes_for_this_user.append(f"Home User status changed to {is_home_user_from_sync}")
                mum_user.is_home_user = is_home_user_from_sync
            if mum_user.shares_back != shares_back_from_sync:
                changes_for_this_user.append(f"Shares Back status changed to {shares_back_from_sync}")
                mum_user.shares_back = shares_back_from_sync
            if hasattr(mum_user, 'is_plex_friend') and mum_user.is_plex_friend != is_friend_from_sync:
                changes_for_this_user.append(f"Plex Friend status changed to {is_friend_from_sync}")
                mum_user.is_plex_friend = is_friend_from_sync

            if changes_for_this_user:
                mum_user.last_synced_with_plex = datetime.utcnow()
                mum_user.updated_at = datetime.utcnow()
                updated_users_details.append({'username': plex_username_from_sync or original_username, 'changes': changes_for_this_user})
        else: # New user
            try:
                # Note: ServiceAccount model doesn't have plex_user_id or plex_uuid fields
                new_user_obj = User( # Create service user for Plex
                    userType=UserType.SERVICE,
                    server_id=plex_server.id,  # Assuming plex_server is available in context
                    external_user_id=plex_id,
                    external_username=plex_username_from_sync,
                    external_email=plex_email_from_sync,
                    external_avatar_url=plex_thumb_from_sync,
                    allowed_library_ids=new_library_ids_from_plex_list, 
                    is_home_user=is_home_user_from_sync,
                    shares_back=shares_back_from_sync,
                    last_activity_at=datetime.utcnow()
                )
                db.session.add(new_user_obj)
                added_users_details.append({'username': plex_username_from_sync, 'plex_id': plex_id})
            except IntegrityError as ie: 
                db.session.rollback()
                msg = f"Integrity error adding {plex_username_from_sync}: {ie}."
                current_app.logger.error(msg)
                error_count += 1; error_messages.append(msg)
            except Exception as e:
                db.session.rollback()
                msg = f"Error creating user {plex_username_from_sync}: {e}"
                current_app.logger.error(msg, exc_info=True)
                error_count += 1; error_messages.append(msg)

    # Check for users to remove based on service user data
    if plex_server:
        for access in plex_accesses:
            mum_user_obj = access.service_account
            is_on_server = False
            
            # Check if user is still on the Plex server
            if access.external_user_id and access.external_user_id in {str(uid) for uid in current_plex_user_ids_on_server}:
                is_on_server = True
            elif access.external_user_alt_id and access.external_user_alt_id in {str(uid) for uid in current_plex_user_ids_on_server}:
                is_on_server = True

            if not is_on_server:
                removed_users_details.append({
                    'username': mum_user_obj.get_display_name(), 
                    'mum_id': mum_user_obj.id, 
                    'plex_id': access.external_user_id
                })
                db.session.delete(mum_user_obj)
    
    if added_users_details or updated_users_details or removed_users_details or error_count > 0:
        try:
            db.session.commit()
            current_app.logger.info(f"DB commit successful for sync. Added: {len(added_users_details)}, Updated: {len(updated_users_details)}, Removed: {len(removed_users_details)}")
            # Log summary event
            log_event(EventType.PLEX_SYNC_USERS_COMPLETE, 
                      f"Plex user sync complete. Added: {len(added_users_details)}, Updated: {len(updated_users_details)}, Removed: {len(removed_users_details)}, Errors: {error_count}.",
                      details={
                          "added_count": len(added_users_details),
                          "updated_count": len(updated_users_details),
                          "removed_count": len(removed_users_details),
                          "errors": error_count
                      })
        except Exception as e_commit:
            db.session.rollback()
            msg = f"DB commit error during sync: {e_commit}"
            current_app.logger.error(msg, exc_info=True)
            error_count += (len(added_users_details) + len(updated_users_details) + len(removed_users_details)) # Count all attempts as errors if commit fails
            error_messages.append(msg)
            # Clear details lists as the changes were rolled back
            added_users_details = []
            updated_users_details = []
            removed_users_details = []
    
    return {
        'added': added_users_details, 
        'updated': updated_users_details, 
        'removed': removed_users_details, 
        'errors': error_count,
        'error_messages': error_messages
    }

def update_user_details(user_id, notes=None, new_library_ids=None,
                        is_discord_bot_whitelisted: bool = None,
                        is_purge_whitelisted: bool = None,
                        allow_downloads: bool = None,
                        allow_4k_transcode: bool = None,
                        admin_id: int = None):
    """
    Updates a user's details in the MUM database and syncs relevant changes to the Plex server.
    This function now correctly handles partial updates by sending the full final state to Plex.
    Uses UUID-based user identification only.
    """
    # Get user by UUID
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_id))
    
    if not user_obj:
        raise Exception(f"User not found: {user_id}")
    
    if user_type == "user_app_access":
        user = user_obj
    elif user_type == "user_media_access":
        # For user_media_access, get the associated UserAppAccess if it exists
        if user_obj.userType == UserType.SERVICE and user_obj.linkedUserId:
            user = User.query.filter_by(uuid=user_obj.linkedUserId, userType=UserType.LOCAL).first()
        else:
            raise Exception(f"Cannot update details for standalone service user {user_id}")
    else:
        raise Exception(f"Invalid user type: {user_type}")
    
    changes_made_to_mum = False
    
    plex_servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX)
    if not plex_servers:
        raise Exception("Plex server not found in media_servers table.")
    server = plex_servers[0]
    plex_service = MediaServiceFactory.create_service_from_db(server)
    if not plex_service:
        raise Exception("Failed to create Plex service from server configuration.")

    # --- MUM-only fields ---
    if notes is not None and user.notes != notes:
        user.notes = notes
        changes_made_to_mum = True

    if is_discord_bot_whitelisted is not None and user.is_discord_bot_whitelisted != is_discord_bot_whitelisted:
        user.is_discord_bot_whitelisted = is_discord_bot_whitelisted
        changes_made_to_mum = True
        log_event(EventType.SETTING_CHANGE, f"User '{user.get_display_name()}' Discord Bot Whitelist set to {is_discord_bot_whitelisted}", user_id=user.id, admin_id=admin_id)

    if is_purge_whitelisted is not None and user.is_purge_whitelisted != is_purge_whitelisted:
        user.is_purge_whitelisted = is_purge_whitelisted
        changes_made_to_mum = True
        log_event(EventType.SETTING_CHANGE, f"User '{user.get_display_name()}' Purge Whitelist set to {is_purge_whitelisted}", user_id=user.id, admin_id=admin_id)
        
    if allow_4k_transcode is not None and user.allow_4k_transcode != allow_4k_transcode:
        user.allow_4k_transcode = allow_4k_transcode
        changes_made_to_mum = True
        log_event(EventType.SETTING_CHANGE, f"User '{user.get_display_name()}' Allow 4K Transcode set to {allow_4k_transcode}", user_id=user.id, admin_id=admin_id)


    # --- Plex-related settings ---
    libraries_changed = False
    if new_library_ids is not None:
        current_mum_libs_set = set(user.allowed_library_ids or [])
        new_library_ids_set = set(new_library_ids)
        if current_mum_libs_set != new_library_ids_set:
            libraries_changed = True
            user.allowed_library_ids = new_library_ids # Update MUM record
            changes_made_to_mum = True
            log_event(EventType.MUM_USER_LIBRARIES_EDITED, f"Manually updated libraries for '{user.get_display_name()}'.", user_id=user.id, admin_id=admin_id)

    downloads_changed = False
    if allow_downloads is not None and user.allow_downloads != allow_downloads:
        downloads_changed = True
        user.allow_downloads = allow_downloads # Update MUM record
        changes_made_to_mum = True
        log_event(EventType.SETTING_CHANGE, f"User '{user.get_display_name()}' Allow Downloads set to {allow_downloads}", user_id=user.id, admin_id=admin_id)
        
    # --- Make the API call to Plex ONLY IF a Plex-related setting changed ---
    if libraries_changed or downloads_changed:
        try:
            current_app.logger.info(f"[DEBUG-USER_SVC] Preparing to call plex_service.update_user_access for user '{user.get_display_name()}'. State to send -> library_ids_to_share: {user.allowed_library_ids}, allow_sync: {user.allow_downloads}")
            # **THE FIX**: We now pass the user's complete, final desired library and download state to the service.
            # Get Plex user ID from service user
            plex_access = user.get_server_access(plex_server_id)
            plex_user_id = plex_access.external_user_id if plex_access else None
            
            if plex_user_id:
                plex_service.update_user_access(
                    user_id=plex_user_id,
                    library_ids=user.allowed_library_ids,  # Always send the user's full library list
                    allow_downloads=user.allow_downloads                 # Always send the user's full download permission
                )
            else:
                current_app.logger.warning(f"Cannot update Plex user access - no plex_user_id found for {user.get_display_name()}")
        except Exception as e:
            # Re-raise the exception to be handled by the route, which can flash an error
            raise Exception(f"Failed to update Plex permissions for {user.get_display_name()}: {e}")

    # If any MUM-only field changed, mark the record as updated
    if changes_made_to_mum:
        user.updated_at = datetime.utcnow()
    
    # The calling route is responsible for db.session.commit()
    return user

def delete_user_from_mum_and_plex(user_id, admin_id: int = None):
    """Universal user deletion function that works with all media services. Uses UUID-based identification only."""
    # Get user by UUID
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_id))
    
    if not user_obj:
        raise Exception(f"User not found: {user_id}")
    
    if user_type == "user_app_access":
        user = user_obj
        username = user.get_display_name()
        media_access = None
    elif user_type == "user_media_access":
        media_access = user_obj
        username = media_access.external_username or f"Service User {user_obj.id}"
        user = None  # No local user for standalone service users
    else:
        raise Exception(f"Invalid user type: {user_type}")
    
    # Determine which service this user belongs to based on their data
    service_type = None
    user_service_id = None
    
    # Check if user has Plex access via service user
    from app.models_media_services import ServiceType
    
    if user_type == "user_app_access" and user:
        # Local user - check their media accesses
        plex_access = User.query.filter_by(
            linkedUserId=user.uuid,
            userType=UserType.SERVICE,
            server_id=MediaServer.query.filter_by(service_type=ServiceType.PLEX).first().id if MediaServer.query.filter_by(service_type=ServiceType.PLEX).first() else None
        ).first()
        
        if plex_access and plex_access.external_user_id:
            service_type = ServiceType.PLEX
            user_service_id = plex_access.external_user_id
        # Check for other service types via linked service users
        if not service_type:
            linked_service_users = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=user.uuid).all()
            for service_user in linked_service_users:
                if service_user.server and service_user.external_user_id:
                    service_type = service_user.server.service_type
                    user_service_id = service_user.external_user_id
                    break
    else:
        # Standalone service user - use the media_access directly
        if media_access.server and media_access.external_user_id:
            service_type = media_access.server.service_type
            user_service_id = media_access.external_user_id
    
    if not service_type:
        # Fallback: try to find any available service
        current_app.logger.warning(f"Could not determine service type for user {username}, trying available services...")
        for stype in [ServiceType.PLEX, ServiceType.JELLYFIN, ServiceType.EMBY]:
            servers = MediaServiceManager.get_servers_by_type(stype)
            if servers:
                service_type = stype
                break
        
        if not service_type:
            raise Exception("No media servers found for user deletion.")
    
    # Get the appropriate service
    servers = MediaServiceManager.get_servers_by_type(service_type)
    if not servers:
        raise Exception(f"{service_type.value} server not found in media_servers table.")
    
    server = servers[0]
    service = MediaServiceFactory.create_service_from_db(server)
    if not service:
        raise Exception(f"Failed to create {service_type.value} service from server configuration.")
    
    try:
        current_app.logger.info(f"Attempting to delete user '{username}' from {service_type.value} server using ID: {user_service_id}")
        
        # Delete from the media service
        if user_service_id:
            success = service.delete_user(user_service_id)
            if not success:
                raise Exception(f"Service returned failure for user deletion")
        else:
            current_app.logger.warning(f"No service user ID found for {username}, skipping service deletion")
        
        # Delete from MUM database
        if user_type == "user_app_access" and user:
            # Delete local user (cascades to linked service users)
            db.session.delete(user)
        else:
            # Delete standalone service user
            db.session.delete(media_access)
        
        db.session.commit()
        
        log_event(EventType.MUM_USER_DELETED_FROM_MUM, 
                 f"User '{username}' removed from MUM and {service_type.value} server.", 
                 admin_id=admin_id, 
                 details={
                     'deleted_username': username, 
                     'deleted_user_id_in_mum': user_id, 
                     'service_type': service_type.value,
                     'service_user_id': user_service_id
                 })
        return True
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Failed to fully delete user {username}: {e}", exc_info=True)
        # Log event for the failure as well
        log_event(EventType.ERROR_GENERAL, f"Failed to delete user {username}: {e}", admin_id=admin_id, user_id=user_id)
        raise Exception(f"Failed to remove user {username} from MUM: {e}")

def mass_update_user_libraries(user_ids: list, new_library_ids: list, admin_id: int = None):
    processed_count = 0; error_count = 0;
    
    # Convert UUIDs to actual user IDs for local users only
    local_user_ids = []
    from app.utils.helpers import get_user_by_uuid
    
    for user_id in user_ids:
        try:
            user_obj, user_type = get_user_by_uuid(str(user_id))
            if user_obj and user_type == "user_app_access":
                local_user_ids.append(user_obj.id)
            # Note: mass library updates only apply to local users
        except Exception as e:
            current_app.logger.error(f"Mass Update Error: Invalid user UUID {user_id}: {e}")
            error_count += 1
    
    users_to_update = User.query.filter_by(userType=UserType.LOCAL).filter(User.id.in_(local_user_ids)).all()
    db_library_value_to_set = list(new_library_ids) if new_library_ids is not None else [] # Ensure it's a list for DB
    plex_servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX)
    if not plex_servers:
        raise Exception("Plex server not found in media_servers table.")
    server = plex_servers[0]
    plex_service = MediaServiceFactory.create_service_from_db(server)
    if not plex_service:
        raise Exception("Failed to create Plex service from server configuration.")

    for user in users_to_update:
        try:
            current_mum_libs = user.allowed_library_ids if user.allowed_library_ids is not None else []
            needs_plex_update = (set(current_mum_libs) != set(db_library_value_to_set))
            
            if needs_plex_update:
                # Get Plex user ID from service user
                plex_server = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
                if plex_server:
                    plex_access = user.get_server_access(plex_server.id)
                    plex_user_id = plex_access.external_user_id if plex_access else None
                    
                    if plex_user_id:
                        plex_service.update_user_access(plex_user_id, db_library_value_to_set)
                    else:
                        current_app.logger.warning(f"Cannot update Plex user access - no plex_user_id found for {user.get_display_name()}")
                else:
                    current_app.logger.warning(f"Cannot update Plex user access - no Plex server configured") 
                user.allowed_library_ids = db_library_value_to_set 
                user.updated_at = datetime.utcnow()
            processed_count += 1
        except Exception as e:
            current_app.logger.error(f"Mass Update Error: User {user.get_display_name()} (ID: {user.id}): {e}");
            error_count += 1
    if processed_count > 0 or error_count > 0: 
        try:
            db.session.commit()
            log_event(EventType.MUM_USER_LIBRARIES_EDITED, f"Mass update: Libs processed for {processed_count} users.", admin_id=admin_id, details={'attempted_count': len(user_ids), 'success_count': processed_count - error_count, 'errors': error_count})
        except Exception as e:
            db.session.rollback(); current_app.logger.error(f"Mass Update: DB commit error: {e}");
            error_count = len(users_to_update); 
            raise Exception(f"Mass Update: DB commit failed: {e}")
    return processed_count, error_count

def mass_update_user_libraries_by_server(user_ids: list, updates_by_server: dict, admin_id: int = None):

    processed_count = 0
    error_count = 0
    
    # Convert UUIDs to get user objects and separate by type
    local_users = []
    service_users = []
    from app.utils.helpers import get_user_by_uuid
    
    for user_id in user_ids:
        try:
            user_obj, user_type = get_user_by_uuid(str(user_id))
            if user_obj and user_type == "user_app_access":
                local_users.append(user_obj)
            elif user_obj and user_type == "user_media_access":
                service_users.append(user_obj)
        except Exception as e:
            current_app.logger.error(f"Mass Update by Server Error: Invalid user UUID {user_id}: {e}")
            error_count += 1
    
    current_app.logger.info(f"Mass Update by Server: Processing {len(local_users)} local users and {len(service_users)} standalone service users")
    current_app.logger.info(f"Mass Update by Server: updates_by_server = {updates_by_server}")

    for server_id, new_library_ids in updates_by_server.items():
        server = MediaServiceManager.get_server_by_id(server_id)
        if not server:
            current_app.logger.error(f"Mass Update: Could not find server with ID {server_id}. Skipping.")
            error_count += len(user_ids)
            continue

        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            current_app.logger.error(f"Mass Update: Could not create service for server {server.server_nickname}. Skipping.")
            error_count += len(user_ids)
            continue

        current_app.logger.info(f"Mass Update: Processing server {server.server_nickname} (ID: {server_id}) with {len(new_library_ids)} libraries")

        # Handle linked service users (from local users)
        if local_users:
            local_user_uuids = [user.uuid for user in local_users]
            linked_access_records = User.query.filter_by(userType=UserType.SERVICE).filter(
                User.server_id == server_id, 
                User.linkedUserId.in_(local_user_uuids)
            ).all()
            
            for access in linked_access_records:
                linked_user = next((u for u in local_users if u.uuid == access.linkedUserId), None)
                if not linked_user:
                    continue

                try:
                    # Handle Kavita library ID conversion if needed
                    converted_library_ids = new_library_ids
                    if server.service_type.value == 'kavita':
                        current_app.logger.info(f"Mass Update: Converting Kavita library IDs for {access.external_username}")
                        # For Kavita, need to convert UUIDs back to external_ids for API call
                        from app.models_media_services import MediaLibrary
                        external_library_ids = []
                        for uuid_lib_id in new_library_ids:
                            library = MediaLibrary.query.filter_by(
                                server_id=server_id,
                                internal_id=uuid_lib_id
                            ).first()
                            if library:
                                external_library_ids.append(library.external_id)
                                current_app.logger.info(f"Mass Update: Converted UUID {uuid_lib_id} to external_id {library.external_id}")
                            else:
                                current_app.logger.warning(f"Mass Update: Could not find library with UUID {uuid_lib_id}")
                        
                        # Use external IDs for the API call
                        api_library_ids = external_library_ids
                        # But still store UUIDs in the database
                        converted_library_ids = new_library_ids
                    else:
                        # For non-Kavita services, use the IDs as-is
                        api_library_ids = new_library_ids
                        converted_library_ids = new_library_ids
                    
                    # Update the user on the actual media server via API
                    if hasattr(service, 'update_user_access') and access.external_user_id:
                        current_app.logger.info(f"Mass Update: Calling {server.service_type.value} API to update user {access.external_user_id} with libraries: {api_library_ids}")
                        service.update_user_access(access.external_user_id, api_library_ids)
                        current_app.logger.info(f"Mass Update: Successfully updated {access.external_username} on {server.server_nickname} via API")
                    else:
                        current_app.logger.warning(f"Mass Update: Cannot update {server.service_type.value} server - service doesn't support update_user_access or no external_user_id")
                    
                    # Update the service user record with converted IDs
                    current_app.logger.info(f"Mass Update: Updating database record for {access.external_username} on {server.server_nickname} with libraries: {converted_library_ids}")
                    access.allowed_library_ids = converted_library_ids
                    linked_user.updated_at = datetime.utcnow()
                    processed_count += 1
                except Exception as e:
                    current_app.logger.error(f"Mass Update Error for linked user {linked_user.get_display_name()} on server {server.server_nickname}: {e}")
                    error_count += 1

        # Handle standalone service users (no local user link)
        standalone_access_records = [user for user in service_users if user.server_id == server_id]
        
        for access in standalone_access_records:
            try:
                # Handle Kavita library ID conversion if needed
                converted_library_ids = new_library_ids
                if server.service_type.value == 'kavita':
                    current_app.logger.info(f"Mass Update: Converting Kavita library IDs for standalone user {access.external_username}")
                    # For Kavita, need to convert UUIDs back to external_ids for API call
                    from app.models_media_services import MediaLibrary
                    external_library_ids = []
                    for uuid_lib_id in new_library_ids:
                        library = MediaLibrary.query.filter_by(
                            server_id=server_id,
                            internal_id=uuid_lib_id
                        ).first()
                        if library:
                            external_library_ids.append(library.external_id)
                            current_app.logger.info(f"Mass Update: Converted UUID {uuid_lib_id} to external_id {library.external_id}")
                        else:
                            current_app.logger.warning(f"Mass Update: Could not find library with UUID {uuid_lib_id}")
                    
                    # Use external IDs for the API call
                    api_library_ids = external_library_ids
                    # But still store UUIDs in the database
                    converted_library_ids = new_library_ids
                else:
                    # For non-Kavita services, use the IDs as-is
                    api_library_ids = new_library_ids
                    converted_library_ids = new_library_ids
                
                # Update the user on the actual media server via API
                if hasattr(service, 'update_user_access') and access.external_user_id:
                    current_app.logger.info(f"Mass Update: Calling {server.service_type.value} API to update user {access.external_user_id} with libraries: {api_library_ids}")
                    service.update_user_access(access.external_user_id, api_library_ids)
                    current_app.logger.info(f"Mass Update: Successfully updated {access.external_username} on {server.server_nickname} via API")
                else:
                    current_app.logger.warning(f"Mass Update: Cannot update {server.service_type.value} server - service doesn't support update_user_access or no external_user_id")
                
                # Update the standalone service user record in database
                current_app.logger.info(f"Mass Update: Updating database record for standalone user {access.external_username} on {server.server_nickname} with libraries: {converted_library_ids}")
                access.allowed_library_ids = converted_library_ids
                access.updated_at = datetime.utcnow()
                processed_count += 1
            except Exception as e:
                current_app.logger.error(f"Mass Update Error for standalone user {access.external_username} on server {server.server_nickname}: {e}")
                error_count += 1

    if processed_count > 0 or error_count > 0:
        try:
            db.session.commit()
            log_event(EventType.MUM_USER_LIBRARIES_EDITED, f"Mass library update by server complete. Processed {processed_count} user-server relations with {error_count} errors.", admin_id=admin_id)
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Mass Update by Server: DB commit error: {e}")
            raise

    return processed_count, error_count


def mass_update_bot_whitelist(user_uuids: list, should_whitelist: bool, admin_id: int = None):
    """Mass update bot whitelist for service users"""
    from app.utils.helpers import get_user_by_uuid
    updated_count = 0
    
    for uuid_str in user_uuids:
        try:
            user_obj, user_type = get_user_by_uuid(uuid_str)
            if user_obj and user_type == "user_media_access":
                if user_obj.is_bot_whitelisted != should_whitelist:
                    user_obj.is_bot_whitelisted = should_whitelist
                    updated_count += 1
        except Exception as e:
            current_app.logger.error(f"Error updating bot whitelist for service user {uuid_str}: {e}")
    
    if updated_count > 0: 
        db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Mass updated Discord Bot Whitelist for {updated_count} service users to {should_whitelist}.", admin_id=admin_id, details={"count": updated_count, "whitelisted": should_whitelist})
    return updated_count

def mass_update_purge_whitelist(user_uuids: list, should_whitelist: bool, admin_id: int = None):
    """Mass update purge whitelist for service users"""
    from app.utils.helpers import get_user_by_uuid
    updated_count = 0
    
    for uuid_str in user_uuids:
        try:
            user_obj, user_type = get_user_by_uuid(uuid_str)
            if user_obj and user_type == "user_media_access":
                if user_obj.is_purge_whitelisted != should_whitelist:
                    user_obj.is_purge_whitelisted = should_whitelist
                    updated_count += 1
        except Exception as e:
            current_app.logger.error(f"Error updating purge whitelist for service user {uuid_str}: {e}")
    
    if updated_count > 0: 
        db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Mass updated Purge Whitelist for {updated_count} service users to {should_whitelist}.", admin_id=admin_id, details={"count": updated_count, "whitelisted": should_whitelist})
    return updated_count

def mass_delete_users(user_ids: list, admin_id: int = None):
    processed_count = 0; error_count = 0;
    usernames_for_log_detail = []
    
    # Import required models
    from app.utils.helpers import get_user_by_uuid
    
    # Convert UUIDs to actual user IDs and separate by type
    local_user_ids = []
    standalone_user_ids = []
    
    for user_id in user_ids:
        try:
            user_obj, user_type = get_user_by_uuid(str(user_id))
            if user_obj and user_type == "user_app_access":
                local_user_ids.append(user_obj.id)
            elif user_obj and user_type == "user_media_access":
                standalone_user_ids.append(user_obj.id)
        except Exception as e:
            current_app.logger.error(f"Mass Delete Error: Invalid user UUID {user_id}: {e}")
            error_count += 1
    
    current_app.logger.info(f"Mass Delete: Processing {len(local_user_ids)} local users and {len(standalone_user_ids)} standalone users")
    
    # Delete local users
    if local_user_ids:
        users_to_delete = User.query.filter_by(userType=UserType.LOCAL).filter(User.id.in_(local_user_ids)).all()
        
        for user in users_to_delete:
            username_for_log = user.get_display_name()
            user_deleted_successfully = False
            
            try:
                # Get all service user records for this user to delete from all services
                user_accesses = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=user.uuid).all()
                
                # Try to delete from external services first, but don't fail if they're unavailable
                for access in user_accesses:
                    server = access.server
                    if access.external_user_id and server:
                        try:
                            # Create service instance and delete user from the actual server
                            service = MediaServiceFactory.create_service_from_db(server)
                            if service and hasattr(service, 'delete_user'):
                                service.delete_user(access.external_user_id)
                                current_app.logger.info(f"Deleted user {username_for_log} from {server.service_type.value} server {server.server_nickname}")
                            else:
                                current_app.logger.warning(f"Cannot delete user from {server.service_type.value} server {server.server_nickname} - service not available or doesn't support deletion")
                        except Exception as e:
                            current_app.logger.error(f"Failed to delete user {username_for_log} from {server.service_type.value} server {server.server_nickname}: {e}")
                            # Continue with deletion from MUM even if server deletion fails
                
                # Delete the local user from MUM (this will cascade to linked service user records)
                db.session.delete(user)
                user_deleted_successfully = True
                processed_count += 1
                usernames_for_log_detail.append(username_for_log)
                current_app.logger.info(f"Marked local user {username_for_log} for deletion from MUM")
                
            except Exception as e:
                current_app.logger.error(f"Mass Delete Error: Local user {username_for_log} (ID: {user.id}): {e}")
                error_count += 1
                # If there was an error, try to rollback any partial changes for this user
                if not user_deleted_successfully:
                    try:
                        db.session.rollback()
                        db.session.begin()  # Start a new transaction
                    except Exception as rollback_error:
                        current_app.logger.error(f"Error during rollback for user {username_for_log}: {rollback_error}")
    
    # Delete standalone service users
    if standalone_user_ids:
        for standalone_user_id in standalone_user_ids:
            access_deleted_successfully = False
            username_for_log = 'Unknown'
            
            try:
                # Get the service user record directly using the actual ID
                access = User.query.filter_by(userType=UserType.SERVICE).filter(
                    User.id == standalone_user_id,
                    User.linkedUserId.is_(None)
                ).first()
                
                if access:
                    username_for_log = access.external_username or 'Unknown'
                    server = access.server
                    
                    # Try to delete from the actual server first
                    if access.external_user_id and server:
                        try:
                            service = MediaServiceFactory.create_service_from_db(server)
                            if service and hasattr(service, 'delete_user'):
                                service.delete_user(access.external_user_id)
                                current_app.logger.info(f"Deleted standalone user {username_for_log} from {server.service_type.value} server {server.server_nickname}")
                            else:
                                current_app.logger.warning(f"Cannot delete user from {server.service_type.value} server {server.server_nickname} - service not available or doesn't support deletion")
                        except Exception as e:
                            current_app.logger.error(f"Failed to delete standalone user {username_for_log} from {server.service_type.value} server {server.server_nickname}: {e}")
                            # Continue with deletion from MUM even if server deletion fails
                    
                    # Delete the standalone service user record
                    db.session.delete(access)
                    access_deleted_successfully = True
                    processed_count += 1
                    usernames_for_log_detail.append(username_for_log)
                    current_app.logger.info(f"Marked standalone service user {username_for_log} for deletion from MUM")
                else:
                    current_app.logger.warning(f"Standalone user with ID {standalone_user_id} not found")
                    error_count += 1
                    
            except Exception as e:
                current_app.logger.error(f"Mass Delete Error: Standalone user (ID: {standalone_user_id}): {e}")
                error_count += 1
                # If there was an error, try to rollback any partial changes for this user
                if not access_deleted_successfully:
                    try:
                        db.session.rollback()
                        db.session.begin()  # Start a new transaction
                    except Exception as rollback_error:
                        current_app.logger.error(f"Error during rollback for standalone user {username_for_log}: {rollback_error}")
    
    # Commit all deletions at once
    if processed_count > 0:
        try:
            current_app.logger.info(f"Mass Delete: Committing deletion of {processed_count} users to database...")
            db.session.commit()
            current_app.logger.info(f"Mass Delete: Successfully committed {processed_count} user deletions")
            log_event(EventType.MUM_USER_DELETED_FROM_MUM, f"Mass delete: {processed_count} users removed from MUM and media servers.", admin_id=admin_id, details={'deleted_count': processed_count, 'errors': error_count, 'attempted_ids_count': len(user_ids), 'deleted_usernames_sample': usernames_for_log_detail[:10]})
        except Exception as e_commit:
            db.session.rollback()
            current_app.logger.error(f"Mass Delete: DB commit error: {e_commit}")
            # All deletions failed due to commit error
            error_count += processed_count
            processed_count = 0
            log_event(EventType.ERROR_GENERAL, f"Mass delete DB commit failed: {e_commit}", admin_id=admin_id, details={'attempted_count': len(user_ids)})
    elif error_count > 0:
        # No successes, only errors, still log the attempt
        current_app.logger.warning(f"Mass Delete: No users were successfully processed. {error_count} errors occurred.")
        log_event(EventType.ERROR_GENERAL, f"Mass delete attempt failed for all {error_count} users selected.", admin_id=admin_id, details={'attempted_count': len(user_ids), 'errors': error_count})
    else:
        current_app.logger.warning("Mass Delete: No users were provided for deletion.")


    return processed_count, error_count

def update_user_last_streamed(plex_user_id_or_uuid, last_streamed_at_datetime: datetime):
    # Find user via service user using Plex ID or UUID
    user = None
    from app.models_media_services import ServiceType
    
    plex_server = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
    if not plex_server:
        current_app.logger.warning(f"update_user_last_streamed: No Plex server configured")
        return False
    
    if isinstance(plex_user_id_or_uuid, int) or (isinstance(plex_user_id_or_uuid, str) and plex_user_id_or_uuid.isdigit()):
        # Look up by Plex user ID
        access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
            server_id=plex_server.id,
            external_user_id=str(plex_user_id_or_uuid)
        ).first()
        if access:
            user = access.service_account
    elif isinstance(plex_user_id_or_uuid, str):
        # Look up by Plex UUID
        access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
            server_id=plex_server.id,
            external_user_alt_id=plex_user_id_or_uuid
        ).first()
        if access:
            user = access.service_account
    else:
        current_app.logger.warning(f"User_Service.py - update_user_last_streamed(): Unexpected type for plex_user_id_or_uuid: {type(plex_user_id_or_uuid)}")
        return False
    
    if not user:
        current_app.logger.debug(f"update_user_last_streamed: No user found for Plex ID/UUID: {plex_user_id_or_uuid}")
        return False

    if user:
        if last_streamed_at_datetime.tzinfo is None: 
            last_streamed_at_datetime = last_streamed_at_datetime.replace(tzinfo=timezone.utc)
        
        db_last_streamed_at_naive = user.last_streamed_at 
        db_last_streamed_at_aware = None
        if db_last_streamed_at_naive:
            db_last_streamed_at_aware = db_last_streamed_at_naive.replace(tzinfo=timezone.utc)
        
        if db_last_streamed_at_aware is None or last_streamed_at_datetime > db_last_streamed_at_aware:
            user.last_streamed_at = last_streamed_at_datetime.replace(tzinfo=None) 
            user.updated_at = datetime.utcnow().replace(tzinfo=None)
            try: 
                db.session.commit()
                current_app.logger.info(f"User_Service.py - update_user_last_streamed(): Updated last_streamed_at for {user.get_display_name()} to {user.last_streamed_at}")
                return True
            except Exception as e: 
                db.session.rollback()
                current_app.logger.error(f"User_Service.py - update_user_last_streamed(): DB Commit Error for user {user.get_display_name()} (Plex ID/UUID: {plex_user_id_or_uuid}): {e}", exc_info=True)
        # else:
            # current_app.logger.debug(f"User_Service.py - update_user_last_streamed(): No update needed for {user.get_display_name()}. DB: {db_last_streamed_at_aware}, Current: {last_streamed_at_datetime}")
    # else:
        # current_app.logger.warning(f"User_Service.py - update_user_last_streamed(): User not found in MUM with Plex ID/UUID: {plex_user_id_or_uuid}.")
    return False

def update_user_last_streamed_by_id(user_id, last_streamed_at_datetime: datetime):
    """Universal function to update last_streamed_at for any user by their MUM user ID. Uses UUID-based identification only."""
    # Get user by UUID
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_id))
    
    if not user_obj:
        current_app.logger.warning(f"User_Service.py - update_user_last_streamed_by_id(): User not found with ID: {user_id}")
        return False
    
    if user_type == "user_app_access":
        user = user_obj
    elif user_type == "user_media_access":
        # For user_media_access, get the associated UserAppAccess if it exists
        if user_obj.linkedUserId:
            user = User.query.filter_by(userType=UserType.LOCAL).get(user_obj.linkedUserId)
        else:
            current_app.logger.warning(f"User_Service.py - update_user_last_streamed_by_id(): Cannot update last streamed for standalone service user {user_id}")
            return False
    else:
        current_app.logger.warning(f"User_Service.py - update_user_last_streamed_by_id(): Invalid user type {user_type} for user {user_id}")
        return False
    
    if not user:
        current_app.logger.warning(f"User_Service.py - update_user_last_streamed_by_id(): User not found with ID: {user_id}")
        return False

    if last_streamed_at_datetime.tzinfo is None: 
        last_streamed_at_datetime = last_streamed_at_datetime.replace(tzinfo=timezone.utc)
    
    db_last_streamed_at_naive = user.last_streamed_at 
    db_last_streamed_at_aware = None
    if db_last_streamed_at_naive:
        db_last_streamed_at_aware = db_last_streamed_at_naive.replace(tzinfo=timezone.utc)
    
    if db_last_streamed_at_aware is None or last_streamed_at_datetime > db_last_streamed_at_aware:
        user.last_streamed_at = last_streamed_at_datetime.replace(tzinfo=None) 
        user.updated_at = datetime.utcnow().replace(tzinfo=None)
        try: 
            db.session.commit()
            # Updated user last streamed timestamp
            return True
        except Exception as e: 
            db.session.rollback()
            current_app.logger.error(f"User_Service.py - update_user_last_streamed_by_id(): DB Commit Error for user {user.get_display_name()} (ID: {user_id}): {e}", exc_info=True)
    return False

def purge_inactive_users(user_ids_to_purge: list[int], admin_id: int, inactive_days_threshold: int, exclude_sharers: bool, exclude_whitelisted: bool, ignore_creation_date_for_never_streamed: bool):
    """
    Deletes a specific list of service users, but only after re-validating them
    against the provided criteria as a final safety check.
    """
    if not user_ids_to_purge:
        return {"message": "No users were selected for purge.", "purged_count": 0, "errors": 0}

    # Re-run the eligibility check on the provided list of users as a safeguard.
    eligible_users_final = get_users_eligible_for_purge(
        inactive_days_threshold, exclude_sharers, exclude_whitelisted, ignore_creation_date_for_never_streamed
    )
    final_ids_to_delete = {user['id'] for user in eligible_users_final}.intersection(set(user_ids_to_purge))
    
    purged_count = 0
    error_count = 0
    
    # Query service users instead of local users
    users_to_process = User.query.filter_by(userType=UserType.SERVICE).filter(
        User.id.in_(final_ids_to_delete)
    ).all()

    for user in users_to_process:
        try:
            username = user.external_username or 'Unknown'
            server = user.server
            
            # Try to delete from the actual server first
            if user.external_user_id and server:
                try:
                    service = MediaServiceFactory.create_service_from_db(server)
                    if service and hasattr(service, 'delete_user'):
                        service.delete_user(user.external_user_id)
                        current_app.logger.info(f"Deleted service user {username} from {server.service_type.value} server {server.server_nickname}")
                    else:
                        current_app.logger.warning(f"Cannot delete user from {server.service_type.value} server {server.server_nickname} - service not available or doesn't support deletion")
                except Exception as e:
                    current_app.logger.error(f"Failed to delete service user {username} from {server.service_type.value} server {server.server_nickname}: {e}")
                    # Continue with deletion from MUM even if server deletion fails
            
            # Delete the service user record from MUM
            db.session.delete(user)
            purged_count += 1
            current_app.logger.info(f"Purged service user {username} (ID: {user.id})")
            
        except Exception as e:
            error_count += 1
            username = getattr(user, 'external_username', 'Unknown') or 'Unknown'
            current_app.logger.error(f"User_Service.py - purge_inactive_users(): Error purging service user {username} (ID: {user.id}): {e}")

    # Commit all deletions
    if purged_count > 0:
        try:
            db.session.commit()
            current_app.logger.info(f"Purge: Successfully committed deletion of {purged_count} service users")
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Purge: DB commit error: {e}")
            error_count += purged_count
            purged_count = 0

    result_message = f"Purge complete: {purged_count} service users removed."
    if len(final_ids_to_delete) != len(user_ids_to_purge):
        result_message += f" ({len(user_ids_to_purge) - len(final_ids_to_delete)} skipped by final safety check)."
    if error_count > 0:
        result_message += f" {error_count} errors."

    log_event(EventType.MUM_USER_DELETED_FROM_MUM, result_message, admin_id=admin_id, details={
        "action": "purge_selected_inactive_service_users", "purged_count": purged_count, "errors": error_count
    })
    
    return {"message": result_message, "purged_count": purged_count, "errors": error_count}

def get_users_eligible_for_purge(inactive_days_threshold: int, exclude_sharers: bool, exclude_whitelisted: bool, ignore_creation_date_for_never_streamed: bool = False):
    if inactive_days_threshold < 1:
        raise ValueError("Inactivity threshold must be at least 1 day.")

    cutoff_date = datetime.now(timezone.utc) - timedelta(days=inactive_days_threshold)
    
    # Base query for service users - both standalone and linked
    query = User.query.filter_by(userType=UserType.SERVICE)

    # Apply filters based on the checkboxes
    if exclude_whitelisted: 
        query = query.filter(User.is_purge_whitelisted != True)
    
    if exclude_sharers:
        # Filter out users who share back their servers (if this field exists)
        query = query.filter(User.shares_back != True)
        
    eligible_users_list = []
    potential_users = query.all()

    for user in potential_users:
        is_eligible_for_purge = False
        
        # Check MediaStreamHistory for service users using user_uuid
        from app.models_media_services import MediaStreamHistory
        last_stream = MediaStreamHistory.query.filter_by(user_uuid=user.uuid).order_by(MediaStreamHistory.started_at.desc()).first()
        last_streamed_at = last_stream.started_at if last_stream else None
        
        if last_streamed_at is None:
            if ignore_creation_date_for_never_streamed:
                is_eligible_for_purge = True
            else:
                created_at_aware = user.created_at.replace(tzinfo=timezone.utc) if user.created_at.tzinfo is None else user.created_at
                if created_at_aware < cutoff_date:
                    is_eligible_for_purge = True
        else: 
            last_streamed_aware = last_streamed_at.replace(tzinfo=timezone.utc) if last_streamed_at.tzinfo is None else last_streamed_at
            if last_streamed_aware < cutoff_date:
                is_eligible_for_purge = True
        
        if is_eligible_for_purge:
            # Process avatar URL using the same logic as user cards
            avatar_url = None
            if user.external_avatar_url:
                avatar_url = user.external_avatar_url
            elif user.server and user.server.service_type.value == 'plex':
                # For Plex, check multiple possible locations for the thumb URL
                thumb_url = None
                
                # First try service_settings
                if user.service_settings and user.service_settings.get('thumb'):
                    thumb_url = user.service_settings['thumb']
                # Then try raw_data from the user sync
                elif user.user_raw_data and user.user_raw_data.get('thumb'):
                    thumb_url = user.user_raw_data['thumb']
                # Also check nested raw data structure
                elif (user.user_raw_data and 
                      user.user_raw_data.get('plex_user_obj_attrs') and 
                      user.user_raw_data['plex_user_obj_attrs'].get('thumb')):
                    thumb_url = user.user_raw_data['plex_user_obj_attrs']['thumb']
                
                if thumb_url:
                    # Check if it's already a full URL (plex.tv avatars) or needs proxy
                    if thumb_url.startswith('https://plex.tv/') or thumb_url.startswith('http://plex.tv/'):
                        avatar_url = thumb_url
                    else:
                        avatar_url = f"/api/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
            elif user.server and user.server.service_type.value == 'jellyfin':
                # For Jellyfin, use the external_user_id to get avatar
                if user.external_user_id:
                    avatar_url = f"/api/media/jellyfin/users/avatar?user_id={user.external_user_id}"
            
            eligible_users_list.append({ 
                'id': user.id, 
                'username': user.external_username or 'Unknown', 
                'email': user.external_email, 
                'last_streamed_at': last_streamed_at, 
                'created_at': user.created_at,
                'server_name': user.server.server_nickname if user.server else 'Unknown Server',
                'service_type': user.server.service_type.value if user.server else 'unknown',
                'avatar_url': avatar_url
            })
            
    return eligible_users_list

def get_user_stream_stats(user_id):
    """Aggregates stream history for a user to produce Tautulli-like stats. Uses UUID-based identification only."""
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(days=1)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    # Get user by UUID
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_id))
    
    if not user_obj:
        current_app.logger.error(f"User not found in get_user_stream_stats: {user_id}")
        return {'global': {}, 'players': []}
    
    # Build query filter using unified user_uuid column
    filter_condition = MediaStreamHistory.user_uuid == user_obj.uuid
    current_app.logger.debug(f"STATS SERVICE: UUID lookup successful for {user_id} -> user_uuid: {user_obj.uuid}")

    # --- Global Stats ---
    # Perform all aggregations in a single query for efficiency
    stats_query = db.session.query(
        func.count(MediaStreamHistory.id).label('all_time_plays'),
        func.sum(MediaStreamHistory.duration_seconds).label('all_time_duration'),
        func.sum(case((MediaStreamHistory.started_at >= day_ago, MediaStreamHistory.duration_seconds), else_=0)).label('duration_24h'),
        func.count(case((MediaStreamHistory.started_at >= day_ago, 1), else_=None)).label('plays_24h'),
        func.sum(case((MediaStreamHistory.started_at >= week_ago, MediaStreamHistory.duration_seconds), else_=0)).label('duration_7d'),
        func.count(case((MediaStreamHistory.started_at >= week_ago, 1), else_=None)).label('plays_7d'),
        func.count(case((MediaStreamHistory.started_at >= month_ago, 1), else_=None)).label('plays_30d'),
        func.sum(case((MediaStreamHistory.started_at >= month_ago, MediaStreamHistory.duration_seconds), else_=0)).label('duration_30d')
    ).filter(filter_condition).first()

    current_app.logger.debug(f"STATS SERVICE: Query result - plays: {stats_query.all_time_plays}, duration: {stats_query.all_time_duration}")

    global_stats = {
        'plays_24h': stats_query.plays_24h or 0,
        'duration_24h': format_duration(stats_query.duration_24h or 0),
        'plays_7d': stats_query.plays_7d or 0,
        'duration_7d': format_duration(stats_query.duration_7d or 0),
        'plays_30d': stats_query.plays_30d or 0,
        'duration_30d': format_duration(stats_query.duration_30d or 0),
        'all_time_plays': stats_query.all_time_plays or 0,
        'all_time_duration': format_duration(stats_query.all_time_duration or 0),
        'all_time_duration_seconds': stats_query.all_time_duration or 0  # Add raw seconds for template
    }

    # --- Player Stats ---
    player_stats_query = db.session.query(
        MediaStreamHistory.player,
        func.count(MediaStreamHistory.id).label('play_count')
    ).filter(filter_condition).group_by(MediaStreamHistory.player).order_by(func.count(MediaStreamHistory.id).desc()).all()

    player_stats = [{'name': p.player or 'Unknown', 'plays': p.play_count} for p in player_stats_query]

    return {'global': global_stats, 'players': player_stats}

def get_bulk_user_stream_stats(user_ids: list[int]) -> dict:
    """
    Efficiently gets total plays and duration for a list of user IDs.
    Returns a dictionary mapping user_id to its stats.
    Handles both local users and service users.
    """
    if not user_ids:
        return {}

    # Convert user IDs to UUIDs for the query, separating by user type
    from app.utils.helpers import get_user_by_uuid
    app_access_uuids = []
    media_access_uuids = []
    uuid_to_user_id = {}
    
    for user_id in user_ids:
        try:
            user_obj, user_type = get_user_by_uuid(str(user_id))
            if user_obj and user_type == "user_app_access":
                app_access_uuids.append(user_obj.uuid)
                uuid_to_user_id[user_obj.uuid] = user_id
            elif user_obj and user_type == "user_media_access":
                media_access_uuids.append(user_obj.uuid)
                uuid_to_user_id[user_obj.uuid] = user_id
        except Exception:
            continue
    
    if not app_access_uuids and not media_access_uuids:
        return {}
    
    stats_results = {}
    
    # Query for local users
    # Query for all users using unified user_uuid field
    all_user_uuids = app_access_uuids + media_access_uuids
    if all_user_uuids:
        results = db.session.query(
            MediaStreamHistory.user_uuid,
            func.count(MediaStreamHistory.id).label('total_plays'),
            func.sum(MediaStreamHistory.duration_seconds).label('total_duration')
        ).filter(MediaStreamHistory.user_uuid.in_(all_user_uuids)).group_by(MediaStreamHistory.user_uuid).all()
        
        for user_uuid, plays, duration in results:
            user_id = uuid_to_user_id.get(user_uuid)
            if user_id:
                stats_results[user_id] = {'play_count': plays, 'total_duration': duration or 0}
    
    return stats_results

def get_bulk_last_known_ips(user_ids: list) -> dict:
    """
    Efficiently gets the most recent IP address for a list of user IDs.
    Returns a dictionary mapping user_id to the last known IP address.
    Supports both local users and service users.
    """
    if not user_ids:
        return {}

    # Convert user IDs to UUIDs for the query, separating by user type
    from app.utils.helpers import get_user_by_uuid
    app_access_uuids = []
    media_access_uuids = []
    uuid_to_user_id = {}
    
    for user_id in user_ids:
        try:
            user_obj, user_type = get_user_by_uuid(str(user_id))
            if user_obj and user_type == "user_app_access":
                app_access_uuids.append(user_obj.uuid)
                uuid_to_user_id[user_obj.uuid] = user_id
            elif user_obj and user_type == "user_media_access":
                media_access_uuids.append(user_obj.uuid)
                uuid_to_user_id[user_obj.uuid] = user_id
        except Exception:
            continue  # Skip invalid IDs
    
    user_id_to_ip = {}
    
    # Handle all users using unified user_uuid field
    all_user_uuids = app_access_uuids + media_access_uuids
    if all_user_uuids:
        subquery = db.session.query(
            MediaStreamHistory.user_uuid,
            MediaStreamHistory.ip_address,
            func.row_number().over(
                partition_by=MediaStreamHistory.user_uuid,
                order_by=MediaStreamHistory.started_at.desc()
            ).label('rn')
        ).filter(MediaStreamHistory.user_uuid.in_(all_user_uuids)).filter(MediaStreamHistory.ip_address.isnot(None)).subquery()

        results = db.session.query(subquery.c.user_uuid, subquery.c.ip_address).filter(subquery.c.rn == 1).all()
        
        for result_uuid, ip_address in results:
            user_id = uuid_to_user_id.get(result_uuid)
            if user_id:
                user_id_to_ip[user_id] = ip_address
    
    return user_id_to_ip

def mass_extend_access(user_uuids: list, days_to_extend: int, admin_id: int = None):
    """Mass extend access for service users"""
    from app.utils.helpers import get_user_by_uuid
    from datetime import datetime, timedelta
    processed_count = 0
    error_count = 0
    
    for uuid_str in user_uuids:
        try:
            user_obj, user_type = get_user_by_uuid(uuid_str)
            if user_obj and user_type == "user_media_access":
                if user_obj.access_expires_at:
                    user_obj.access_expires_at += timedelta(days=days_to_extend)
                else:
                    user_obj.access_expires_at = datetime.utcnow() + timedelta(days=days_to_extend)
                processed_count += 1
            else:
                error_count += 1
        except Exception as e:
            error_count += 1
            current_app.logger.error(f"Error extending access for service user {uuid_str}: {e}")
    
    if processed_count > 0: 
        db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Mass extended access for {processed_count} service users by {days_to_extend} days.", admin_id=admin_id, details={"count": processed_count, "days": days_to_extend})
    return processed_count, error_count

def mass_set_expiration(user_uuids: list, new_expiration_date, admin_id: int = None):
    """Mass set expiration date for service users"""
    from app.utils.helpers import get_user_by_uuid
    processed_count = 0
    error_count = 0
    
    for uuid_str in user_uuids:
        try:
            user_obj, user_type = get_user_by_uuid(uuid_str)
            if user_obj and user_type == "user_media_access":
                user_obj.access_expires_at = new_expiration_date
                processed_count += 1
            else:
                error_count += 1
        except Exception as e:
            error_count += 1
            current_app.logger.error(f"Error setting expiration for service user {uuid_str}: {e}")
    
    if processed_count > 0: 
        db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Mass set expiration for {processed_count} service users to {new_expiration_date}.", admin_id=admin_id, details={"count": processed_count, "expiration_date": str(new_expiration_date)})
    return processed_count, error_count

def mass_clear_expiration(user_uuids: list, admin_id: int = None):
    """Mass clear expiration date for service users"""
    from app.utils.helpers import get_user_by_uuid
    processed_count = 0
    error_count = 0
    
    for uuid_str in user_uuids:
        try:
            user_obj, user_type = get_user_by_uuid(uuid_str)
            if user_obj and user_type == "user_media_access":
                user_obj.access_expires_at = None
                processed_count += 1
            else:
                error_count += 1
        except Exception as e:
            error_count += 1
            current_app.logger.error(f"Error clearing expiration for service user {uuid_str}: {e}")
    
    if processed_count > 0: 
        db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Mass cleared expiration for {processed_count} service users.", admin_id=admin_id, details={"count": processed_count})
    return processed_count, error_count

def merge_service_users_into_local_account(user_uuids: list, username: str, password: str, admin_id: int = None):
    """
    Merge multiple service users into a new local account.
    Creates a new local user record and links the service users to it.
    """
    from app.utils.helpers import get_user_by_uuid
    from werkzeug.security import generate_password_hash
    
    processed_count = 0
    error_count = 0
    local_user_id = None
    
    try:
        # Validate that all provided UUIDs are service users
        service_users = []
        already_linked_users = []
        invalid_users = []
        
        for uuid_str in user_uuids:
            try:
                user_obj, user_type = get_user_by_uuid(uuid_str)
                if user_obj and user_type == "user_media_access":
                    # Check if this service user is already linked to a local account
                    if user_obj.linkedUserId:
                        # Get the linked local account info for better error message
                        linked_account = User.query.filter_by(userType=UserType.LOCAL).get(user_obj.linkedUserId)
                        linked_username = linked_account.localUsername if linked_account else "Unknown"
                        already_linked_users.append(f"{user_obj.external_username or 'Unknown'} (linked to {linked_username})")
                        current_app.logger.warning(f"Service user {uuid_str} is already linked to local account {user_obj.linkedUserId}")
                        error_count += 1
                        continue
                    service_users.append(user_obj)
                else:
                    invalid_users.append(uuid_str)
                    current_app.logger.error(f"Invalid user type for merge operation: {user_type} for UUID {uuid_str}")
                    error_count += 1
            except Exception as e:
                invalid_users.append(uuid_str)
                current_app.logger.error(f"Error validating user UUID {uuid_str}: {e}")
                error_count += 1
        
        # Provide detailed error messages for different failure scenarios
        if not service_users:
            error_details = []
            if already_linked_users:
                error_details.append(f"Already linked users: {', '.join(already_linked_users)}")
            if invalid_users:
                error_details.append(f"Invalid/not found users: {len(invalid_users)} users")
            
            if already_linked_users and not invalid_users:
                raise Exception(f"All selected users are already linked to local accounts. {error_details[0]}")
            elif invalid_users and not already_linked_users:
                raise Exception(f"No valid service users selected. Only standalone service users can be merged.")
            else:
                raise Exception(f"No valid service users found for merge operation. {' | '.join(error_details)}")
        
        # If we have some valid users but also some errors, log a warning
        if already_linked_users or invalid_users:
            warning_parts = []
            if already_linked_users:
                warning_parts.append(f"{len(already_linked_users)} users already linked")
            if invalid_users:
                warning_parts.append(f"{len(invalid_users)} invalid users")
            current_app.logger.warning(f"Merge operation proceeding with {len(service_users)} valid users. Skipped: {', '.join(warning_parts)}")
        
        # Create the new local user account using unified model structure
        new_local_user = User(
            userType=UserType.LOCAL,
            localUsername=username,
            is_active=True,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        
        # Set password using the model's method
        new_local_user.set_password(password)
        
        # Set email from the first service user that has one
        for service_user in service_users:
            if service_user.external_email:
                new_local_user.discord_email = service_user.external_email
                break
        
        db.session.add(new_local_user)
        db.session.flush()  # Get the ID without committing
        local_user_id = new_local_user.id
        
        # Link all service users to the new local account
        for service_user in service_users:
            try:
                service_user.linkedUserId = new_local_user.uuid
                processed_count += 1
                current_app.logger.info(f"Linked service user {service_user.external_username} to new local account {username}")
            except Exception as e:
                current_app.logger.error(f"Error linking service user {service_user.id} to local account: {e}")
                error_count += 1
        
        # Commit all changes
        db.session.commit()
        
        # Log the event
        log_event(EventType.SETTING_CHANGE, 
                  f"Created local account '{username}' and linked {processed_count} service users",
                  admin_id=admin_id,
                  details={
                      "local_username": username,
                      "linked_service_users": processed_count,
                      "errors": error_count
                  })
        
        current_app.logger.info(f"Successfully created local account '{username}' and linked {processed_count} service users")
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error creating local account and merging service users: {e}", exc_info=True)
        error_count += len(user_uuids)  # Count all as errors if the operation fails
        processed_count = 0
        raise Exception(f"Failed to create local account: {str(e)}")
    
    return processed_count, error_count, local_user_id
    
