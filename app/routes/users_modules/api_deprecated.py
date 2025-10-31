"""DEPRECATED: Legacy SSR users module API routes (replaced by React SPA)."""
"""API endpoints for user management"""

from flask import request, current_app
from flask_login import login_required, current_user
from app.models import User, UserType, EventType
from app.extensions import db
from app.utils.helpers import log_event, permission_required
from . import users_bp
import json


@users_bp.route('/api/available-service-users')
@login_required
@permission_required('edit_user')
def get_available_service_users():
    """Get list of service users that are not linked to any local account"""
    try:
        # Get all standalone service users (not linked to any local account)
        standalone_users = User.query.filter_by(userType=UserType.SERVICE).filter(
            User.linkedUserId.is_(None)
        ).all()
        
        users_data = []
        for user in standalone_users:
            # Get service type and icon
            service_type = user.server.service_type.value if user.server else 'unknown'
            
            # Get avatar URL using the same logic as other user displays
            avatar_url = None
            if user.external_avatar_url:
                avatar_url = user.external_avatar_url
            elif service_type == 'plex':
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
            
            elif service_type == 'jellyfin':
                # For Jellyfin, use the external_user_id to get avatar
                if user.external_user_id:
                    avatar_url = f"/api/media/jellyfin/users/avatar?user_id={user.external_user_id}"
            
            # Service badge information matching the user cards
            service_badges = {
                'plex': {
                    'class': 'bg-plex-50 dark:bg-plex-400/10 text-plex-700 dark:text-plex-400 ring-plex-600/20 dark:ring-plex-500/20',
                    'icon': '<svg class="w-3 h-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" stroke-linejoin="round" stroke-width="12"><path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/></svg>',
                    'name': 'Plex'
                },
                'jellyfin': {
                    'class': 'bg-jellyfin-50 dark:bg-jellyfin-400/10 text-jellyfin-700 dark:text-jellyfin-400 ring-jellyfin-600/20 dark:ring-jellyfin-500/20',
                    'icon': '<i class="fa-solid fa-cube w-3 h-3"></i>',
                    'name': 'Jellyfin'
                },
                'emby': {
                    'class': 'bg-emby-50 dark:bg-emby-400/10 text-emby-700 dark:text-emby-400 ring-emby-600/20 dark:ring-emby-500/20',
                    'icon': '<i class="fa-solid fa-play-circle w-3 h-3"></i>',
                    'name': 'Emby'
                },
                'kavita': {
                    'class': 'bg-kavita-50 dark:bg-kavita-400/10 text-kavita-700 dark:text-kavita-400 ring-kavita-600/20 dark:ring-kavita-500/20',
                    'icon': '<i class="fa-solid fa-book w-3 h-3"></i>',
                    'name': 'Kavita'
                },
                'audiobookshelf': {
                    'class': 'bg-audiobookshelf-50 dark:bg-audiobookshelf-400/10 text-audiobookshelf-700 dark:text-audiobookshelf-400 ring-audiobookshelf-600/20 dark:ring-audiobookshelf-500/20',
                    'icon': '<i class="fa-solid fa-headphones w-3 h-3"></i>',
                    'name': 'AudioBookshelf'
                },
                'komga': {
                    'class': 'bg-komga-50 dark:bg-komga-400/10 text-komga-700 dark:text-komga-400 ring-komga-600/20 dark:ring-komga-500/20',
                    'icon': '<i class="fa-solid fa-book-open w-3 h-3"></i>',
                    'name': 'Komga'
                },
                'romm': {
                    'class': 'bg-romm-50 dark:bg-romm-400/10 text-romm-700 dark:text-romm-400 ring-romm-600/20 dark:ring-romm-500/20',
                    'icon': '<i class="fa-solid fa-gamepad w-3 h-3"></i>',
                    'name': 'RomM'
                }
            }
            
            badge_info = service_badges.get(service_type, {
                'class': 'bg-gray-50 dark:bg-gray-400/10 text-gray-700 dark:text-gray-400 ring-gray-600/20 dark:ring-gray-500/20',
                'icon': '<i class="fa-solid fa-server w-3 h-3"></i>',
                'name': service_type.title()
            })
            
            users_data.append({
                'id': user.id,
                'username': user.external_username or 'Unknown',
                'server_name': user.server.server_nickname if user.server else 'Unknown Server',
                'service_type': service_type,
                'service_name': badge_info['name'],
                'service_class': badge_info['class'],
                'service_icon': badge_info['icon'],
                'avatar_url': avatar_url
            })
        
        return {'success': True, 'users': users_data}
    
    except Exception as e:
        current_app.logger.error(f"Error getting available service users: {e}")
        return {'success': False, 'message': str(e)}, 500


