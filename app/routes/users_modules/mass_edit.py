# File: app/routes/user_modules/mass_edit.py
"""Mass editing and purge functionality for users"""

from flask import render_template, request, current_app, session, make_response
from flask_login import login_required, current_user
from sqlalchemy import or_, func
from app.models_media_services import MediaStreamHistory, MediaServer
from app.models import User, UserType, Setting
from app.forms import MassUserEditForm
from app.extensions import db
from app.utils.helpers import setup_required, permission_required
from app.services import user_service
from app.services.media_service_manager import MediaServiceManager
# MassEditMockUser import removed - now using unified User model directly
from . import users_bp
import json


@users_bp.route('/mass_edit_libraries_form')
@login_required
def mass_edit_libraries_form():
    """Get the mass edit libraries form for selected users"""
    current_app.logger.info("=== USERS PAGE: mass_edit_libraries_form() called - USING DATABASE DATA ===")
    user_ids_str = request.args.get('user_ids', '')
    #current_app.logger.debug(f"Raw user_ids_str received: '{user_ids_str}'")
    if not user_ids_str:
        return '<div class="alert alert-error">No users selected.</div>'
    
    # Parse user IDs - handle both prefixed and plain numeric IDs
    service_user_ids = []
    current_app.logger.debug(f"Processing user IDs: {user_ids_str.split(',')}")
    
    for uid_str in user_ids_str.split(','):
        uid_str = uid_str.strip()
        current_app.logger.debug(f"Processing individual ID: '{uid_str}'")
        if not uid_str:
            continue
        
        # Try to parse as UUID first
        try:
            from app.utils.helpers import get_user_by_uuid
            user_obj, user_type = get_user_by_uuid(uid_str)
            
            if user_obj and user_type == "user_media_access":
                service_user_ids.append(user_obj.id)
            elif user_obj and user_type == "user_app_access":
                current_app.logger.warning(f"Mass edit libraries attempted on local user {uid_str} - not supported")
            else:
                current_app.logger.warning(f"No user found for uuid {uid_str}")
        except Exception as e:
            current_app.logger.debug(f"Failed to parse as uuid: {e}")
            current_app.logger.error(f"Invalid user UUID in mass edit libraries: {uid_str} - {e}")
    
    if not service_user_ids:
        return '<div class="alert alert-warning">Mass edit libraries is only available for service users. No valid service users were selected.</div>'
    
    current_app.logger.debug(f"Querying for service_user_ids: {service_user_ids}")
    # Query for service users and their linked local users with server info
    access_records = db.session.query(User, MediaServer).join(
        MediaServer, User.server_id == MediaServer.id
    ).filter(
        User.id.in_(service_user_ids),
        User.userType == UserType.SERVICE
    ).all()
    current_app.logger.debug(f"Found {len(access_records)} access records")
    
    # Debug each access record
    for i, (service_user, server) in enumerate(access_records):
        current_app.logger.debug(f"Record {i}: service_user={service_user.id if service_user else None}, server={server.id if server else None}")
        if service_user:
            current_app.logger.debug(f"Record {i} service_user details: external_username={service_user.external_username}, server_id={service_user.server_id}")
        if server:
            current_app.logger.debug(f"Record {i} server details: name={server.server_nickname}, service_type={server.service_type}")
        
        # Get linked local user if any
        linked_user = service_user.get_linked_parent() if service_user else None
        if linked_user:
            current_app.logger.debug(f"Record {i} linked user details: username={linked_user.localUsername}")
        else:
            current_app.logger.debug(f"Record {i} no linked user (standalone service user)")

    services_data = {}
    for service_user, server in access_records:
        service_type_key = server.service_type.value
        if service_type_key not in services_data:
            services_data[service_type_key] = {
                'service_name': server.service_type.name.capitalize(),
                'servers': {}
            }
        
        if server.id not in services_data[service_type_key]['servers']:
            # Get libraries using utility function
            from app.utils.user_library_helpers import get_server_library_choices
            
            library_choices = get_server_library_choices(server.id, server.service_type.value)
            libraries = []
            for lib_id, lib_name in library_choices:
                libraries.append({
                    'id': lib_id,
                    'external_id': lib_id,
                    'name': lib_name
                })
            
            services_data[service_type_key]['servers'][server.id] = {
                'server_name': server.server_nickname,
                'users': [],
                'libraries': libraries,
                'current_library_ids': set(service_user.allowed_library_ids or [])
            }
        
        # Create display name for this user on this server
        display_name = f"{service_user.external_username} ({server.server_nickname})"
        services_data[service_type_key]['servers'][server.id]['users'].append(display_name)
        
        # Intersect library IDs for users on the same server
        current_ids = services_data[service_type_key]['servers'][server.id]['current_library_ids']
        current_ids.intersection_update(service_user.allowed_library_ids or [])

    current_app.logger.debug(f"Built services_data with {len(services_data)} service types")
    for service_key, service_info in services_data.items():
        current_app.logger.debug(f"Service {service_key} has {len(service_info['servers'])} servers")
        for server_id, server_data in service_info['servers'].items():
            current_app.logger.debug(f"Server {server_id} ({server_data['server_name']}) has {len(server_data['users'])} users: {server_data['users']}")
    
    return render_template('users/_partials/_mass_edit_libraries.html', 
                           services_data=services_data)


