"""DEPRECATED: Legacy SSR user profile routes (replaced by SPA at /user)."""

from flask import render_template, redirect, url_for, flash, request, current_app, abort, make_response
from flask_login import login_required, current_user
from datetime import datetime, timezone, timedelta
from app.models import User, UserType, EventType
from app.models_media_services import MediaStreamHistory, ServiceType
from app.utils.helpers import permission_required, log_event
from app.extensions import db
from app.services.media_service_factory import MediaServiceFactory
from app.services.media_service_manager import MediaServiceManager
from app.services import user_service
from app.forms import UserEditForm
from . import user_bp
from .helpers_deprecated import check_if_user_is_admin, enhance_history_records_with_media_ids
import urllib.parse
import json

@user_bp.route('/profile')
@login_required
def profile():
    """Redirect to user profile based on current user type"""
    
    if current_user.userType == UserType.OWNER:
        # Owner should see the first local user's profile or create one
        first_local_user = User.query.filter_by(userType=UserType.LOCAL).first()
        if first_local_user:
            return redirect(url_for('user.view_app_user', username=first_local_user.localUsername))
        else:
            flash('No local user account found.', 'warning')
            return redirect(url_for('admin_management.list_admins'))
    
    elif current_user.userType == UserType.LOCAL:
        # Regular user sees their own profile
        return redirect(url_for('user.view_app_user', username=current_user.localUsername))
    
    else:
        # Service users shouldn't access this endpoint directly
        flash('Service users cannot access user profiles directly.', 'error')
        return redirect(url_for('auth.app_login'))


@user_bp.route('/<username>')
@login_required
@permission_required('view_user')
def view_app_user(username):
    """View local user account profile by username"""
    from app.models_media_services import MediaServer
    
    # URL decode the username to handle special characters
    try:
        username = urllib.parse.unquote(username)
    except Exception as e:
        current_app.logger.warning(f"Error decoding username: {e}")
        abort(400)
    
    # Find the local user
    user = User.get_by_local_username(username)
    if not user:
        abort(404)
    
    # Get the active tab from the URL query parameter
    tab = request.args.get('tab', 'profile')
    
    # Get streaming stats and history for the user
    stream_stats = user_service.get_user_stream_stats(user.uuid)
    last_ip_map = user_service.get_bulk_last_known_ips([user.uuid])
    last_ip = last_ip_map.get(str(user.uuid))
    user.stream_stats = stream_stats
    user.total_plays = stream_stats.get('global', {}).get('all_time_plays', 0)
    user.total_duration = stream_stats.get('global', {}).get('all_time_duration_seconds', 0)
    user.last_known_ip = last_ip if last_ip else 'N/A'
    
    # Get streaming history for the history tab
    page = request.args.get('page', 1, type=int)
    stream_history_pagination = None
    
    if tab == 'history':
        stream_history_pagination = MediaStreamHistory.query.filter_by(user_uuid=user.uuid)\
            .order_by(MediaStreamHistory.started_at.desc())\
            .paginate(page=page, per_page=15, error_out=False)
        
        # Enhance history records with MediaItem database IDs for clickable links
        enhance_history_records_with_media_ids(stream_history_pagination.items)
    
    # Get linked service accounts
    linked_service_users = User.query.filter_by(userType=UserType.SERVICE, linkedUserId=user.uuid).all()
    
    # Get user service types and server names for service-aware display
    user_service_types = {user.uuid: []}
    user_server_names = {user.uuid: []}
    
    for service_user in linked_service_users:
        if hasattr(service_user, 'server') and service_user.server:
            if service_user.server.service_type not in user_service_types[user.uuid]:
                user_service_types[user.uuid].append(service_user.server.service_type)
            if service_user.server.server_nickname not in user_server_names[user.uuid]:
                user_server_names[user.uuid].append(service_user.server.server_nickname)
    
    # Context variables for template
    user_sorted_libraries = {}
    
    # For HTMX requests on history tab, return just the content
    if request.headers.get('HX-Request') and tab == 'history':
        return render_template('user/_partials/profile_tabs/history_tab_content.html', 
                             user=user, 
                             history_logs=stream_history_pagination,
                             user_service_types=user_service_types,
                             user_server_names=user_server_names)
    
    return render_template(
        'user/index.html',
        title=f"User Profile: {user.get_display_name()}",
        user=user,
        user_sorted_libraries=user_sorted_libraries,
        history_logs=stream_history_pagination,
        active_tab=tab,
        is_admin=check_if_user_is_admin(user),
        is_service_user=False,
        stream_stats=stream_stats,
        user_service_types=user_service_types,
        user_server_names=user_server_names,
        linked_service_users=linked_service_users,
        current_user=current_user,
        now_utc=datetime.now(timezone.utc)
    )


# MockServiceUser class removed - service user profiles now handled via admin routes with unified User model


# ROUTE REMOVED: This route conflicted with admin route at /admin/user/<server_nickname>/<server_username>
# Service user profiles are now only accessible via the admin route to maintain proper access control
# The admin route now includes all the rich data that was previously only available here
