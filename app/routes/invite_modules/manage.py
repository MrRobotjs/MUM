"""
Invite management functionality - Admin list, create, toggle status, view usages
"""

import time
from datetime import datetime
from flask import render_template, redirect, url_for, flash, request, current_app, g, make_response
from flask_login import login_required, current_user
from app.models import User, UserType, Invite, Setting, EventType
from app.models_media_services import MediaServer
from app.forms import InviteCreateForm
from app.extensions import db
from app.utils.helpers import setup_required, permission_required, log_event
from app.services.media_service_manager import MediaServiceManager
from . import invites_admin_bp as invites_bp
import json

@invites_bp.route('/') 
@login_required
@setup_required
@permission_required('manage_invites')
def list_invites():
    # Redirect local users away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('manage_invites'):
        flash('You do not have permission to access the invites management page.', 'danger')
        return redirect(url_for('user.index'))
    
    start_time = time.time()
    
    page = request.args.get('page', 1, type=int)
    # Get view mode, defaulting to 'cards'
    view_mode = request.args.get('view', Setting.get('DEFAULT_INVITE_VIEW', 'cards'))

    items_per_page_setting = Setting.get('DEFAULT_INVITES_PER_PAGE', current_app.config.get('DEFAULT_INVITES_PER_PAGE', 10))
    items_per_page = int(items_per_page_setting) if items_per_page_setting else 10
    
    # Query logic is unchanged
    query = Invite.query
    filter_status = request.args.get('filter', 'all')
    search_path = request.args.get('search_path', '').strip()
    if search_path: 
        query = query.filter(Invite.custom_path.ilike(f"%{search_path}%"))
    now = datetime.utcnow() 
    if filter_status == 'active': 
        query = query.filter(Invite.is_active == True, (Invite.expires_at == None) | (Invite.expires_at > now), (Invite.max_uses == None) | (Invite.current_uses < Invite.max_uses))
    elif filter_status == 'expired': 
        query = query.filter(Invite.expires_at != None, Invite.expires_at <= now)
    elif filter_status == 'maxed': 
        query = query.filter(Invite.max_uses != None, Invite.current_uses >= Invite.max_uses)
    elif filter_status == 'inactive': 
        query = query.filter(Invite.is_active == False)
    
    invites_pagination = query.order_by(Invite.created_at.desc()).paginate(page=page, per_page=items_per_page, error_out=False)
    invites_count = query.count()
    
    # Create modal form logic
    form = InviteCreateForm()
    media_service_manager = MediaServiceManager()
    
    # Fetch all active servers
    all_servers = media_service_manager.get_all_servers(active_only=True)

    # Build comprehensive library data for invite cards display using utility functions
    from app.utils.user_library_helpers import get_multi_server_library_choices
    
    available_libraries = {}
    form.libraries.choices = []
    
    # Build library lookup for templates using utility function
    from app.utils.user_library_helpers import build_libraries_lookup_for_templates
    libraries_by_server, all_libraries_lookup = build_libraries_lookup_for_templates(all_servers)
    
    # Discord settings
    discord_oauth_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    bot_is_enabled = Setting.get_bool('DISCORD_BOT_ENABLED', False)
    global_force_sso = Setting.get_bool('DISCORD_BOT_REQUIRE_SSO_ON_INVITE', False) or bot_is_enabled
    enable_discord_membership_requirement = Setting.get_bool('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', False)
    form.require_discord_auth.data = global_force_sso
    form.require_discord_guild_membership.data = enable_discord_membership_requirement
    
    # If the request is from HTMX, render the list content partial
    if request.headers.get('HX-Request'):
        return render_template('invites/_partials/invite_list_content.html', 
                               invites=invites_pagination,
                               all_servers=all_servers,
                               available_libraries=available_libraries,
                               libraries_by_server=libraries_by_server,
                               all_libraries_lookup=all_libraries_lookup,
                               current_view=view_mode,
                               current_per_page=items_per_page)

    # Create grouped_servers for the template
    grouped_servers = {}
    for server in all_servers:
        service_type_name = server.service_type.name.capitalize()
        if service_type_name not in grouped_servers:
            grouped_servers[service_type_name] = []
        grouped_servers[service_type_name].append(server)

    # For a full page load, render the main list.html
    result = render_template('invites/index.html', 
                           title="Manage Invites", 
                           invites_count=invites_count, 
                           form=form, 
                           all_servers=all_servers,
                           grouped_servers=grouped_servers,
                           available_libraries=available_libraries,
                           libraries_by_server=libraries_by_server,
                           all_libraries_lookup=all_libraries_lookup,
                           current_per_page=items_per_page,
                           discord_oauth_enabled=discord_oauth_enabled,
                           global_force_sso=global_force_sso,
                           enable_discord_membership_requirement=enable_discord_membership_requirement,
                           current_view=view_mode)
    
    # Log performance for slow requests only
    total_time = time.time() - start_time
    if total_time > 1.0:  # Only log if over 1 second
        current_app.logger.warning(f"Slow invites page load: {total_time:.3f}s")
    
    return result

