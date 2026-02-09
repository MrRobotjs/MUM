"""
Reusable utility functions for user library management operations.
Eliminates code duplication across route files.
"""

from flask import current_app
from app.models_media_services import MediaLibrary, MediaServer
from app.services.media_service_factory import MediaServiceFactory
from app.extensions import db
from typing import List, Dict, Tuple, Optional, Union


def get_server_library_choices(server_id: int, server_type: str = None) -> List[Tuple[str, str]]:
    """
    Get available library choices for a server, formatted for WTForms SelectMultipleField.
    
    Args:
        server_id: ID of the media server
        server_type: Optional server type to optimize queries
        
    Returns:
        List of (lib_id, lib_name) tuples for form choices
    """
    try:
        db_libraries = MediaLibrary.query.filter_by(server_id=server_id).all()
        available_libraries = {}
        
        # Get server info if not provided
        if not server_type:
            server = MediaServer.query.get(server_id)
            server_type = server.service_type.value if server else None
        
        for lib in db_libraries:
            lib_id = lib.external_id
            lib_name = lib.name
            if lib_id:
                if server_type == 'kavita':
                    # Kavita uses internal_id for simplified handling
                    internal_id = getattr(lib, 'internal_id', None)
                    if internal_id:
                        available_libraries[str(internal_id)] = lib_name
                    else:
                        # Fallback to external_id if internal_id not available
                        current_app.logger.warning(f"Kavita library {lib_name} missing internal_id, using external_id")
                        available_libraries[str(lib_id)] = lib_name
                else:
                    available_libraries[str(lib_id)] = lib_name
        
        return [(lib_id, name) for lib_id, name in available_libraries.items()]
        
    except Exception as e:
        current_app.logger.error(f"Error getting library choices for server {server_id}: {e}")
        return []


def get_multi_server_library_choices(server_ids: List[int], include_server_prefix: bool = True) -> List[Tuple[str, str]]:
    """
    Get library choices from multiple servers, with optional server name prefixes.
    
    Args:
        server_ids: List of server IDs to get libraries from
        include_server_prefix: Whether to prefix library names with server names
        
    Returns:
        List of (unique_lib_id, display_name) tuples for form choices
    """
    try:
        all_choices = []
        seen_ids = set()
        
        for server_id in server_ids:
            server = MediaServer.query.get(server_id)
            if not server:
                continue
                
            db_libraries = MediaLibrary.query.filter_by(server_id=server_id).all()
            
            for lib in db_libraries:
                lib_id = lib.external_id
                lib_name = lib.name
                
                if not lib_id:
                    continue
                
                # Create unique ID that includes server info
                if server.service_type.value == 'kavita':
                    # Kavita uses internal_id for simplified handling
                    internal_id = getattr(lib, 'internal_id', None)
                    if internal_id:
                        unique_lib_id = f"{server_id}_{internal_id}"
                    else:
                        # Fallback to external_id if internal_id not available
                        current_app.logger.warning(f"Kavita library {lib_name} missing internal_id, using external_id")
                        unique_lib_id = f"{server_id}_{lib_id}"
                else:
                    unique_lib_id = f"{server_id}_{lib_id}"
                
                # Avoid duplicates
                if unique_lib_id in seen_ids:
                    continue
                seen_ids.add(unique_lib_id)
                
                # Format display name
                if include_server_prefix:
                    display_name = f"[{server.server_nickname}] {lib_name}"
                else:
                    display_name = lib_name
                
                all_choices.append((unique_lib_id, display_name))
        
        return sorted(all_choices, key=lambda x: x[1])  # Sort by display name
        
    except Exception as e:
        current_app.logger.error(f"Error getting multi-server library choices: {e}")
        return []


def setup_form_library_choices(form, server_id: int = None, server_ids: List[int] = None, 
                              include_server_prefix: bool = False) -> bool:
    """
    Set up library choices for a form's libraries field.
    
    Args:
        form: WTForm with a libraries SelectMultipleField
        server_id: Single server ID (mutually exclusive with server_ids)
        server_ids: Multiple server IDs (mutually exclusive with server_id)
        include_server_prefix: Whether to prefix library names with server names
        
    Returns:
        True if successful, False if failed
    """
    try:
        if server_id and server_ids:
            raise ValueError("Cannot specify both server_id and server_ids")
        
        if server_id:
            form.libraries.choices = get_server_library_choices(server_id)
        elif server_ids:
            form.libraries.choices = get_multi_server_library_choices(server_ids, include_server_prefix)
        else:
            form.libraries.choices = []
            
        return True
        
    except Exception as e:
        current_app.logger.error(f"Error setting up form library choices: {e}")
        form.libraries.choices = []
        return False


