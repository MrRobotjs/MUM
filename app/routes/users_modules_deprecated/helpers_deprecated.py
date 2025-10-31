"""DEPRECATED: Legacy SSR users module helper utilities (replaced by React SPA)."""
"""Helper functions for user management"""

from app.models_media_services import MediaLibrary


def get_libraries_from_database(servers):
    """Get library data from database - NO API CALLS"""
    libraries_by_server = {}
    
    for server in servers:
        # Get libraries from database for this server
        db_libraries = MediaLibrary.query.filter_by(server_id=server.id).all()
        server_lib_dict = {}
        
        for lib in db_libraries:
            # Use external_id as the key (this matches what the API would return)
            lib_id = lib.external_id
            lib_name = lib.name
            if lib_id:
                server_lib_dict[str(lib_id)] = lib_name
        
        libraries_by_server[server.id] = server_lib_dict
    
    return libraries_by_server


def _get_local_user_avatar_url(app_user):
    """Get avatar URL for local users by checking their linked service accounts"""
    from app.models import User, UserType
    
    # Get all service users linked to this local user
    access_records = User.query.filter_by(
        userType=UserType.SERVICE,
        linkedUserId=app_user.uuid
    ).all()
    
    for access in access_records:
        # First check for external avatar URL
        if access.external_avatar_url:
            return access.external_avatar_url
        elif access.server.service_type.value.lower() == 'plex':
            # For Plex, check multiple possible locations for the thumb URL
            thumb_url = None
            
            # First try service_settings
            if access.service_settings and access.service_settings.get('thumb'):
                thumb_url = access.service_settings['thumb']
            # Then try raw_data from the user sync
            elif access.user_raw_data and access.user_raw_data.get('thumb'):
                thumb_url = access.user_raw_data['thumb']
            # Also check nested raw data structure
            elif (access.user_raw_data and 
                  access.user_raw_data.get('plex_user_obj_attrs') and 
                  access.user_raw_data['plex_user_obj_attrs'].get('thumb')):
                thumb_url = access.user_raw_data['plex_user_obj_attrs']['thumb']
            
            if thumb_url:
                # Check if it's already a full URL (plex.tv avatars) or needs proxy
                if thumb_url.startswith('https://plex.tv/') or thumb_url.startswith('http://plex.tv/'):
                    return thumb_url
                else:
                    return f"/api/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
        
        elif access.server.service_type.value.lower() == 'jellyfin':
            # For Jellyfin, use the external_user_id to get avatar
            if access.external_user_id:
                return f"/api/media/jellyfin/users/avatar?user_id={access.external_user_id}"
    
    # No avatar found
    return None


# MassEditMockUser class removed - now using unified User model directly
