"""DEPRECATED: Legacy SSR users module delete routes (replaced by React SPA)."""
"""User deletion functionality"""

from flask import render_template, request, current_app, make_response
from flask_login import login_required, current_user
from app.models import User, UserType
from app.extensions import db
from app.utils.helpers import setup_required, permission_required
from app.services.unified_user_service import UnifiedUserService
from . import users_bp
import json


@users_bp.route('/delete-local/<uuid:user_uuid>/accounts', methods=['GET'])
@login_required
@setup_required
@permission_required('delete_user')
def get_linked_accounts_list(user_uuid):
    """Get the linked accounts list for the deletion modal"""
    # Get user by uuid
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_uuid))
    
    if not user_obj or user_type != "user_app_access":
        return '<div class="text-center p-4 text-error">Local user not found.</div>'
    
    user = User.query.filter_by(userType=UserType.LOCAL).get(user_obj.id)
    if not user:
        return '<div class="text-center p-4 text-error">Local user not found.</div>'
    
    # Get linked service accounts
    linked_accounts = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=user.uuid).all()
    
    if not linked_accounts:
        return '<div class="text-center p-4 text-base-content/60">No linked service accounts found.</div>'
    
    # Render the accounts list
    html = '<div class="space-y-2 max-h-32 overflow-y-auto">'
    for access in linked_accounts:
        service_type = access.server.service_type.value
        
        # Service badge HTML
        if service_type == 'plex':
            badge = '''<span class="inline-flex items-center rounded-md bg-plex-50 dark:bg-plex-400/10 px-2 py-1 text-xs font-medium text-plex-700 dark:text-plex-400 ring-1 ring-inset ring-plex-600/20 dark:ring-plex-500/20 gap-1">
                <svg class="w-3 h-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/></svg>
                Plex
            </span>'''
        elif service_type == 'jellyfin':
            badge = '''<span class="inline-flex items-center rounded-md bg-jellyfin-50 dark:bg-jellyfin-400/10 px-2 py-1 text-xs font-medium text-jellyfin-700 dark:text-jellyfin-400 ring-1 ring-inset ring-jellyfin-600/20 dark:ring-jellyfin-500/20 gap-1">
                <i class="fa-solid fa-cube w-3 h-3"></i>
                Jellyfin
            </span>'''
        elif service_type == 'emby':
            badge = '''<span class="inline-flex items-center rounded-md bg-emby-50 dark:bg-emby-400/10 px-2 py-1 text-xs font-medium text-emby-700 dark:text-emby-400 ring-1 ring-inset ring-emby-600/20 dark:ring-emby-500/20 gap-1">
                <i class="fa-solid fa-play-circle w-3 h-3"></i>
                Emby
            </span>'''
        else:
            badge = f'''<span class="inline-flex items-center rounded-md bg-gray-50 dark:bg-gray-400/10 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-400 ring-1 ring-inset ring-gray-600/20 dark:ring-gray-500/20 gap-1">
                <i class="fa-solid fa-server w-3 h-3"></i>
                {service_type.title()}
            </span>'''
        
        html += f'''
        <div class="flex items-center gap-3 p-3 bg-base-100 rounded-lg border border-base-300/50">
            {badge}
            <div class="flex-1 min-w-0">
                <div class="font-medium text-sm text-base-content truncate">{access.external_username or "Unknown"}</div>
                <div class="text-xs text-base-content/60">{access.server.server_nickname}</div>
            </div>
        </div>
        '''
    
    html += '</div>'
    return html


@users_bp.route('/delete-local/<uuid:user_uuid>', methods=['DELETE'])
@login_required
@setup_required
@permission_required('delete_user')
def delete_local_user(user_uuid):
    """Delete a local user with options for handling linked accounts"""
    # Get user by uuid
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_uuid))
    
    if not user_obj or user_type != "user_app_access":
        return make_response("Local user not found", 404)
    
    user = User.query.filter_by(userType=UserType.LOCAL, id=user_obj.id).first()
    if not user:
        return make_response("Local user not found", 404)
    
    # Get deletion type from request
    try:
        data = request.get_json()
        deletion_type = data.get('deletion_type', 'unlink_only')
    except:
        deletion_type = 'unlink_only'  # Default to safer option
    
    username = user.localUsername
    
    try:
        # Get linked service accounts before deletion
        linked_accounts = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=user.uuid).all()
        linked_count = len(linked_accounts)
        
        if deletion_type == 'delete_all':
            # Delete from all services AND delete local user
            current_app.logger.info(f"Deleting local user '{username}' and all {linked_count} linked service accounts")
            UnifiedUserService.delete_user_completely(user.id, admin_id=current_user.id)
            message = f"Local user '{username}' and all {linked_count} linked service accounts have been deleted."
        else:
            # Unlink only - convert service accounts to standalone
            current_app.logger.info(f"Deleting local user '{username}' and converting {linked_count} service accounts to standalone")
            
            # Unlink all service accounts (convert to standalone)
            for access in linked_accounts:
                access.linkedUserId = None
                current_app.logger.debug(f"Unlinked service account: {access.external_username} on {access.server.server_nickname}")
            
            # Delete the local user
            db.session.delete(user)
            db.session.commit()
            
            # Log the event
            
            message = f"Local user '{username}' deleted. {linked_count} service accounts converted to standalone users."
        
        return make_response(message, 200)
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error deleting local user '{username}': {e}", exc_info=True)
        return make_response(f"Error deleting user: {str(e)}", 500)