@invites_bp.route('/create', methods=['POST'])
@login_required
@setup_required
@permission_required('create_invites')
def create_invite():
    form = InviteCreateForm()
    media_service_manager = MediaServiceManager()
    
    # Server and library logic
    all_servers = media_service_manager.get_all_servers(active_only=True)
    selected_server_ids_str = request.form.get('server_ids', '')
    selected_server_ids = [id.strip() for id in selected_server_ids_str.split(',') if id.strip()]
    
    # Set up library choices using utility functions
    from app.utils.user_library_helpers import setup_form_library_choices, get_server_library_choices
    available_libraries = {}
    
    if selected_server_ids:
        first_server = media_service_manager.get_server_by_id(selected_server_ids[0])
        if first_server:
            try:
                # Use utility function to get library choices
                choices = get_server_library_choices(first_server.id, first_server.service_type.value)
                available_libraries = {choice[0]: choice[1] for choice in choices}
                current_app.logger.info(f"Loaded {len(available_libraries)} libraries from database for server {first_server.server_nickname}")
                current_app.logger.info(f"Library choices for {first_server.service_type.value} server: {choices}")
            except Exception as e:
                current_app.logger.error(f"Failed to fetch libraries from database for server {first_server.server_nickname}: {e}")
                available_libraries = {}
    
    # Set initial form choices using utility functions
    if len(selected_server_ids) == 1:
        first_server = media_service_manager.get_server_by_id(selected_server_ids[0])
        if first_server:
            setup_form_library_choices(form, server_id=first_server.id)
    else:
        # Multi-server case - will be handled below
        form.libraries.choices = [(lib_id, name) for lib_id, name in available_libraries.items()]
    
    # Discord settings
    discord_oauth_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    bot_is_enabled = Setting.get_bool('DISCORD_BOT_ENABLED', False)
    global_force_sso = Setting.get_bool('DISCORD_BOT_REQUIRE_SSO_ON_INVITE', False) or bot_is_enabled
    global_require_guild = Setting.get_bool('DISCORD_REQUIRE_GUILD_MEMBERSHIP', False)
    
    # Handle dynamic library selection from multiple servers
    if request.method == 'POST':
        # Get all submitted library IDs from the form
        submitted_libraries = request.form.getlist('libraries')
        
        # Use different logic for single vs multi-server invites
        if len(selected_server_ids) == 1:
            # Single server - choices already set above before validation
            pass
        else:
            # Multi-server - build simple UUID-based choices (no prefixes needed)
            try:
                # Since all services now use globally unique library identifiers, we don't need prefixes
                from app.utils.user_library_helpers import get_server_library_choices
                all_choices = []
                for server_id in selected_server_ids:
                    server = media_service_manager.get_server_by_id(server_id)
                    if server:
                        server_choices = get_server_library_choices(server_id, server.service_type.value)
                        all_choices.extend(server_choices)
                
                form.libraries.choices = all_choices
                
                # Validate servers have libraries
                servers_with_no_libs = []
                for server_id in selected_server_ids:
                    server = media_service_manager.get_server_by_id(server_id)
                    if server:
                        from app.models_media_services import MediaLibrary
                        lib_count = MediaLibrary.query.filter_by(server_id=server.id).count()
                        if lib_count == 0:
                            servers_with_no_libs.append(server.server_nickname)
                
                # Show info messages for servers without libraries
                for server_name in servers_with_no_libs:
                    flash(f"Info: Server '{server_name}' has no libraries in database. Use the refresh button to sync from server.", "info")
                    
            except Exception as e:
                current_app.logger.error(f"Failed to set up multi-server library choices: {e}")
                flash("Error: Could not load libraries from database.", "error")
                form.libraries.choices = []
            
            # The frontend now submits libraries in unique format, so we can use them directly
            if submitted_libraries:
                # Remove duplicates from submitted libraries first
                unique_submitted = list(dict.fromkeys(submitted_libraries))  # Preserves order, removes duplicates
                
                # Validate that submitted libraries exist in our available choices
                valid_choices = [choice[0] for choice in form.libraries.choices]
                validated_libraries = []
                
                for submitted_lib_id in unique_submitted:
                    # Skip undefined or malformed library IDs
                    if not submitted_lib_id or 'undefined' in submitted_lib_id:
                        current_app.logger.warning(f"Skipping malformed library ID: {submitted_lib_id}")
                        continue
                    
                    if submitted_lib_id in valid_choices:
                        # Direct match - library ID is valid
                        validated_libraries.append(submitted_lib_id)
                    else:
                        # Double-check against database (all services now use globally unique library identifiers)
                        from app.models_media_services import MediaLibrary
                        
                        library_found = False
                        for server_id in selected_server_ids:
                            server = media_service_manager.get_server_by_id(server_id)
                            if not server:
                                continue
                                
                            # Check if library exists in database for this server
                            if server.service_type.value == 'kavita':
                                # Use internal_id for Kavita
                                db_library = MediaLibrary.query.filter_by(
                                    server_id=server_id
                                ).filter(
                                    MediaLibrary.internal_id == submitted_lib_id
                                ).first()
                            else:
                                # Use external_id for other services
                                db_library = MediaLibrary.query.filter_by(
                                    server_id=server_id,
                                    external_id=submitted_lib_id
                                ).first()
                            
                            if db_library:
                                # Use unique library identifier since all services now have globally unique IDs
                                validated_libraries.append(submitted_lib_id)
                                current_app.logger.info(f"Validated library ID: {submitted_lib_id} from server {server.server_nickname}")
                                library_found = True
                                break
                        
                        if not library_found:
                            current_app.logger.warning(f"Invalid library ID submitted (not found in database for selected servers): {submitted_lib_id}")
                
                form.libraries.data = validated_libraries
        
        # Set the form data for single server case
        if len(selected_server_ids) == 1 and submitted_libraries:
            form.libraries.data = submitted_libraries
            current_app.logger.info(f"Single server invite - Submitted libraries: {submitted_libraries}")
            current_app.logger.info(f"Single server invite - Form choices: {form.libraries.choices}")

    toast_message_text = ""
    toast_category = "info"

    # Set up library choices BEFORE form validation using simple UUID approach
    if selected_server_ids and len(selected_server_ids) > 1:
        # Multi-server invite - combine all libraries (library identifiers are globally unique)
        from app.utils.user_library_helpers import get_server_library_choices
        all_choices = []
        for server_id in selected_server_ids:
            server = media_service_manager.get_server_by_id(server_id)
            if server:
                server_choices = get_server_library_choices(server_id, server.service_type.value)
                all_choices.extend(server_choices)
        form.libraries.choices = all_choices
    elif selected_server_ids and len(selected_server_ids) == 1:
        # Single server - choices already set correctly earlier
        pass
    else:
        # No servers selected - empty choices
        form.libraries.choices = []

    if form.validate_on_submit():
        # Validate that at least one server is selected
        if not selected_server_ids:
            # Add a custom error for server selection
            flash("Please select at least one server to grant access to.", "danger")
            grouped_servers = {}
            for server in all_servers:
                service_type_name = server.service_type.name.capitalize()
                if service_type_name not in grouped_servers:
                    grouped_servers[service_type_name] = []
                grouped_servers[service_type_name].append(server)
            return render_template('invites/_partials/modals/create_invite_modal.html', form=form, grouped_servers=grouped_servers, available_libraries=available_libraries, discord_oauth_enabled=discord_oauth_enabled, global_force_sso=global_force_sso, global_require_guild=global_require_guild), 422
        
        custom_path = form.custom_path.data.strip() if form.custom_path.data else None
        if custom_path:
            existing_invite = Invite.query.filter(Invite.custom_path == custom_path, Invite.is_active == True).first()
            if existing_invite and existing_invite.is_usable:
                error_msg = f"An active and usable invite with the custom path '{custom_path}' already exists."
                form.custom_path.errors.append(error_msg)
                # Need to pass grouped_servers back to the template on error
                grouped_servers = {}
                for server in all_servers:
                    service_type_name = server.service_type.name.capitalize()
                    if service_type_name not in grouped_servers:
                        grouped_servers[service_type_name] = []
                    grouped_servers[service_type_name].append(server)
                return render_template('invites/_partials/modals/create_invite_modal.html', form=form, grouped_servers=grouped_servers, available_libraries=available_libraries, discord_oauth_enabled=discord_oauth_enabled, global_force_sso=global_force_sso, global_require_guild=global_require_guild), 422
        
        # Convert date object to datetime at the end of the selected day
        from datetime import date
        expires_at = datetime.combine(form.expires_at.data, datetime.max.time()) if form.expires_at.data else None
        
        membership_duration = None
        if form.membership_expires_at.data:
            delta = form.membership_expires_at.data - date.today()
            membership_duration = delta.days + 1 # Add 1 to include the current day

        max_uses = form.number_of_uses.data if form.number_of_uses.data and form.number_of_uses.data > 0 else None
        
        new_invite = Invite(
            custom_path=custom_path, expires_at=expires_at, max_uses=max_uses,
            grant_library_ids=form.libraries.data or [],
            allow_downloads=form.allow_downloads.data,
            invite_to_plex_home=form.invite_to_plex_home.data,
            allow_live_tv=form.allow_live_tv.data,
            membership_duration_days=membership_duration, created_by_owner_id=current_user.id,
            require_discord_auth=form.require_discord_auth.data,
            require_discord_guild_membership=form.require_discord_guild_membership.data
            # Removed server_id assignment - now using many-to-many servers relationship
        )
        try:
            db.session.add(new_invite)
            db.session.flush()  # Flush to get the invite ID
            
            # Clear any automatically added servers first
            new_invite.servers.clear()
            
            # Add all selected servers to the invite
            if selected_server_ids:
                for server_id in selected_server_ids:
                    server = media_service_manager.get_server_by_id(server_id)
                    if server and server not in new_invite.servers:
                        new_invite.servers.append(server)
            
            db.session.commit()
            invite_url = new_invite.get_full_url(g.app_base_url or request.url_root.rstrip('/'))
            log_msg_details = f"Downloads: {'Enabled' if new_invite.allow_downloads else 'Disabled'}."
            if new_invite.membership_duration_days: log_msg_details += f" Membership: {new_invite.membership_duration_days} days."
            else: log_msg_details += " Membership: Permanent."
            if hasattr(new_invite, 'force_discord_auth') and new_invite.force_discord_auth is not None: log_msg_details += f" Force Discord Auth: {new_invite.force_discord_auth} (Override)."
            if hasattr(new_invite, 'force_guild_membership') and new_invite.force_guild_membership is not None: log_msg_details += f" Force Guild Membership: {new_invite.force_guild_membership} (Override)."
                
            log_event(EventType.INVITE_CREATED, f"Invite created: Path='{custom_path or new_invite.token}'. {log_msg_details}", invite_id=new_invite.id, admin_id=current_user.id)
            toast_message_text = f"Invite link created successfully!"; toast_category = "success"
            if request.headers.get('HX-Request'):
                response = make_response(""); response.status_code = 204 
                trigger_payload = {"refreshInvitesList": True, "showToastEvent": {"message": toast_message_text, "category": toast_category}}
                response.headers['HX-Trigger-After-Swap'] = json.dumps(trigger_payload)
                return response
            flash(f"Invite link created: {invite_url}", toast_category) 
            return redirect(url_for('invites_admin.list_invites'))
        except Exception as e:
            db.session.rollback(); current_app.logger.error(f"Error creating invite in DB: {e}", exc_info=True)
            toast_message_text = f"Error creating invite: {str(e)[:100]}"; toast_category = "danger"
            if request.headers.get('HX-Request'):
                response = make_response("Error saving invite to database.", 500) 
                response.headers['HX-Trigger-After-Swap'] = json.dumps({"showToastEvent": {"message": toast_message_text, "category": toast_category}})
                return response
            flash(toast_message_text, toast_category); return redirect(url_for('invites_admin.list_invites'))
    else: 
        # Log form validation errors for debugging
        if form.errors:
            current_app.logger.warning(f"Invite form validation failed. Errors: {form.errors}")
            if 'libraries' in form.errors:
                current_app.logger.warning(f"Libraries field error. Submitted data: {form.libraries.data}")
                current_app.logger.warning(f"Available choices: {form.libraries.choices}")
        
        if request.headers.get('HX-Request'):
            grouped_servers = {}
            for server in all_servers:
                service_type_name = server.service_type.name.capitalize()
                if service_type_name not in grouped_servers:
                    grouped_servers[service_type_name] = []
                grouped_servers[service_type_name].append(server)
            return render_template('invites/_partials/modals/create_invite_modal.html', form=form, grouped_servers=grouped_servers, available_libraries=available_libraries, discord_oauth_enabled=discord_oauth_enabled, global_force_sso=global_force_sso, global_require_guild=global_require_guild), 422
        for field, errors_list in form.errors.items():
            for error in errors_list: flash(f"Error in {getattr(form, field).label.text}: {error}", "danger")
        return redirect(url_for('invites_admin.list_invites'))