@users_bp.route('/mass_edit', methods=['POST'])
@login_required
@setup_required
@permission_required('mass_edit_users')
def mass_edit_users():
    """Handle mass edit operations on users"""
    current_app.logger.debug("--- MASS EDIT ROUTE START ---")
    
    # DEBUG 1: Print the raw form data received by Flask
    print(f"[SERVER DEBUG 1] Raw request.form: {request.form.to_dict()}")

    # We get user_ids manually from the request now
    user_ids_str = request.form.get('user_ids')
    toast_message = ""
    toast_category = "error"

    # Instantiate form for the other fields that DO need validation
    form = MassUserEditForm(request.form)
    
    # We still must populate the dynamic choices for the libraries field
    media_service_manager = MediaServiceManager()
    
    # Get libraries from all active servers using utility function
    from app.utils.user_library_helpers import get_multi_server_library_choices
    
    all_servers = media_service_manager.get_all_servers(active_only=True)
    server_ids = [server.id for server in all_servers]
    
    # Use utility function to get choices - don't include server prefix for mass edit
    form.libraries.choices = get_multi_server_library_choices(server_ids, include_server_prefix=False)

    # Manual validation for user_ids, then form validation for the rest
    if not user_ids_str:
        toast_message = "Validation Error: User Ids: This field is required."
        print("[SERVER DEBUG 2] user_ids_str is missing or empty.")
    elif form.validate():
        print(f"[SERVER DEBUG 3] Form validation PASSED. User IDs from request: '{user_ids_str}'")
        
        # Parse prefixed user IDs and extract actual database IDs
        user_ids = []
        # Convert UUIDs to actual user IDs for local users only
        from app.utils.helpers import get_user_by_uuid
        
        for uid_str in user_ids_str.split(','):
            uid_str = uid_str.strip()
            if not uid_str:
                continue
            try:
                user_obj, user_type = get_user_by_uuid(uid_str)
                if user_obj:
                    # For delete operations, support both local and service users
                    # For other mass edit operations, we only support service users (not local users)
                    if user_type == "user_media_access":
                        user_ids.append(uid_str)  # Use UUID for mass operations
                    elif user_type == "user_app_access":
                        # Check if this is a delete operation - if so, allow local users too
                        action = form.action.data if form.action.data else request.form.get('action', '')
                        if action == 'delete_users':
                            user_ids.append(uid_str)  # Allow local users for delete operations
                        else:
                            current_app.logger.warning(f"Mass edit attempted on local user {uid_str} - only service users supported for {action}")
                    else:
                        current_app.logger.warning(f"Unknown user type {user_type} for user {uid_str}")
                else:
                    current_app.logger.warning(f"User not found for UUID {uid_str}")
            except Exception as e:
                current_app.logger.error(f"Invalid user UUID in mass edit: {uid_str} - {e}")
        
        if not user_ids:
            action = form.action.data if form.action.data else request.form.get('action', '')
            if action == 'delete_users':
                toast_message = "No valid users selected for mass delete operation."
            else:
                toast_message = "No valid service users selected for mass edit operation."
            toast_category = "error"
        else:
            action = form.action.data
            try:
                if action == 'update_libraries':
                    # Parse libraries per server for service users
                    updates_by_server = {}
                    
                    # Get list of all servers that were shown in the form (even if no libraries selected)
                    # Look for server_processed_X fields to identify which servers should be updated
                    servers_to_process = set()
                    for key in request.form.keys():
                        if key.startswith('libraries_server_'):
                            server_id = int(key.split('_')[-1])
                            servers_to_process.add(server_id)
                        elif key.startswith('server_processed_'):
                            server_id = int(key.split('_')[-1])
                            servers_to_process.add(server_id)
                    
                    # Process each server (including those with no libraries selected)
                    for key, value in request.form.items():
                        if key.startswith('libraries_server_'):
                            server_id = int(key.split('_')[-1])
                            if server_id not in updates_by_server:
                                updates_by_server[server_id] = []
                            updates_by_server[server_id] = request.form.getlist(key)
                    
                    # Add servers that had no libraries selected (remove all access)
                    for key in request.form.keys():
                        if key.startswith('server_processed_'):
                            server_id = int(key.split('_')[-1])
                            if server_id not in updates_by_server:
                                updates_by_server[server_id] = []  # Empty list = no libraries
                                current_app.logger.info(f"Mass Edit: Server {server_id} had no libraries selected - removing all access")
                    
                    current_app.logger.info(f"Mass Edit: Form processing result - updates_by_server = {updates_by_server}")

                    processed_count, error_count = user_service.mass_update_user_libraries_by_server(user_ids, updates_by_server, admin_id=current_user.id)
                    toast_message = f"Mass library update: {processed_count} service users updated, {error_count} errors."
                    toast_category = "success" if error_count == 0 else "warning"
                elif action == 'extend_access':
                    days_to_extend = form.days_to_extend.data
                    if not days_to_extend or days_to_extend < 1:
                        toast_message = "Invalid number of days to extend."
                        toast_category = "error"
                    else:
                        processed_count, error_count = user_service.mass_extend_access(user_ids, days_to_extend, admin_id=current_user.id)
                        toast_message = f"Extended access for {processed_count} service users by {days_to_extend} days, {error_count} errors."
                        toast_category = "success" if error_count == 0 else "warning"
                elif action == 'set_expiration':
                    new_expiration_date = form.new_expiration_date.data
                    if not new_expiration_date:
                        toast_message = "Expiration date is required."
                        toast_category = "error"
                    else:
                        processed_count, error_count = user_service.mass_set_expiration(user_ids, new_expiration_date, admin_id=current_user.id)
                        toast_message = f"Set expiration date for {processed_count} service users, {error_count} errors."
                        toast_category = "success" if error_count == 0 else "warning"
                elif action == 'clear_expiration':
                    processed_count, error_count = user_service.mass_clear_expiration(user_ids, admin_id=current_user.id)
                    toast_message = f"Cleared expiration for {processed_count} service users, {error_count} errors."
                    toast_category = "success" if error_count == 0 else "warning"
                elif action == 'merge_into_local_account':
                    # Check if user accounts are enabled
                    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
                    
                    if not allow_user_accounts:
                        toast_message = "User accounts feature is disabled. Cannot create local accounts."
                        toast_category = "error"
                    else:
                        # Get form data for the new local account
                        merge_username = request.form.get('merge_username', '').strip()
                        merge_password = request.form.get('merge_password', '')
                        merge_confirm_password = request.form.get('merge_confirm_password', '')
                        
                        # Validate the merge form data
                        if not merge_username or not merge_password or not merge_confirm_password:
                            toast_message = "Username and password are required for creating a local account."
                            toast_category = "error"
                        elif len(merge_username) < 3 or len(merge_username) > 50:
                            toast_message = "Username must be between 3 and 50 characters."
                            toast_category = "error"
                        elif len(merge_password) < 8:
                            toast_message = "Password must be at least 8 characters."
                            toast_category = "error"
                        elif merge_password != merge_confirm_password:
                            toast_message = "Passwords do not match."
                            toast_category = "error"
                        elif not all(c.isalnum() or c in '_-' for c in merge_username):
                            toast_message = "Username can only contain letters, numbers, underscores, and hyphens."
                            toast_category = "error"
                        else:
                            # Check if username already exists
                            existing_user = User.get_by_local_username(merge_username)
                            if existing_user:
                                toast_message = f"Username '{merge_username}' already exists. Please choose a different one."
                                toast_category = "error"
                            else:
                                try:
                                    # Create the merge operation
                                    processed_count, error_count, local_user_id = user_service.merge_service_users_into_local_account(
                                        user_ids, merge_username, merge_password, admin_id=current_user.id
                                    )
                                    if processed_count > 0:
                                        toast_message = f"Successfully created local account '{merge_username}' and linked {processed_count} service users. {error_count} errors."
                                        toast_category = "success" if error_count == 0 else "warning"
                                    else:
                                        toast_message = f"Failed to create local account. {error_count} errors occurred."
                                        toast_category = "error"
                                except Exception as e:
                                    toast_message = f"Error creating local account: {str(e)}"
                                    toast_category = "error"
                elif action == 'delete_users':
                    if not form.confirm_delete.data:
                        toast_message = "Deletion was not confirmed. No action taken."
                        toast_category = "warning"
                    else:
                        # mass_delete_users already supports UUIDs, so pass them directly
                        processed_count, error_count = user_service.mass_delete_users(user_ids, admin_id=current_user.id)
                        toast_message = f"Mass delete: {processed_count} removed, {error_count} errors."
                        toast_category = "success" if error_count == 0 else "warning"
                elif action.endswith('_whitelist'):
                    should_add = action.startswith('add_to')
                    whitelist_type = "Bot" if "bot" in action else "Purge"
                    if whitelist_type == "Bot":
                        count = user_service.mass_update_bot_whitelist(user_ids, should_add, current_user.id)
                    else: # Purge
                        count = user_service.mass_update_purge_whitelist(user_ids, should_add, current_user.id)
                    action_text = "added to" if should_add else "removed from"
                    toast_message = f"{count} service user(s) {action_text} the {whitelist_type} Whitelist."
                    toast_category = "success"
                else:
                    toast_message = "Invalid action."
            except Exception as e:
                toast_message = f"Server Error: {str(e)[:100]}"
                print(f"[SERVER DEBUG 5] Exception during action '{action}': {e}")
                import traceback
                traceback.print_exc()
    else:
        # Form validation failed for other fields (e.g., action)
        error_list = []
        for field, errors in form.errors.items():
            field_label = getattr(form, field).label.text
            for error in errors:
                error_list.append(f"{field_label}: {error}")
                print(f"[SERVER DEBUG 4] Validation Error for '{field_label}': {error}")
        toast_message = "Validation Error: " + "; ".join(error_list)

    # Re-rendering logic - use the same logic as the main list_users route to preserve all filters
    page = request.args.get('page', 1, type=int)
    view_mode = request.args.get('view', 'cards')
    items_per_page = session.get('users_list_per_page', int(current_app.config.get('DEFAULT_USERS_PER_PAGE', 12)))
    
    query = User.query.filter_by(userType=UserType.LOCAL)
    
    # Handle separate search fields (same as main route)
    search_username = request.args.get('search_username', '').strip()
    search_email = request.args.get('search_email', '').strip()
    search_notes = request.args.get('search_notes', '').strip()
    search_term = request.args.get('search', '').strip()
    
    # Build search filters
    search_filters = []
    if search_username:
        search_filters.append(User.localUsername.ilike(f"%{search_username}%"))
    if search_email:
        search_filters.append(User.discord_email.ilike(f"%{search_email}%"))
    if search_notes:
        search_filters.append(User.notes.ilike(f"%{search_notes}%"))
    if search_term:
        search_filters.append(or_(User.localUsername.ilike(f"%{search_term}%"), User.discord_email.ilike(f"%{search_term}%")))
    
    # Apply search filters if any exist
    if search_filters:
        query = query.filter(or_(*search_filters))

    # Server filter (same as main route)
    server_filter_id = request.args.get('server_id', 'all')
    if server_filter_id != 'all':
        try:
            server_filter_id_int = int(server_filter_id)
            query = query.filter(User.server_id == server_filter_id_int)
        except ValueError:
            current_app.logger.warning(f"Invalid server_id received: {server_filter_id}")
    
    filter_type = request.args.get('filter_type', '')
    # Apply filters for users (updated for new architecture)
    if filter_type == 'has_discord': 
        query = query.filter(User.discord_user_id != None)
    elif filter_type == 'no_discord': 
        query = query.filter(User.discord_user_id == None)
    
    # Enhanced sorting logic (same as main route)
    sort_by_param = request.args.get('sort_by', 'username_asc')
    sort_parts = sort_by_param.rsplit('_', 1)
    sort_column = sort_parts[0]
    sort_direction = 'desc' if len(sort_parts) > 1 and sort_parts[1] == 'desc' else 'asc'
    
    # Handle sorting that requires joins and aggregation
    if sort_column in ['total_plays', 'total_duration']:
        # Join with MediaStreamHistory for sorting by stream stats
        query = query.outerjoin(MediaStreamHistory, MediaStreamHistory.user_uuid == User.uuid).group_by(User.id)
        sort_field = func.count(MediaStreamHistory.id) if sort_column == 'total_plays' else func.sum(func.coalesce(MediaStreamHistory.duration_seconds, 0))
        query = query.add_columns(sort_field.label('sort_value'))
        
        if sort_direction == 'desc':
            query = query.order_by(db.desc('sort_value').nullslast(), User.id.asc())
        else:
            query = query.order_by(db.asc('sort_value').nullsfirst(), User.id.asc())
    else:
        sort_map = {
            'username': User.localUsername,
            'email': User.discord_email,
            'last_streamed': User.last_login_at,  # Uses last_login_at for unified User model
            'created_at': User.created_at
        }
        
        sort_field = sort_map.get(sort_column, User.localUsername)

        if sort_column in ['username', 'email']:
            if sort_direction == 'desc':
                query = query.order_by(func.lower(sort_field).desc().nullslast(), User.id.asc())
            else:
                query = query.order_by(func.lower(sort_field).asc().nullsfirst(), User.id.asc())
        else:
            if sort_direction == 'desc':
                query = query.order_by(sort_field.desc().nullslast(), User.id.asc())
            else:
                query = query.order_by(sort_field.asc().nullsfirst(), User.id.asc())
    
    # Calculate count properly for complex queries
    if sort_column in ['total_plays', 'total_duration']:
        count_query = User.query.filter_by(userType=UserType.LOCAL)
        if search_filters:
            count_query = count_query.filter(or_(*search_filters))
        if server_filter_id != 'all':
            try:
                server_filter_id_int = int(server_filter_id)
                count_query = count_query.filter(User.server_id == server_filter_id_int)
            except ValueError:
                pass
        if filter_type == 'has_discord': 
            count_query = count_query.filter(User.discord_user_id != None)
        elif filter_type == 'no_discord': 
            count_query = count_query.filter(User.discord_user_id == None)
        users_count = count_query.count()
    else:
        users_count = query.count()
    
    users_pagination = query.paginate(page=page, per_page=items_per_page, error_out=False)
    
    # Extract users from pagination results (handling complex queries that return tuples)
    users_on_page = [item[0] if isinstance(item, tuple) else item for item in users_pagination.items]
    
    # Set _user_type for template logic (mass_edit only deals with local users)
    for user in users_pagination.items:
        if isinstance(user, tuple):
            user[0]._user_type = 'local'
        else:
            user._user_type = 'local'
    
    # Extract user UUIDs from pagination results for stats lookup
    user_uuids_on_page = [user.uuid for user in users_pagination.items if hasattr(user, 'uuid')]
    
    # Get library access info for each user, organized by server to prevent ID collisions
    user_library_access_by_server = {}  # user_id -> server_id -> [lib_ids]
    user_sorted_libraries = {}
    
    # Get actual user IDs for LOCAL users only (for library access lookup)
    local_user_ids = [user.id for user in users_pagination.items if hasattr(user, 'id')]
    
    access_records = User.query.filter_by(userType=UserType.SERVICE).filter(User.linkedUserId.in_(local_user_ids)).all()
    for access in access_records:
        if access.linkedUserId not in user_library_access_by_server:
            user_library_access_by_server[access.linkedUserId] = {}
        user_library_access_by_server[access.linkedUserId][access.server_id] = access.allowed_library_ids

    # Get libraries organized by server using existing helper function
    from app.routes.user_modules.helpers import get_libraries_from_database
    
    all_servers = media_service_manager.get_all_servers(active_only=True)
    libraries_by_server = get_libraries_from_database(all_servers)

    # Create a mapping of user_id to User object for easy lookup
    users_by_id = {user.id: user for user in users_pagination.items}
    
    for user_id, servers_access in user_library_access_by_server.items():
        user_obj = users_by_id.get(user_id)
        all_lib_names = []
        
        for server_id, lib_ids in servers_access.items():
            # Handle special case for Jellyfin users with '*' (all libraries access)
            if lib_ids == ['*']:
                lib_names = ['All Libraries']
            else:
                # Check if this user has library_names available (for services like Kavita)
                if user_obj and hasattr(user_obj, 'library_names') and user_obj.library_names:
                    # Use library_names from the user object
                    lib_names = user_obj.library_names
                else:
                    # Look up library names from the correct server to prevent ID collisions
                    server_libraries = libraries_by_server.get(server_id, {})
                    lib_names = []
                    for lib_id in lib_ids:
                        # Use internal_id to look up library name
                        lib_name = server_libraries.get(str(lib_id), f'Unknown Lib {lib_id}')
                        lib_names.append(lib_name)
            
            all_lib_names.extend(lib_names)
        
        user_sorted_libraries[user_id] = sorted(all_lib_names, key=str.lower)

    # Get additional required context data for the template
    # Get Owner with plex_uuid for filtering (AppUsers don't have plex_uuid)
    owner = User.query.filter_by(userType=UserType.OWNER).filter(User.plex_uuid.isnot(None)).first()
    admin_accounts = [owner] if owner else []
    admins_by_uuid = {admin.plex_uuid: admin for admin in admin_accounts if admin.plex_uuid}
    
    # Get stream stats and other data using UUIDs
    stream_stats = user_service.get_bulk_user_stream_stats(user_uuids_on_page)
    last_ips = user_service.get_bulk_last_known_ips(user_uuids_on_page)
    
    # Attach the additional data directly to each user object
    for user in users_pagination.items:
        if hasattr(user, 'uuid'):
            stats = stream_stats.get(user.uuid, {})
            user.total_plays = stats.get('play_count', 0)
            user.total_duration = stats.get('total_duration', 0)
            user.last_known_ip = last_ips.get(user.uuid, 'N/A')
    
    # Build user_service_types for template context
    user_service_types = {}  # Track which services each user belongs to
    user_server_names = {}   # Track server names for each user
    
    # Get all user access records to determine service types
    all_user_access = User.query.filter_by(userType=UserType.SERVICE).filter(
        User.linkedUserId.in_([user.id for user in users_pagination.items])
    ).all()
    
    for access in all_user_access:
        if access.linkedUserId not in user_service_types:
            user_service_types[access.linkedUserId] = []
            user_server_names[access.linkedUserId] = []
        
        if access.server.service_type not in user_service_types[access.linkedUserId]:
            user_service_types[access.linkedUserId].append(access.server.service_type)
        
        if access.server.server_nickname not in user_server_names[access.linkedUserId]:
            user_server_names[access.linkedUserId].append(access.server.server_nickname)

    # Get server dropdown options for template
    server_dropdown_options = [{"id": "all", "name": "All Servers"}]
    for server in all_servers:
        server_dropdown_options.append({
            "id": server.id,
            "name": f"{server.server_nickname} ({server.service_type.value.capitalize()})"
        })

    # Build complete template context
    template_context = {
        'users': users_pagination,
        'users_count': users_count,
        'user_library_access_by_server': user_library_access_by_server,
        'user_sorted_libraries': user_sorted_libraries,
        'current_view': view_mode,
        'current_per_page': items_per_page,
        'stream_stats': stream_stats,
        'last_ips': last_ips,
        'admins_by_uuid': admins_by_uuid,
        'user_service_types': user_service_types,
        'user_server_names': user_server_names,
        'sort_column': sort_column,
        'sort_direction': sort_direction,
        'server_dropdown_options': server_dropdown_options,
        'user_last_played': {},  # Would need additional logic to populate
        'user_library_service_mapping': {},  # Would need additional logic to populate
        'admin_plex_uuids': {admin.plex_uuid for admin in admin_accounts},
        'purge_settings': {},
        'selected_users_count': 0,
        'mass_edit_form': form,
        'title': "Managed Users",
        'user_type_options': [
            {"id": "all", "name": "All Users"},
            {"id": "local", "name": "Local Users Only"},
            {"id": "service", "name": "Service Users Only"}
        ],
        'current_user_type': 'all',
        'app_users': [],
        'service_users': [],
        'allow_user_accounts': Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    }

    response_html = render_template('users/_partials/user_list_content.html', **template_context)
    
    response = make_response(response_html)
    toast_payload = {"showToastEvent": {"message": toast_message, "category": toast_category}}
    response.headers['HX-Trigger-After-Swap'] = json.dumps(toast_payload)
    
    # Debug logging to help troubleshoot toast issues
    current_app.logger.debug(f"Mass edit complete. Toast message: '{toast_message}', category: '{toast_category}'")
    current_app.logger.debug(f"HX-Trigger-After-Swap header: {response.headers.get('HX-Trigger-After-Swap')}")
    
    return response