@users_bp.route('/delete/<uuid:user_uuid>', methods=['DELETE'])
@login_required
@setup_required
@permission_required('delete_user')
def delete_user(user_uuid):
    """Delete a user (local or service)"""
    # Get user by uuid
    from app.utils.helpers import get_user_by_uuid
    user_obj, user_type = get_user_by_uuid(str(user_uuid))
    
    if not user_obj:
        current_app.logger.error(f"User not found with uuid: {user_uuid}")
        toast = {
            "showToastEvent": {
                "message": f"User not found: {user_uuid}",
                "category": "error"
            }
        }
        response = make_response("", 404)
        response.headers['HX-Trigger'] = json.dumps(toast)
        return response
    
    actual_id = user_obj.id
    
    if user_type == "user_app_access":
        # This is a local UserAppAccess user
        user = User.query.filter_by(userType=UserType.LOCAL).get(actual_id)
    
        if not user:
            toast = {
                "showToastEvent": {
                    "message": f"Local user with ID {actual_id} not found.",
                    "category": "error"
                }
            }
            response = make_response("", 404)
            response.headers['HX-Trigger'] = json.dumps(toast)
            return response
        
        username = user.get_display_name()
        
        try:
            UnifiedUserService.delete_user_completely(actual_id, admin_id=current_user.id)
            
            toast = {
                "showToastEvent": {
                    "message": f"User '{username}' has been successfully removed.",
                    "category": "success"
                }
            }
            
            response = make_response("", 200)
            response.headers['HX-Trigger'] = json.dumps(toast)
            return response

        except Exception as e:
            current_app.logger.error(f"Route Error deleting user {username}: {e}", exc_info=True)
            
            toast = {
                "showToastEvent": {
                    "message": f"Error deleting user '{username}': {str(e)[:100]}",
                    "category": "error"
                }
            }
            
            response = make_response("", 500)
            response.headers['HX-Trigger'] = json.dumps(toast)
            return response
    
    elif user_type == "user_media_access":
        # This is a standalone service user
        access = User.query.filter_by(userType=UserType.SERVICE).filter(
            User.id == actual_id
        ).first()
        
        if not access:
            toast = {
                "showToastEvent": {
                    "message": f"Service user with ID {actual_id} not found.",
                    "category": "error"
                }
            }
            response = make_response("", 404)
            response.headers['HX-Trigger'] = json.dumps(toast)
            return response
            
        username = access.external_username or 'Unknown'
        
        try:
            # Delete from the actual service first
            if access.server:
                from app.services.media_service_factory import MediaServiceFactory
                try:
                    service = MediaServiceFactory.create_service_from_db(access.server)
                    if service and access.external_user_id:
                        current_app.logger.info(f"Deleting user {access.external_user_id} from {access.server.service_type.value} server: {access.server.server_nickname}")
                        delete_success = service.delete_user(access.external_user_id)
                        if delete_success:
                            current_app.logger.info(f"Successfully deleted user from {access.server.service_type.value} server")
                        else:
                            current_app.logger.warning(f"Service reported failure deleting user from {access.server.service_type.value} server")
                    else:
                        current_app.logger.warning(f"No service or external_user_id available for deletion from {access.server.service_type.value}")
                except Exception as e:
                    current_app.logger.error(f"Error deleting user from {access.server.service_type.value} server: {e}")
                    # Continue with database deletion even if service deletion fails
            
            # Delete the standalone UserMediaAccess record from database
            db.session.delete(access)
            db.session.commit()
            
            toast = {
                "showToastEvent": {
                    "message": f"Standalone user '{username}' has been successfully removed.",
                    "category": "success"
                }
            }
            
            response = make_response("", 200)
            response.headers['HX-Trigger'] = json.dumps(toast)
            return response
            
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error deleting standalone user '{username}': {e}", exc_info=True)
            
            toast = {
                "showToastEvent": {
                    "message": f"Error deleting standalone user '{username}': {str(e)[:100]}",
                    "category": "error"
                }
            }
            
            response = make_response("", 500)
            response.headers['HX-Trigger'] = json.dumps(toast)
            return response


@users_bp.route('/app/<username>/delete', methods=['DELETE'])
@login_required
@permission_required('delete_user')
def delete_app_user(username):
    """Delete an app user by username"""
    user = User.get_by_local_username(username)
    
    if not user:
        toast = {
            "showToastEvent": {
                "message": f"App user '{username}' not found.",
                "category": "error"
            }
        }
        response = make_response("", 404)
        response.headers['HX-Trigger'] = json.dumps(toast)
        return response
    
    try:
        # Delete the user
        db.session.delete(user)
        db.session.commit()
        
        # Log the event
        
        toast = {
            "showToastEvent": {
                "message": f"App user '{username}' has been successfully deleted.",
                "category": "success"
            }
        }
        
        response = make_response("", 200)
        response.headers['HX-Trigger'] = json.dumps(toast)
        return response
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error deleting app user '{username}': {e}", exc_info=True)
        
        toast = {
            "showToastEvent": {
                "message": f"Error deleting app user '{username}': {str(e)[:100]}",
                "category": "error"
            }
        }
        
        response = make_response("", 500)
        response.headers['HX-Trigger'] = json.dumps(toast)
        return response