@invites_bp.route('/toggle-status/<int:invite_id>', methods=['POST'])
@login_required
@setup_required
@permission_required('edit_invites')
def toggle_invite_status(invite_id):
    """Toggle invite active/inactive status"""
    invite = Invite.query.get_or_404(invite_id)
    
    try:
        # Toggle the status
        invite.is_active = not invite.is_active
        db.session.commit()
        
        status_text = "activated" if invite.is_active else "deactivated"
        log_event(EventType.SETTING_CHANGE, f"Invite '{invite.custom_path or invite.token}' (ID: {invite_id}) {status_text} by admin.", invite_id=invite_id, admin_id=current_user.id)
        
        # Return the updated invite card row to match HTMX target
        from datetime import datetime
        from app.services.media_service_manager import MediaServiceManager
        
        now = datetime.now()
        media_service_manager = MediaServiceManager()
        all_servers = media_service_manager.get_all_servers(active_only=True)
        
        # Build library lookup for template using utility function
        from app.utils.user_library_helpers import build_libraries_lookup_for_templates
        _, all_libraries_lookup = build_libraries_lookup_for_templates(all_servers)
        
        # Return just the toggle buttons for HTMX replacement
        response = make_response(render_template('invites/_partials/status_badge.html', invite=invite))
        
        # Trigger multiple updates: status badge and bulk actions
        response.headers['HX-Trigger'] = json.dumps({
            'refreshBulkActions': True,
            'updateStatusBadge': {'inviteId': invite.id, 'isActive': invite.is_active}
        })
        
        return response
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error toggling invite status {invite_id}: {e}")
        return f'<div class="alert alert-error"><span>Error updating invite status: {e}</span></div>', 500