@users_bp.route('/api/link-service-user', methods=['POST'])
@login_required
@permission_required('edit_user')
def link_service_user():
    """Link a service user to a local user account"""
    try:
        data = request.get_json()
        local_user_uuid = data.get('local_user_id')
        service_user_id = data.get('service_user_id')
        
        if not local_user_uuid or not service_user_id:
            return {'success': False, 'message': 'Missing required parameters'}, 400
        
        # Get the local user
        local_user = User.query.filter_by(userType=UserType.LOCAL).filter_by(uuid=local_user_uuid).first()
        if not local_user:
            return {'success': False, 'message': 'Local user not found'}, 404
        
        # Get the service user
        service_user = User.query.filter_by(userType=UserType.SERVICE).get(service_user_id)
        if not service_user:
            return {'success': False, 'message': 'Service user not found'}, 404
        
        # Check if service user is already linked
        if service_user.linkedUserId:
            return {'success': False, 'message': 'Service user is already linked to another account'}, 400
        
        # Link the accounts
        service_user.linkedUserId = local_user.id
        db.session.commit()
        
        # Log the event
        log_event(EventType.SETTING_CHANGE, 
                  f"Service account '{service_user.external_username}' linked to local user '{local_user.localUsername}'",
                  admin_id=current_user.id)
        
        return {'success': True, 'message': 'User linked successfully'}
    
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error linking service user: {e}")
        return {'success': False, 'message': str(e)}, 500


@users_bp.route('/link-service-users-api', methods=['POST'])
@login_required
@permission_required('edit_user')
def link_service_users():
    """Link multiple service users to a local user account"""
    try:
        # Debug logging
        current_app.logger.debug(f"link_service_users: Request form: {request.form}")
        
        local_user_uuid = request.form.get('local_user_id')
        service_user_ids_str = request.form.get('service_user_ids', '')
        service_user_ids = service_user_ids_str.split(',') if service_user_ids_str else []
        
        current_app.logger.debug(f"link_service_users: local_user_uuid={local_user_uuid}, service_user_ids={service_user_ids}")
        
        if not local_user_uuid or not service_user_ids:
            current_app.logger.error(f"link_service_users: Missing parameters - local_user_uuid: {local_user_uuid}, service_user_ids: {service_user_ids}")
            return {'success': False, 'message': 'Missing required parameters'}, 400
        
        # Get the local user
        local_user = User.query.filter_by(userType=UserType.LOCAL).filter_by(uuid=local_user_uuid).first()
        if not local_user:
            return {'success': False, 'message': 'Local user not found'}, 404
        
        linked_users = []
        already_linked = []
        not_found = []
        
        for service_user_id in service_user_ids:
            # Get the service user
            service_user = User.query.filter_by(userType=UserType.SERVICE).get(service_user_id)
            if not service_user:
                not_found.append(service_user_id)
                current_app.logger.debug(f"Service user {service_user_id} not found")
                continue
            
            current_app.logger.debug(f"Service user {service_user_id}: external_username={service_user.external_username}, linkedUserId={service_user.linkedUserId}, server_id={service_user.server_id}")
            
            # Check if service user is already linked
            if service_user.linkedUserId:
                linked_to_user = User.query.filter_by(userType=UserType.LOCAL).get(service_user.linkedUserId)
                linked_to_username = linked_to_user.localUsername if linked_to_user else "Unknown User"
                current_app.logger.debug(f"Service user {service_user_id} is already linked to linkedUserId={service_user.linkedUserId} (username: {linked_to_username})")
                already_linked.append(f"{service_user.external_username or f'ID:{service_user_id}'} (linked to {linked_to_username})")
                continue
            
            current_app.logger.debug(f"Service user {service_user_id} is not linked, checking for server conflicts...")
            
            # Check if local user already has an account on this server
            existing_account = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                linkedUserId=local_user.id,
                server_id=service_user.server_id
            ).first()
            
            if existing_account:
                current_app.logger.debug(f"Server conflict: local user {local_user.id} already has account {existing_account.id} on server {service_user.server_id}")
                server_name = existing_account.server.server_nickname if existing_account.server else f"Server {service_user.server_id}"
                already_linked.append(f"{service_user.external_username or f'ID:{service_user_id}'} (user already has account '{existing_account.external_username}' on {server_name})")
                continue
            
            current_app.logger.debug(f"No conflicts found, linking service user {service_user_id} to local user {local_user.id}")
            
            # Link the account
            service_user.linkedUserId = local_user.id
            linked_users.append(service_user.external_username or f"ID:{service_user_id}")
            current_app.logger.debug(f"Successfully linked service user {service_user_id}")
        
        # Commit all changes
        db.session.commit()
        
        # Log the event
        if linked_users:
            log_event(EventType.SETTING_CHANGE, 
                      f"Service accounts {', '.join(linked_users)} linked to local user '{local_user.localUsername}'",
                      admin_id=current_user.id)
        
        # Prepare response message
        messages = []
        if linked_users:
            count = len(linked_users)
            messages.append(f"{count} user{'s' if count > 1 else ''} linked successfully")
        
        if already_linked:
            count = len(already_linked)
            messages.append(f"{count} user{'s' if count > 1 else ''} already linked")
        
        if not_found:
            count = len(not_found)
            messages.append(f"{count} user{'s' if count > 1 else ''} not found")
        
        success = len(linked_users) > 0
        message = '. '.join(messages) if messages else 'No users processed'
        
        return {'success': success, 'message': message, 'linked_count': len(linked_users)}
    
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error linking service users: {e}")
        return {'success': False, 'message': str(e)}, 500