@users_bp.route('/purge_inactive', methods=['POST'])
@login_required
@setup_required
@permission_required('purge_users')
def purge_inactive_users():
    """Purge inactive users based on criteria"""
    try:
        user_ids_to_purge = request.form.getlist('user_ids_to_purge')
        if not user_ids_to_purge:
            return render_template('partials/_alert_message.html', message="No users were selected to be purged.", category='info'), 400

        # Pass all criteria to the service layer for a final, safe check
        results = user_service.purge_inactive_users(
            user_ids_to_purge=[int(uid) for uid in user_ids_to_purge],
            admin_id=current_user.id,
            inactive_days_threshold=request.form.get('inactive_days', type=int),
            exclude_sharers=request.form.get('exclude_sharers') == 'true',
            exclude_whitelisted=request.form.get('exclude_whitelisted') == 'true',
            ignore_creation_date_for_never_streamed=request.form.get('ignore_creation_date') == 'true'
        )
        return render_template('partials/_alert_message.html', 
                               message=results['message'], 
                               category='success' if results['errors'] == 0 else 'warning')
    except Exception as e:
        current_app.logger.error(f"Error during purge inactive users route: {e}", exc_info=True)
        return render_template('partials/_alert_message.html', message=f"An unexpected error occurred: {e}", category='error'), 500


