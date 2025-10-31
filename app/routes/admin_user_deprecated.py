# File: app/routes/admin_user.py
"""Admin user profile routes - for individual user viewing from /admin/users/ page"""

from flask import Blueprint, render_template, request, current_app, abort, jsonify
from flask_login import login_required, current_user
from datetime import datetime, timezone
from app.models import User, UserType
from app.models_media_services import MediaStreamHistory, ServiceType, MediaServer
from app.utils.helpers import permission_required
from app.extensions import db
from app.services.media_service_factory import MediaServiceFactory
from app.services.media_service_manager import MediaServiceManager
from app.services import user_service
from app.forms import UserEditForm
from app.routes.user_modules.helpers_deprecated import check_if_user_is_admin, enhance_history_records_with_media_ids
import urllib.parse

# Create blueprint for single user admin routes
admin_user_bp = Blueprint("admin_user", __name__)


@admin_user_bp.route('/<username>')
@login_required
@permission_required('view_user')
def view_local_user(username):
    """Admin route for viewing local user profiles"""
    # This is essentially a copy of user.view_app_user but maintains admin context
    
    # Check for potential conflicts with server nicknames
    from app.models_media_services import MediaServer
    server_conflict = MediaServer.query.filter_by(server_nickname=username).first()
    if server_conflict:
        current_app.logger.warning(f"Potential conflict: app username '{username}' matches server nickname")
    
    local_user = User.query.filter_by(userType=UserType.LOCAL).filter_by(localUsername=username).first_or_404()
    
    # Get the active tab from the URL query, default to 'profile'
    tab = request.args.get('tab', 'profile')
    
    # Handle HTMX requests for specific tabs
    if request.headers.get('HX-Request') and tab == 'history':
        # Return just the history tab content for HTMX requests
        user_service_types = {}
        user_server_names = {}
        if linked_accounts:
            service_types = []
            server_names = []
            for linked_service_user in linked_accounts:
                if linked_service_user.server and linked_service_user.server.service_type:
                    service_types.append(linked_service_user.server.service_type)
                    server_names.append(linked_service_user.server.server_nickname)
            
            if service_types:
                user_service_types[local_user.uuid] = service_types
            if server_names:
                user_server_names[local_user.uuid] = server_names
        
        return render_template('user/_partials/profile_tabs/local_history_tab.html', 
                             user=local_user, 
                             user_service_types=user_service_types,
                             user_server_names=user_server_names)
    
    # Get linked service accounts
    linked_accounts = local_user.get_linked_users()
    
    # Create context variables that the template expects (for local users)
    user_service_types = {}
    user_server_names = {}
    
    # For local users, collect service types from their linked accounts
    if linked_accounts:
        service_types = []
        server_names = []
        for linked_service_user in linked_accounts:
            if linked_service_user.server and linked_service_user.server.service_type:
                service_types.append(linked_service_user.server.service_type)
                server_names.append(linked_service_user.server.server_nickname)
        
        if service_types:
            user_service_types[local_user.uuid] = service_types
        if server_names:
            user_server_names[local_user.uuid] = server_names
    
    
    # Create a form object for the settings tab
    from app.forms import UserEditForm
    form = UserEditForm()
    
    # Get aggregated streaming history for history tab
    streaming_history = []
    
    return render_template(
        'user/index.html',
        title=f"Admin - User Profile: {local_user.get_display_name()}",
        user=local_user,
        active_tab=tab,
        is_local_user=True,
        linked_accounts=linked_accounts,
        user_service_types=user_service_types,
        user_server_names=user_server_names,
        form=form,
        streaming_history=streaming_history,
        service_filter=request.args.get('service', 'all'),
        days_filter=int(request.args.get('days', 30)),
        now_utc=datetime.now(timezone.utc),
        is_admin_context=True  # Flag to indicate admin context
    )


