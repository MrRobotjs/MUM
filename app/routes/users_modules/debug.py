# File: app/routes/user_modules/debug.py
"""Debug and quick edit functionality for users"""

from flask import render_template, request, current_app
from flask_login import login_required, current_user
from app.models import User, UserType
from app.utils.helpers import permission_required
from . import users_bp


@users_bp.route('/debug_info/<uuid:user_uuid>')
@login_required
def get_user_debug_info(user_uuid):
    """Get raw user data for debugging purposes - ONLY uses stored data, NO API calls"""
    # Get user by uuid
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_uuid))
    
    if not user_obj:
        current_app.logger.error(f"User not found with uuid: {user_uuid}")
        return f"<p class='text-error'>User not found: {user_uuid}</p>"
    
    actual_id = user_obj.id
    
    if user_type == "user_app_access":
        # This is a local user (unified User model with userType=LOCAL)
        user = User.query.filter_by(userType=UserType.LOCAL, id=actual_id).first()
    
        if not user:
            return f"<p class='text-error'>Local user with ID {actual_id} not found</p>"
        
        # linked_service_users queried dynamically in templates
    
    elif user_type == "user_media_access":
        # This is a standalone service user (unified User model with userType=SERVICE)
        user = User.query.filter_by(userType=UserType.SERVICE, id=actual_id).first()
        
        if not user:
            return f"<p class='text-error'>Service user with ID {actual_id} not found</p>"
        
        # Service user - linked_service_users queried dynamically in templates
        user._is_standalone = True
    
    try:
        # Enhanced debugging for raw service data
        current_app.logger.info(f"=== DEBUG INFO REQUEST FOR USER {user_uuid} ===")
        current_app.logger.info(f"Username: {user.get_display_name()}")
        
        # Check for service-specific data in User records (unified model)
        if hasattr(user, '_is_standalone') and user._is_standalone:
            # For standalone users, the service user itself contains the data
            user_accesses = [user]
        else:
            # For regular users, query by linkedUserId using user.uuid
            user_accesses = User.query.filter_by(userType=UserType.SERVICE, linkedUserId=user.uuid).all()
        
        has_service_data = False
        for access in user_accesses:
            # Check both user_raw_data and service_settings for raw data
            if access.user_raw_data or access.service_settings:
                has_service_data = True
                current_app.logger.info(f"Service data found for {access.server.service_type.value} server: {access.server.server_nickname}")
                
                if access.user_raw_data:
                    current_app.logger.info(f"User raw data type: {type(access.user_raw_data)}")
                    current_app.logger.info(f"User raw data preview: {str(access.user_raw_data)[:100]}...")
                
                if access.service_settings:
                    current_app.logger.info(f"Service settings type: {type(access.service_settings)}")
                    current_app.logger.info(f"Service settings preview: {str(access.service_settings)[:100]}...")
        
        if not has_service_data:
            current_app.logger.warning(f"No stored service data for user {user.get_display_name()} - user needs to sync")
            
        # Check which services this user belongs to
        if hasattr(user, '_is_standalone') and user._is_standalone:
            # For standalone users, use the service user itself
            user_access = [user]
        else:
            # For regular users, query by linkedUserId
            user_access = User.query.filter_by(userType=UserType.SERVICE, linkedUserId=user.uuid).all()
        current_app.logger.info(f"User has access to {len(user_access)} servers:")
        for access in user_access:
            current_app.logger.info(f"  - Server: {access.server.server_nickname} (Type: {access.server.service_type.value})")
        
        # Render the template with the user data
        return render_template('users/_partials/user_debug_info_modal.html', user=user)
        
    except Exception as e:
        current_app.logger.error(f"Error getting debug info for user {user_uuid}: {e}", exc_info=True)
        return f"<p class='text-error'>Error fetching user data: {str(e)}</p>"


