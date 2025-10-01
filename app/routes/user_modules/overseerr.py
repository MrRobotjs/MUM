# File: app/routes/user_modules/overseerr.py
"""Overseerr integration and requests functionality"""

from flask import render_template, current_app
from flask_login import login_required, current_user
from app.models import User
from app.models_media_services import MediaServer
from . import user_bp
import urllib.parse


@user_bp.route('/overseerr-requests/<int:server_id>')
@user_bp.route('/overseerr-requests/<int:server_id>/<server_nickname>/<server_username>')
@login_required
def get_overseerr_requests(server_id, server_nickname=None, server_username=None):
    """Get Overseerr requests for the current user"""
    current_app.logger.info(f"OVERSEERR DEBUG: Route called with server_id={server_id} (type: {type(server_id)}), server_nickname={server_nickname}, server_username={server_username}")
    try:
        from app.services.overseerr_service import OverseerrService
        from app.models_media_services import MediaServer
        from flask import render_template
        
        # Get the server
        server = MediaServer.query.get_or_404(server_id)
        
        # Check if server has Overseerr enabled
        if not server.overseerr_enabled or not server.overseerr_url or not server.overseerr_api_key:
            return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                 error_type='api_error',
                                 message='Overseerr is not properly configured for this server.')
        
        # Get the current user's Plex ID and details
        plex_user_id = None
        plex_username = None
        plex_email = None
        
        # Debug: Log initial request context
        current_app.logger.info(f"OVERSEERR DEBUG: Starting get_overseerr_requests for server_id={server_id}")
        current_app.logger.info(f"OVERSEERR DEBUG: Route parameters - server_nickname={server_nickname}, server_username={server_username}")
        
        if server_nickname and server_username:
            # This is a service account view - find the UserMediaAccess record
            from urllib.parse import unquote
            server_nickname = unquote(server_nickname)
            server_username = unquote(server_username)
            
            current_app.logger.info(f"OVERSEERR DEBUG: After unquote - server_nickname={server_nickname}, server_username={server_username}")
            
            # Find the UserMediaAccess record for this service user
            media_access = User.query.filter_by(userType=UserType.SERVICE).join(MediaServer).filter(
                MediaServer.server_nickname == server_nickname,
                User.external_username == server_username,
                User.server_id == server_id
            ).first()
            
            current_app.logger.info(f"OVERSEERR DEBUG: Found media_access: {media_access}")
            
            if media_access:
                plex_user_id = media_access.external_user_id
                plex_username = media_access.external_username
                plex_email = media_access.external_email
                current_app.logger.info(f"OVERSEERR DEBUG: Media access data - plex_user_id={plex_user_id}, plex_username={plex_username}, plex_email={plex_email}")
            else:
                current_app.logger.warning(f"OVERSEERR DEBUG: No media_access found for server_nickname={server_nickname}, server_username={server_username}, server_id={server_id}")
        else:
            current_app.logger.info(f"OVERSEERR DEBUG: No server_nickname/server_username in route, checking current_user media_accesses")
            
            # Check if current_user has media_accesses attribute (not Owner)
            if hasattr(current_user, 'media_accesses'):
                current_app.logger.info(f"OVERSEERR DEBUG: current_user has media_accesses, checking {len(current_user.media_accesses)} records")
                for i, media_access in enumerate(current_user.media_accesses):
                    current_app.logger.info(f"OVERSEERR DEBUG:   Access {i+1}: server_id={media_access.server_id}, service_type={media_access.server.service_type.value}")
                    if media_access.server_id == server_id and media_access.server.service_type.value == 'plex':
                        plex_user_id = media_access.external_user_id
                        plex_username = media_access.external_username
                        plex_email = media_access.external_email
                        current_app.logger.info(f"OVERSEERR DEBUG: Found matching Plex access - plex_user_id={plex_user_id}, plex_username={plex_username}")
                        break
            else:
                current_app.logger.info(f"OVERSEERR DEBUG: current_user does not have media_accesses attribute (type: {type(current_user)})")
        
        current_app.logger.info(f"OVERSEERR DEBUG: Final values - plex_user_id={plex_user_id}, plex_username={plex_username}, plex_email={plex_email}")
        
        if not plex_user_id or not plex_username:
            current_app.logger.warning(f"OVERSEERR DEBUG: Missing required data - plex_user_id={plex_user_id}, plex_username={plex_username}")
            return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                 error_type='no_plex_account',
                                 debug_info={'plex_user_id': plex_user_id, 'plex_username': plex_username})
        
        # Try to get the Overseerr user ID from user media access
        overseerr_user_id = User.get_overseerr_user_id(server_id, plex_user_id)
        current_app.logger.info(f"OVERSEERR DEBUG: Existing link check - overseerr_user_id={overseerr_user_id}")
        
        # If not linked, attempt lazy linking
        if not overseerr_user_id:
            current_app.logger.info(f"OVERSEERR DEBUG: No existing link found, attempting lazy link for Plex user {plex_username} (ID: {plex_user_id}) on server {server_id}")
            
            link_success, linked_overseerr_user_id, link_message = User.link_single_user(
                server_id, plex_user_id, plex_username, plex_email
            )
            
            current_app.logger.info(f"OVERSEERR DEBUG: Lazy link result - success={link_success}, overseerr_user_id={linked_overseerr_user_id}, message='{link_message}'")
            
            if link_success:
                overseerr_user_id = linked_overseerr_user_id
                current_app.logger.info(f"OVERSEERR DEBUG: Successfully linked user {plex_username} - {link_message}")
            else:
                current_app.logger.info(f"OVERSEERR DEBUG: Failed to link user {plex_username} - {link_message}")
                
                # Show appropriate error message based on failure reason
                if "User not found in Overseerr" in link_message or "No Overseerr user found" in link_message:
                    return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                         error_type='user_not_found',
                                         server=server,
                                         debug_info={'plex_user_id': plex_user_id, 'plex_username': plex_username})
                else:
                    return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                         error_type='linking_error', 
                                         message=link_message,
                                         debug_info={'plex_user_id': plex_user_id, 'plex_username': plex_username})
        
        # Get requests from Overseerr with pagination
        overseerr = OverseerrService(server.overseerr_url, server.overseerr_api_key)
        
        # Get pagination parameters from request
        from flask import request as flask_request
        page = int(flask_request.args.get('page', 1))
        per_page = int(flask_request.args.get('per_page', 20))
        skip = (page - 1) * per_page
        
        current_app.logger.info(f"OVERSEERR DEBUG: Requesting page {page}, per_page {per_page}, skip {skip}")
        
        success, requests_list, pagination_info, message = overseerr.get_user_requests(overseerr_user_id, take=per_page, skip=skip)
        
        current_app.logger.info(f"OVERSEERR DEBUG: API returned {len(requests_list) if success else 0} requests, pagination: {pagination_info}")
        
        if not success:
            return render_template('user/_partials/profile_tabs/overseerr_error.html', 
                                 error_type='api_error',
                                 message=message)
        
        # Debug: Log template context
        current_app.logger.info(f"OVERSEERR DEBUG: Rendering template with server_id={server_id} (type: {type(server_id)}), requests_count={len(requests_list) if requests_list else 0}")
        current_app.logger.info(f"OVERSEERR DEBUG: Server object: {server.id if server else 'None'} - {server.server_nickname if server else 'None'}")
        
        # Render requests list with pagination using template
        return render_template('user/_partials/profile_tabs/overseerr_requests.html',
                             requests=requests_list, 
                             pagination=pagination_info, 
                             server=server,
                             server_id=server_id,
                             request=flask_request)
        
    except Exception as e:
        current_app.logger.error(f"Error in get_overseerr_requests: {e}")
        return render_template('user/_partials/profile_tabs/overseerr_error.html',
                             error_type='unexpected_error',
                             message=str(e))