@admin_user_bp.route('/<server_nickname>/<server_username>', methods=['GET', 'POST'])
@login_required  
@permission_required('view_user')
def view_service_user(server_nickname, server_username):
    """Admin route for viewing service user profiles"""
    # This is essentially a copy of user.view_service_account but maintains admin context
    
    from app.models_media_services import MediaServer
    
    # URL decode the parameters to handle special characters
    try:
        server_nickname = urllib.parse.unquote(server_nickname)
        server_username = urllib.parse.unquote(server_username)
    except Exception as e:
        current_app.logger.warning(f"Error decoding URL parameters: {e}")
        abort(400)
    
    # Validate parameters
    if not server_nickname or not server_username:
        abort(400)
    
    # Check for potential username conflicts with app users
    user_conflict = User.get_by_local_username(server_nickname)
    if user_conflict:
        current_app.logger.warning(f"Potential conflict: server nickname '{server_nickname}' matches app user username")
    
    # Find the server by nickname (name)
    server = MediaServer.query.filter_by(server_nickname=server_nickname).first_or_404()
    
    # Find the service user by server and username
    service_user = User.query.filter_by(userType=UserType.SERVICE).filter_by(
        server_id=server.id,
        external_username=server_username
    ).first()

    if not service_user:
        current_app.logger.warning(f"Service user not found: {server_username} on {server_nickname}")
        abort(404)

    # Use the actual service User object directly (unified model)
    user = service_user
    user._user_type = 'service'
    user._is_service_user = True
    
    # Set display attributes for service users
    user.localUsername = user.external_username
    user.last_login_at = user.last_activity_at
    
    # Process avatar URL using the same logic as the previous service user implementation
    def _get_service_user_avatar_url(service_user):
        """Process avatar URL using the same logic as library stats chart"""
        avatar_url = None
        
        # First check for external avatar URL
        if service_user.external_avatar_url:
            avatar_url = service_user.external_avatar_url
        elif service_user.server.service_type.value.lower() == 'plex':
            # Simplified Plex avatar logic
            if service_user.service_settings and service_user.service_settings.get('thumb'):
                thumb_url = service_user.service_settings['thumb']
                if thumb_url.startswith('/'):
                    avatar_url = f"{service_user.server.url.rstrip('/')}{thumb_url}"
                else:
                    avatar_url = thumb_url
        
        return avatar_url
    
    user.avatar_url = _get_service_user_avatar_url(user)
    
    # Add methods that might be expected by templates
    if not hasattr(user, 'get_display_name'):
        user.get_display_name = lambda: user.localUsername or 'Unknown'
    
    if not hasattr(user, 'get_avatar'):
        user.get_avatar = lambda default_url=None: user.avatar_url or default_url
    
    # Check if this service user is linked to a local account
    linked_local_user = None
    if service_user.linkedUserId:
        linked_local_user = User.query.filter_by(userType=UserType.LOCAL, uuid=service_user.linkedUserId).first()
    
    # Get the active tab from the URL query
    tab = request.args.get('tab', 'settings' if request.method == 'POST' else 'profile')
    
    # Handle HTMX requests for specific tabs
    if request.headers.get('HX-Request') and tab == 'history':
        # Return just the history tab content for HTMX requests
        user_service_types = {user.uuid: [service_user.server.service_type]}
        user_server_names = {user.uuid: [service_user.server.server_nickname]}
        
        # Get actual history for this service user
        page = request.args.get('page', 1, type=int)
        history_query = MediaStreamHistory.query.filter_by(user_uuid=user.uuid).order_by(MediaStreamHistory.started_at.desc())
        history_pagination = history_query.paginate(page=page, per_page=50, error_out=False)
        
        # Enhance history records with media information
        enhanced_history = enhance_history_records_with_media_ids(history_pagination.items)
        history_pagination.items = enhanced_history
        
        return render_template('user/_partials/profile_tabs/history_tab_content.html', 
                             user=user, 
                             history_logs=history_pagination,
                             user_service_types={user.uuid: [service_user.server.service_type]},
                             user_server_names={user.uuid: [service_user.server.server_nickname]})
    
    # Handle POST request (settings tab form submission)
    if request.method == 'POST':
        return handle_settings_tab_form_submission(service_user, server_nickname, server_username)
    
    # Create form for settings tab
    form = UserEditForm(obj=user)
    
    # Set up the library choices and current selections for the form
    from app.utils.user_library_helpers import setup_form_library_choices, match_stored_library_ids_to_choices
    
    try:
        # Set up library choices using utility function
        setup_form_library_choices(form, server_id=service_user.server.id)
        
        # Set current library selections using utility function
        current_library_ids = service_user.allowed_library_ids or []
        form.libraries.data = match_stored_library_ids_to_choices(
            current_library_ids, 
            form.libraries.choices, 
            service_user.server.service_type.value
        )
        
        current_app.logger.info(f"Settings tab form setup - Current user libraries: {current_library_ids}")
        current_app.logger.info(f"Settings tab form setup - Form libraries data: {form.libraries.data}")
        
    except Exception as e:
        current_app.logger.error(f"Error setting up library choices for settings tab: {e}")
        form.libraries.choices = []
        form.libraries.data = []
    
    # Get streaming stats and history for the user (enhanced from user route)
    stream_stats = user_service.get_user_stream_stats(user.uuid)
    
    last_ip_map = user_service.get_bulk_last_known_ips([user.uuid])
    last_ip = last_ip_map.get(str(user.uuid))
    user.stream_stats = stream_stats
    user.total_plays = stream_stats.get('global', {}).get('all_time_plays', 0)
    user.total_duration = stream_stats.get('global', {}).get('all_time_duration_seconds', 0)
    user.last_known_ip = last_ip if last_ip else 'N/A'
    
    # Populate last_streamed_at field for the profile display
    last_stream = MediaStreamHistory.query.filter_by(user_uuid=user.uuid).order_by(MediaStreamHistory.started_at.desc()).first()
    user.last_streamed_at = last_stream.started_at if last_stream else None
    
    # Initialize history and reading data
    stream_history_pagination = None
    kavita_reading_stats = None
    kavita_reading_history = None
    
    if tab == 'history':
        page = request.args.get('page', 1, type=int)
        
        # Check if this is a Kavita user and get reading data
        is_kavita_user = False
        kavita_user_id = None
        
        user_access_records = [service_user]
        for access_record in user_access_records:
            if access_record.server.service_type.value == 'kavita':
                is_kavita_user = True
                kavita_user_id = access_record.external_user_id
                break
        
        if is_kavita_user and kavita_user_id:
            # Get Kavita reading data
            try:
                kavita_server = None
                for access_record in user_access_records:
                    if access_record.server.service_type.value == 'kavita':
                        kavita_server = access_record.server
                        break
                
                if kavita_server:
                    service = MediaServiceFactory.create_service_from_db(kavita_server)
                    if service:
                        kavita_reading_stats = service.get_user_reading_stats(kavita_user_id)
                        kavita_reading_history = service.get_user_reading_history(kavita_user_id)
            except Exception as e:
                current_app.logger.error(f"Error fetching Kavita reading data: {e}")
        
        if not is_kavita_user:
            # For non-Kavita users, use regular stream history
            # Service user - filter by user_uuid to get only this user's history
            stream_history_pagination = MediaStreamHistory.query.filter_by(user_uuid=user.uuid)\
                .order_by(MediaStreamHistory.started_at.desc())\
                .paginate(page=page, per_page=15, error_out=False)
            
            # Enhance history records with MediaItem database IDs for clickable links
            enhance_history_records_with_media_ids(stream_history_pagination.items)
    
    # Context variables for template
    user_sorted_libraries = {}
    user_service_types = {user.uuid: [service_user.server.service_type]}
    user_server_names = {user.uuid: [service_user.server.server_nickname]}
    
    # Populate library data for the service user (same logic as users_modules/main.py)
    try:
        from app.services.media_service_manager import MediaServiceManager
        from app.routes.users_modules.helpers_deprecated import get_libraries_from_database
        media_service_manager = MediaServiceManager()
        all_servers = media_service_manager.get_all_servers()
        libraries_by_server = get_libraries_from_database(all_servers)
        
        # Process libraries for this service user
        server_libraries = libraries_by_server.get(service_user.server_id, {})
        lib_ids = service_user.allowed_library_ids or []
        
        if lib_ids == ['*']:
            lib_names = ['All Libraries']
        elif len(lib_ids) > 0:
            lib_names = []
            for lib_id in lib_ids:
                lib_name = server_libraries.get(str(lib_id), f'Unknown Lib {lib_id}')
                lib_names.append(lib_name)
        else:
            # Empty lib_ids - no specific library access
            lib_names = []
        
        user_sorted_libraries[user.uuid] = sorted(lib_names, key=str.lower)
        
    except Exception as e:
        current_app.logger.error(f"Error loading library data for service user: {e}")
        user_sorted_libraries[user.uuid] = []
    
    # Service user - linked_service_users queried dynamically in templates
    
    return render_template(
        'user/index.html',
        title=f"Admin - Service User Profile: {user.get_display_name()}",
        user=user,
        form=form,
        user_sorted_libraries=user_sorted_libraries,
        history_logs=stream_history_pagination,
        kavita_reading_stats=kavita_reading_stats,
        kavita_reading_history=kavita_reading_history,
        active_tab=tab,
        is_admin=check_if_user_is_admin(user),
        is_service_user=True,
        server=server,
        stream_stats=stream_stats,
        user_service_types=user_service_types,
        user_server_names=user_server_names,
        linked_user_app_access=linked_local_user,
        current_user=current_user,
        form_action_override=f"/admin/user/{server_nickname}/{server_username}",
        now_utc=datetime.now(timezone.utc),
        is_admin_context=True  # Flag to indicate admin context
    )


