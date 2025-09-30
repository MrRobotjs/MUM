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
        # This is a local UserAppAccess user
        user = User.query.filter_by(userType=UserType.LOCAL, id=actual_id).first()
    
        if not user:
            return f"<p class='text-error'>Local user with ID {actual_id} not found</p>"
        
        # Get linked service users for template compatibility
        user.linked_service_users = User.query.filter_by(userType=UserType.SERVICE, linkedUserId=user.uuid).all()
    
    elif user_type == "user_media_access":
        # This is a standalone service user, get the UserMediaAccess record
        access = User.query.filter_by(userType=UserType.SERVICE).filter(
            User.id == actual_id
        ).first()
        
        if not access:
            return f"<p class='text-error'>Service user with ID {actual_id} not found</p>"
        
        # Create a mock user object for the template
        class MockUser:
            def __init__(self, access, user_id):
                self.id = user_id  # Keep the prefixed ID for display
                self.uuid = user_id  # Add uuid for template compatibility
                self.localUsername = access.external_username or 'Unknown'
                self.email = access.external_email
                self.notes = access.notes
                self.created_at = access.created_at
                self.last_login_at = access.last_activity_at
                self.media_accesses = [access]
                self.access_expires_at = access.access_expires_at
                self.discord_user_id = access.discord_user_id
                self.is_active = access.is_active
                self._is_standalone = True
                self._access_record = access
                # Add template compatibility attributes
                self.server = access.server
                self.external_username = access.external_username
                # Template expects linked_service_users for raw data display
                self.linked_service_users = [access]
            
            def get_display_name(self):
                return self._access_record.external_username or 'Unknown'
            
            def get_avatar(self, default_url=None):
                """Return avatar URL for MockUser - service users typically don't have avatars"""
                return default_url
        
        user = MockUser(access, user_uuid)
    
    try:
        # Enhanced debugging for raw service data
        current_app.logger.info(f"=== DEBUG INFO REQUEST FOR USER {user_uuid} ===")
        current_app.logger.info(f"Username: {user.get_display_name()}")
        
        # Check for service-specific data in UserMediaAccess records
        if hasattr(user, '_is_standalone') and user._is_standalone:
            # For standalone users, the access record is stored in _access_record
            user_accesses = [user._access_record]
        else:
            # For regular users, query by linkedUserId using actual_id
            user_accesses = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=actual_id).all()
        
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
            # For standalone users, use the access record we already have
            user_access = [user._access_record]
        else:
            # For regular users, query by linkedUserId
            user_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=user.uuid).all()
        current_app.logger.info(f"User has access to {len(user_access)} servers:")
        for access in user_access:
            current_app.logger.info(f"  - Server: {access.server.server_nickname} (Type: {access.server.service_type.value})")
        
        # Render the template with the user data
        return render_template('users/_partials/user_debug_info_modal.html', user=user)
        
    except Exception as e:
        current_app.logger.error(f"Error getting debug info for user {user_uuid}: {e}", exc_info=True)
        return f"<p class='text-error'>Error fetching user data: {str(e)}</p>"