@user_bp.route('/overseerr-request-update', methods=['POST'])
@login_required
def update_request_status():
    """Update the status of an Overseerr request (approve/decline)"""
    current_app.logger.info("UPDATE REQUEST STATUS ROUTE HIT!")
    try:
        from app.services.overseerr_service import OverseerrService
        from app.models_media_services import MediaServer
        from flask import jsonify, request as flask_request
        
        # Get parameters from request JSON
        data = flask_request.get_json()
        server_id = data.get('server_id')
        request_id = data.get('request_id')
        status = data.get('status')
        
        current_app.logger.info(f"UPDATE REQUEST STATUS ROUTE CALLED: server_id={server_id}, request_id={request_id}, status={status}")
        
        # Validate parameters
        if not all([server_id, request_id, status]):
            current_app.logger.error(f"Missing parameters: server_id={server_id}, request_id={request_id}, status={status}")
            return jsonify({'success': False, 'message': 'Missing required parameters'}), 400
        
        # Validate status parameter
        if status not in ['approve', 'decline']:
            current_app.logger.error(f"Invalid status parameter: {status}")
            return jsonify({'success': False, 'message': 'Invalid status parameter'}), 400
        
        # Get the server
        current_app.logger.info(f"Getting server with ID: {server_id}")
        server = MediaServer.query.get_or_404(server_id)
        current_app.logger.info(f"Server found: {server.server_nickname if server else 'None'}")
        
        # Check if server has Overseerr enabled
        if not server.overseerr_enabled or not server.overseerr_url or not server.overseerr_api_key:
            current_app.logger.error(f"Overseerr not properly configured for server {server_id}")
            return jsonify({'success': False, 'message': 'Overseerr is not properly configured for this server'}), 400
        
        # Initialize Overseerr service
        overseerr = OverseerrService(server.overseerr_url, server.overseerr_api_key)
        
        # Update request status via API
        success, message = overseerr.update_request_status(request_id, status)
        
        if success:
            return jsonify({'success': True, 'message': f'Request {status}d successfully'})
        else:
            return jsonify({'success': False, 'message': message}), 400
            
    except Exception as e:
        current_app.logger.error(f"Error updating request status: {e}")
        current_app.logger.error(f"Exception type: {type(e)}")
        current_app.logger.error(f"Exception args: {e.args}")
        import traceback
        current_app.logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'success': False, 'message': f'An unexpected error occurred: {str(e)}'}), 500