@admin_user_bp.route('/overseerr-requests/<int:server_id>/<server_nickname>/<server_username>')
@login_required
@permission_required('view_user')
def get_overseerr_requests(server_id, server_nickname, server_username):
    """Get Overseerr requests for a service user (admin view)"""
    try:
        from app.services.overseerr_service import OverseerrService
        
        # URL decode the parameters to handle special characters
        try:
            server_nickname = urllib.parse.unquote(server_nickname)
            server_username = urllib.parse.unquote(server_username)
        except Exception as e:
            current_app.logger.warning(f"Error decoding URL parameters: {e}")
            return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                 error_type='api_error',
                                 message='Invalid URL parameters provided to admin route.',
                                 is_admin_context=True)
        
        # Get the server
        server = MediaServer.query.get_or_404(server_id)
        
        # Check if server has Overseerr enabled
        if not server.overseerr_enabled or not server.overseerr_url or not server.overseerr_api_key:
            return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                 error_type='api_error',
                                 message='Overseerr is not properly configured for this server. Please check the server configuration in admin settings.',
                                 is_admin_context=True)
        
        # Find the service user record for this user
        service_user_record = User.query.filter_by(userType=UserType.SERVICE).join(MediaServer).filter(
            MediaServer.server_nickname == server_nickname,
            User.external_username == server_username,
            User.server_id == server_id
        ).first()
        
        if not service_user_record:
            current_app.logger.warning(f"No service user found for server_nickname={server_nickname}, server_username={server_username}, server_id={server_id}")
            return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                 error_type='no_plex_account',
                                 message='This user account was not found on the specified Plex server. Check the user\'s server access configuration.',
                                 is_admin_context=True)
        
        plex_user_id = service_user_record.external_user_id
        plex_username = service_user_record.external_username
        plex_email = service_user_record.external_email
        
        if not plex_user_id or not plex_username:
            return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                 error_type='no_plex_account',
                                 message='This user is missing required Plex account information. Check their server configuration.',
                                 is_admin_context=True)
        
        # Try to get the Overseerr user ID from user media access
        overseerr_user_id = User.get_overseerr_user_id(server_id, plex_user_id)
        
        # If no existing link, try to link lazily
        if not overseerr_user_id:
            link_success, linked_overseerr_user_id, link_message = User.link_single_user(
                server_id, plex_user_id, plex_username, plex_email
            )
            
            if link_success:
                overseerr_user_id = linked_overseerr_user_id
            else:
                # Handle specific error cases
                if "User not found in Overseerr" in link_message or "No Overseerr user found" in link_message:
                    return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                         error_type='user_not_found_in_overseerr',
                                         message='This Plex user account is not linked to Overseerr. The user needs to log into Overseerr at least once to create their account.',
                                         is_admin_context=True)
                else:
                    return render_template('user/_partials/profile_tabs/overseerr_error.html',
                                         error_type='linking_failed',
                                         message=f'Failed to link user to Overseerr: {link_message}',
                                         is_admin_context=True)
        
        # Get requests from Overseerr with pagination
        overseerr = OverseerrService(server.overseerr_url, server.overseerr_api_key)
        
        # Get pagination parameters
        page = request.args.get('page', 1, type=int)
        per_page = 10  # Number of requests per page
        skip = (page - 1) * per_page
        
        success, requests_list, pagination_info, message = overseerr.get_user_requests(overseerr_user_id, take=per_page, skip=skip)
        
        if not success:
            return render_template('user/_partials/profile_tabs/overseerr_error.html', 
                                 error_type='api_error',
                                 message=f'Failed to fetch Overseerr requests: {message}',
                                 is_admin_context=True)
        
        return render_template('user/_partials/profile_tabs/overseerr_requests.html',
                             requests=requests_list,
                             pagination=pagination_info,
                             server=server,
                             current_page=page,
                             per_page=per_page)
        
    except Exception as e:
        current_app.logger.error(f"Error in get_overseerr_requests: {e}")
        return render_template('user/_partials/profile_tabs/overseerr_error.html',
                             error_type='api_error',
                             message='An unexpected error occurred while fetching Overseerr requests. Check server logs for details.',
                             is_admin_context=True)