@users_bp.route('/purge_inactive/preview', methods=['POST'])
@login_required
@setup_required
def preview_purge_inactive_users():
    """Preview users that would be purged based on criteria"""
    try:
        # Get form parameters
        inactive_days = request.form.get('inactive_days', 90, type=int)
        exclude_sharers = request.form.get('exclude_sharers') == 'true'
        exclude_whitelisted = request.form.get('exclude_whitelisted') == 'true'
        ignore_creation_date = request.form.get('ignore_creation_date') == 'true'
        
        # Get preview from service
        eligible_users = user_service.get_users_eligible_for_purge(
            inactive_days_threshold=inactive_days,
            exclude_sharers=exclude_sharers,
            exclude_whitelisted=exclude_whitelisted,
            ignore_creation_date_for_never_streamed=ignore_creation_date
        )

        purge_criteria = {
            'inactive_days': inactive_days,
            'exclude_sharers': exclude_sharers,
            'exclude_whitelisted': exclude_whitelisted,
            'ignore_creation_date': ignore_creation_date
        }

        return render_template('users/_partials/purge_preview_modal.html',
                               eligible_users=eligible_users,
                               purge_criteria=purge_criteria)
    except Exception as e:
        current_app.logger.error(f"Error during purge preview: {e}", exc_info=True)
        return render_template('components/alerts/alert_message.html',
                               message=f"Error generating preview: {e}",
                               category='error'), 500