@invites_bp.route('/delete/<int:invite_id>', methods=['DELETE'])
@login_required
@setup_required
@permission_required('delete_invites')
def delete_invite(invite_id):
    invite = Invite.query.get_or_404(invite_id)
    path_or_token = invite.custom_path or invite.token # For logging and toast message
    mum_invite_id_for_log = invite.id # Store before deletion

    try:
        db.session.delete(invite)
        db.session.commit()
        
        log_event(EventType.INVITE_DELETED, 
                  f"Invite '{path_or_token}' deleted.", 
                  invite_id=mum_invite_id_for_log, # Use the stored ID for log
                  admin_id=current_user.id)
        
        toast_message = f"Invite '{path_or_token}' deleted successfully."
        toast_category = "success"
        
        # Prepare headers for HTMX response
        headers = {}
        trigger_payload = {
            "showToastEvent": {"message": toast_message, "category": toast_category},
            "refreshInvitesList": True 
        }
        headers['HX-Trigger'] = json.dumps(trigger_payload)
        
        # HTMX will remove the row based on hx-target and hx-swap="outerHTML".
        # We return an empty response with a 200 OK, and the headers do the work.
        current_app.logger.info(f"Invite '{path_or_token}' deleted. Sending HX-Trigger: {headers['HX-Trigger']}")
        return make_response("", 200, headers)

    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error deleting invite '{path_or_token}': {e}", exc_info=True)
        log_event(EventType.ERROR_GENERAL, 
                  f"Error deleting invite '{path_or_token}': {str(e)}", 
                  invite_id=mum_invite_id_for_log, 
                  admin_id=current_user.id)
        
        toast_message = f"Error deleting invite '{path_or_token}'. Please try again."
        toast_category = "error"
        headers = {}
        trigger_payload = {
            "showToastEvent": {"message": toast_message, "category": toast_category}
        }
        headers['HX-Trigger'] = json.dumps(trigger_payload)
        
        return make_response("", 200, headers) # Still 200, toast will show error

@invites_bp.route('/usages/<int:invite_id>', methods=['GET'])
@login_required
@setup_required
def view_invite_usages(invite_id):
    from app.models import User, UserType, InviteUsage
    invite = Invite.query.get_or_404(invite_id)
    usages = InviteUsage.query.filter_by(invite_id=invite.id).order_by(InviteUsage.used_at.desc()).all()
    return render_template('invites/_partials/modals/usage_modal.html', invite=invite, usages=usages)