@admin_user_bp.route('/overseerr-request-update', methods=['POST'])
@login_required
@permission_required('view_user')
def update_overseerr_request():
    """Update the status of an Overseerr request (admin context)"""
    try:
        from app.services.overseerr_service import OverseerrService
        
        # Get parameters from request JSON
        data = request.get_json()
        server_id = data.get('server_id')
        request_id = data.get('request_id')
        status = data.get('status')
        
        # Validate parameters
        if not all([server_id, request_id, status]):
            return jsonify({'success': False, 'message': 'Missing required parameters'}), 400
        
        if status not in ['approve', 'decline']:
            return jsonify({'success': False, 'message': 'Invalid status'}), 400
        
        # Get the server
        server = MediaServer.query.get_or_404(server_id)
        
        # Check if server has Overseerr enabled
        if not server.overseerr_enabled or not server.overseerr_url or not server.overseerr_api_key:
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
        current_app.logger.error(f"Error updating Overseerr request: {e}")
        return jsonify({'success': False, 'message': 'An unexpected error occurred'}), 500


@admin_user_bp.route('/overseerr-request-delete', methods=['DELETE'])
@login_required
@permission_required('view_user')
def delete_overseerr_request():
    """Delete an Overseerr request (admin context)"""
    try:
        from app.services.overseerr_service import OverseerrService
        
        # Get parameters from request JSON
        data = request.get_json()
        server_id = data.get('server_id')
        request_id = data.get('request_id')
        
        # Validate parameters
        if not all([server_id, request_id]):
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
        current_app.logger.error(f"Error deleting Overseerr request: {e}")
        return jsonify({'success': False, 'message': 'An unexpected error occurred'}), 500