def update_user_library_access(user, new_library_ids: List[str], sync_to_server: bool = True) -> Tuple[bool, str]:
    """
    Update a user's library access and optionally sync to the media server.
    
    Args:
        user: User object (service user with server relationship)
        new_library_ids: List of library IDs to grant access to
        sync_to_server: Whether to sync changes to the actual media server
        
    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        # Check if libraries actually changed
        current_libs = set(user.allowed_library_ids or [])
        new_libs = set(new_library_ids)
        
        if current_libs == new_libs:
            return True, "No changes to library access"
        
        # Update database
        user.allowed_library_ids = new_library_ids
        
        # Sync to server if requested
        if sync_to_server and hasattr(user, 'server') and user.external_user_id:
            success, sync_message = sync_user_libraries_to_server(user, new_library_ids)
            if not success:
                current_app.logger.warning(f"Database updated but server sync failed: {sync_message}")
                return True, f"Updated in database but server sync failed: {sync_message}"
        
        return True, "Library access updated successfully"
        
    except Exception as e:
        current_app.logger.error(f"Error updating user library access: {e}")
        return False, f"Failed to update library access: {str(e)}"


def sync_user_libraries_to_server(user, library_ids: List[str]) -> Tuple[bool, str]:
    """
    Sync user library access to the actual media server.
    
    Args:
        user: Service user object with server relationship
        library_ids: List of library IDs to sync (internal UUIDs for Kavita, external IDs for others)
        
    Returns:
        Tuple of (success: bool, message: str)
    """
    try:
        if not hasattr(user, 'server') or not user.server:
            return False, "User has no associated server"
            
        if not user.external_user_id:
            return False, "User has no external_user_id for server sync"
        
        # Create service instance
        service = MediaServiceFactory.create_service_from_db(user.server)
        if not service:
            return False, f"Could not create service for {user.server.service_type.value} server"
            
        if not hasattr(service, 'update_user_access'):
            return False, f"Server type {user.server.service_type.value} does not support user access updates"
        
        # Convert library IDs for server sync
        server_library_ids = library_ids
        
        # For Kavita, convert internal UUIDs back to external IDs for API calls
        if user.server.service_type.value == 'kavita':
            server_library_ids = convert_internal_ids_to_external_for_kavita(user.server, library_ids)
            current_app.logger.info(
                f"Converted Kavita library IDs for server sync: {library_ids} -> {server_library_ids}"
            )
        
        # Sync to server
        service.update_user_access(user.external_user_id, server_library_ids)
        
        current_app.logger.info(
            f"Successfully synced library changes to {user.server.service_type.value} "
            f"server for user {user.external_username}"
        )
        
        return True, f"Successfully synced to {user.server.service_type.value} server"
        
    except Exception as e:
        error_msg = f"Failed to sync library changes to server: {str(e)}"
        current_app.logger.error(error_msg)
        return False, error_msg


def bulk_update_user_library_access(users: List, new_library_ids: List[str], 
                                   sync_to_server: bool = True) -> Dict[str, Tuple[bool, str]]:
    """
    Update library access for multiple users and optionally sync to servers.
    
    Args:
        users: List of user objects to update
        new_library_ids: List of library IDs to grant access to
        sync_to_server: Whether to sync changes to actual media servers
        
    Returns:
        Dict mapping user identifiers to (success: bool, message: str) tuples
    """
    results = {}
    
    for user in users:
        user_id = getattr(user, 'uuid', getattr(user, 'id', str(user)))
        success, message = update_user_library_access(user, new_library_ids, sync_to_server)
        results[str(user_id)] = (success, message)
    
    return results


def match_stored_library_ids_to_choices(stored_ids: List[str], available_choices: List[Tuple[str, str]], 
                                       server_type: str = None) -> List[str]:
    """
    Match stored library IDs to available form choices, handling format differences.
    
    Args:
        stored_ids: List of library IDs as stored in database
        available_choices: List of (lib_id, lib_name) tuples from form choices
        server_type: Optional server type for specialized matching logic
        
    Returns:
        List of library IDs that match the available choices
    """
    if not stored_ids:
        return []
        
    # Handle special case for Jellyfin users with '*' (all libraries access)
    if stored_ids == ['*']:
        return [choice[0] for choice in available_choices]
    
    available_lib_ids = {choice[0] for choice in available_choices}
    matched_libraries = []
    
    for lib_id in stored_ids:
        lib_id_str = str(lib_id)
        
        # Direct match first
        if lib_id_str in available_lib_ids:
            matched_libraries.append(lib_id_str)
            continue
        
        
        # For other cases, try simple numeric matching
        for avail_lib_id, _ in available_choices:
            if avail_lib_id == lib_id_str:
                matched_libraries.append(avail_lib_id)
                break
    
    return matched_libraries


def build_libraries_lookup_for_templates(servers: List) -> Tuple[Dict, Dict]:
    """
    Build comprehensive library lookup dictionaries for template rendering.
    
    This function creates the complex mapping structures needed for invite display templates
    where libraries need to be shown with server context and proper ID handling.
    
    Args:
        servers: List of MediaServer objects to build lookups for
        
    Returns:
        Tuple of (libraries_by_server: Dict, all_libraries_lookup: Dict)
        - libraries_by_server: {server_id: {external_id: lib_data}}
        - all_libraries_lookup: {lib_id_or_prefixed: lib_data}
    """
    from flask import current_app
    from app.models_media_services import MediaLibrary
    
    libraries_by_server = {}
    all_libraries_lookup = {}
    
    for server in servers:
        try:
            # Load libraries from database for each server
            db_libraries = MediaLibrary.query.filter_by(server_id=server.id).all()
            server_libraries = {}
            
            for lib in db_libraries:
                lib_data = {
                    'id': lib.id,
                    'external_id': lib.external_id,
                    'name': lib.name,
                    'server_id': server.id,
                    'server_name': server.server_nickname,
                    'service_type': server.service_type.value
                }
                server_libraries[lib.external_id] = lib_data
                
                # Store in global lookup - use appropriate ID format for each service
                if server.service_type.name.upper() == 'KAVITA':
                    # Use internal_id for Kavita for simplified handling
                    internal_id = getattr(lib, 'internal_id', None)
                    if internal_id:
                        all_libraries_lookup[str(internal_id)] = lib_data
                    else:
                        current_app.logger.error(f"Kavita library {lib_data['name']} missing internal_id")
                        # Skip this library if no internal_id available
                        continue
                else:
                    # For other services (including AudioBookshelf), use external_id as unique identifier
                    all_libraries_lookup[lib.external_id] = lib_data
                    
                    # For AudioBookshelf, also add a prefixed version for backward compatibility
                    if server.service_type.name.upper() == 'AUDIOBOOKSHELF':
                        prefixed_id = f"[{server.service_type.name.upper()}]-{server.server_nickname}-{lib.external_id}"
                        all_libraries_lookup[prefixed_id] = lib_data
            
            libraries_by_server[server.id] = server_libraries
            current_app.logger.debug(f"Loaded {len(server_libraries)} libraries for server {server.server_nickname}")
            
        except Exception as e:
            current_app.logger.error(f"Failed to load libraries for server {server.server_nickname}: {e}")
            libraries_by_server[server.id] = {}
    
    return libraries_by_server, all_libraries_lookup


def convert_internal_ids_to_external_for_kavita(server, internal_ids: List[str]) -> List[str]:
    """
    Convert Kavita internal UUIDs back to external IDs for server API calls.
    
    This is the reverse of MediaServiceManager._convert_library_ids_for_kavita().
    When syncing changes back to Kavita, we need to convert the stored UUIDs 
    back to the external IDs that Kavita expects.
    
    Args:
        server: MediaServer object 
        internal_ids: List of internal UUID strings
        
    Returns:
        List of external ID strings that Kavita API expects
    """
    if server.service_type.value != 'kavita':
        return internal_ids
    
    external_ids = []
    
    for internal_id in internal_ids:
        if str(internal_id).startswith("kavita-name:"):
            current_app.logger.warning(
                "Skipping Kavita placeholder library id during sync: %s",
                internal_id,
            )
            continue
        # Find the library by internal_id to get its external_id
        library = MediaLibrary.query.filter_by(
            server_id=server.id,
            internal_id=str(internal_id)
        ).first()
        
        if library and library.external_id:
            external_ids.append(str(library.external_id))
            current_app.logger.debug(f"Converted Kavita UUID {internal_id} -> external_id {library.external_id}")
        else:
            current_app.logger.warning(f"Could not find library with internal_id '{internal_id}' on server {server.server_nickname}")
            # Fallback: try treating as external_id already (backwards compatibility)
            external_ids.append(str(internal_id))
    
    return external_ids