@user_bp.route('/overseerr-request-delete', methods=['DELETE'])
@login_required
def delete_request():
    """Delete an Overseerr request"""
    try:
        from app.services.overseerr_service import OverseerrService
        from app.models_media_services import MediaServer
        from flask import jsonify, request as flask_request
        
        # Get parameters from request JSON
        data = flask_request.get_json()
        server_id = data.get('server_id')
        request_id = data.get('request_id')
        
        current_app.logger.info(f"DELETE REQUEST ROUTE CALLED: server_id={server_id}, request_id={request_id}")
        
        # Validate parameters
        if not all([server_id, request_id]):
            current_app.logger.error(f"Missing parameters: server_id={server_id}, request_id={request_id}")
            return jsonify({'success': False, 'message': 'Missing required parameters'}), 400
        
        # Get the server
        server = MediaServer.query.get_or_404(server_id)
        
        # Check if server has Overseerr enabled
        if not server.overseerr_enabled or not server.overseerr_url or not server.overseerr_api_key:
            return jsonify({'success': False, 'message': 'Overseerr is not properly configured for this server'}), 400
        
        # Initialize Overseerr service
        overseerr = OverseerrService(server.overseerr_url, server.overseerr_api_key)
        
        # Delete request via API
        success, message = overseerr.delete_request(request_id)
        
        if success:
            return jsonify({'success': True, 'message': 'Request deleted successfully'})
        else:
            return jsonify({'success': False, 'message': message}), 400
            
    except Exception as e:
        current_app.logger.error(f"Error deleting request: {e}")
        return jsonify({'success': False, 'message': 'An unexpected error occurred'}), 500