@admin_user_bp.route('/<server_nickname>/<server_username>/quick_edit', methods=['POST'])
@login_required  
@permission_required('edit_user')
def quick_edit_service_user(server_nickname, server_username):
    """Dedicated route for Quick Edit modal submissions"""
    from flask import redirect, url_for
    from app.models_media_services import MediaServer
    import urllib.parse
    
    # URL decode the parameters to handle special characters
    try:
        server_nickname = urllib.parse.unquote(server_nickname)
        server_username = urllib.parse.unquote(server_username)
    except Exception as e:
        current_app.logger.warning(f"Error decoding URL parameters: {e}")
        from flask import jsonify
        return jsonify({'success': False, 'message': 'Invalid URL parameters'}), 400
    
    # Find the server and service user
    server = MediaServer.query.filter_by(server_nickname=server_nickname).first_or_404()
    service_user = User.query.filter_by(userType=UserType.SERVICE).filter_by(
        server_id=server.id,
        external_username=server_username
    ).first_or_404()
    
    return handle_quick_edit_form_submission(service_user, server_nickname, server_username)


def handle_settings_tab_form_submission(service_user, server_nickname, server_username):
    """Handle POST form submission from the settings tab (full page)"""
    from flask import flash, redirect, url_for
    from app.forms import UserEditForm
    
    form = UserEditForm(request.form)
    
    # Set up the library choices for validation
    from app.utils.user_library_helpers import setup_form_library_choices
    setup_form_library_choices(form, server_id=service_user.server.id)
    
    if form.validate_on_submit():
        try:
            # Update service user fields
            if hasattr(form, 'notes') and form.notes.data is not None:
                service_user.notes = form.notes.data.strip() if form.notes.data else None
            
            # Handle expiration date
            if hasattr(form, 'clear_access_expiration') and form.clear_access_expiration.data:
                service_user.access_expires_at = None
            elif hasattr(form, 'access_expires_at') and form.access_expires_at.data:
                from datetime import datetime, time
                expiration_date = form.access_expires_at.data
                service_user.access_expires_at = datetime.combine(expiration_date, time.max)
            
            # Update library access and sync to server
            if hasattr(form, 'libraries') and form.libraries.data:
                from app.utils.user_library_helpers import update_user_library_access
                success, message = update_user_library_access(service_user, form.libraries.data, sync_to_server=True)
                if not success:
                    current_app.logger.warning(f"Library update failed: {message}")
            
            # Update download and transcode permissions
            if hasattr(form, 'allow_downloads'):
                service_user.allow_downloads = form.allow_downloads.data
            if hasattr(form, 'allow_4k_transcode'):
                service_user.allow_4k_transcode = form.allow_4k_transcode.data
            
            db.session.commit()
            flash('User settings updated successfully!', 'success')
            
            # Redirect back to the settings tab
            return redirect(url_for('admin_user.view_service_user', 
                                  server_nickname=server_nickname, 
                                  server_username=server_username,
                                  tab='settings'))
                
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error updating service user {server_username}: {e}")
            flash('Error updating user settings. Please try again.', 'error')
            return redirect(url_for('admin_user.view_service_user', 
                                  server_nickname=server_nickname, 
                                  server_username=server_username,
                                  tab='settings'))
    else:
        # Form validation failed
        current_app.logger.warning(f"Form validation failed for service user {server_username}: {form.errors}")
        flash('Please correct the errors in the form.', 'error')
    
    # Redirect back to the settings tab
    return redirect(url_for('admin_user.view_service_user', 
                          server_nickname=server_nickname, 
                          server_username=server_username,
                          tab='settings'))


def handle_quick_edit_form_submission(service_user, server_nickname, server_username):
    """Handle POST form submission from Quick Edit modal"""
    from flask import flash, redirect, url_for, jsonify
    from app.forms import UserEditForm
    
    form = UserEditForm(request.form)
    
    # Set up the library choices for validation - same logic as GET request
    from app.utils.user_library_helpers import setup_form_library_choices
    setup_form_library_choices(form, server_id=service_user.server.id)
    
    if form.validate_on_submit():
        try:
            # Update service user fields
            if hasattr(form, 'notes') and form.notes.data is not None:
                service_user.notes = form.notes.data.strip() if form.notes.data else None
            
            # Handle expiration date
            if hasattr(form, 'clear_access_expiration') and form.clear_access_expiration.data:
                service_user.access_expires_at = None
            elif hasattr(form, 'access_expires_at') and form.access_expires_at.data:
                # Convert date to datetime for storage
                from datetime import datetime, time
                expiration_date = form.access_expires_at.data
                service_user.access_expires_at = datetime.combine(expiration_date, time.max)
            
            # Update library access and sync to server
            if hasattr(form, 'libraries') and form.libraries.data:
                from app.utils.user_library_helpers import update_user_library_access
                success, message = update_user_library_access(service_user, form.libraries.data, sync_to_server=True)
                if not success:
                    current_app.logger.warning(f"Library update failed: {message}")
            
            # Update download and transcode permissions
            if hasattr(form, 'allow_downloads'):
                service_user.allow_downloads = form.allow_downloads.data
            if hasattr(form, 'allow_4k_transcode'):
                service_user.allow_4k_transcode = form.allow_4k_transcode.data
            
            db.session.commit()
            flash('User settings updated successfully!', 'success')
            
            # Return HTMX response if it's an HTMX request
            if request.headers.get('HX-Request'):
                # For HTMX requests from modal, return a success response that closes the modal
                from flask import make_response
                response = make_response('')
                response.headers['HX-Trigger'] = 'userUpdated'
                response.headers['HX-Refresh'] = 'true'  # Refresh the page to show updated data
                return response
            else:
                return redirect(url_for('admin_user.view_service_user', 
                                      server_nickname=server_nickname, 
                                      server_username=server_username))
                
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error updating service user {server_username}: {e}")
            flash('Error updating user settings. Please try again.', 'error')
            
            if request.headers.get('HX-Request'):
                return jsonify({'success': False, 'message': 'Error updating user settings'}), 500
    else:
        # Form validation failed
        current_app.logger.warning(f"Form validation failed for service user {server_username}: {form.errors}")
        flash('Please correct the errors in the form.', 'error')
        
        if request.headers.get('HX-Request'):
            return jsonify({'success': False, 'message': 'Form validation failed', 'errors': form.errors}), 400
    
    # If we get here, something went wrong - redirect back to the user page
    return redirect(url_for('admin_user.view_service_user', 
                          server_nickname=server_nickname, 
                          server_username=server_username))
# DEPRECATED: Legacy Flask SSR admin user routes. Replaced by React SPA.
