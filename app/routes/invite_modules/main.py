"""
Core invite functionality - Public invite processing and main routes
"""

import uuid
from flask import render_template, redirect, url_for, flash, request, current_app, session, g
from markupsafe import Markup
from datetime import datetime, timezone
from app.utils.timezone_utils import utcnow
from urllib.parse import urlencode, quote as url_quote, urlparse, parse_qs, urlunparse 
from flask_login import current_user
from app.models import User, UserType, Invite, Setting, EventType
from app.extensions import db
from app.utils.helpers import log_event, setup_required
from app.services.media_service_factory import MediaServiceFactory
from app.services.media_service_manager import MediaServiceManager
from . import invites_public_bp as invites_bp

# Add DISCORD_API_BASE_URL constant
DISCORD_API_BASE_URL = 'https://discord.com/api/v10'

@invites_bp.route('/invite/<invite_path_or_token>', methods=['GET', 'POST'])
@setup_required 
def process_invite_form(invite_path_or_token):
    from flask_wtf import FlaskForm
    from app.services import invite_service
    invite, error_message_from_validation = invite_service.validate_invite_usability(invite_path_or_token)
    
    if request.method == 'GET' and not error_message_from_validation and invite:
        log_event(EventType.INVITE_VIEWED, f"Invite '{invite.custom_path or invite.token}' (ID: {invite.id}) viewed/accessed.", invite_id=invite.id)

    if error_message_from_validation: 
        return render_template('invite/steps/index.html', error=error_message_from_validation, invite=None, form=FlaskForm(), discord_sso_is_mandatory=False, show_discord_button=False)

    if not invite:
        flash("The invite link is invalid or no longer available.", "danger")
        return redirect(url_for('invites.invite_landing_page'))

    form_instance = FlaskForm()
    already_authenticated_plex_user_info = session.get(f'invite_{invite.id}_plex_user')
    already_authenticated_discord_user_info = session.get(f'invite_{invite.id}_discord_user')
    plex_conflict_info = session.get(f'invite_{invite.id}_plex_conflict')
    
    # --- MODIFIED: Determine effective Discord settings using invite fields ---
    oauth_is_generally_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    
    effective_require_sso = invite.require_discord_auth
    effective_require_guild = invite.require_discord_guild_membership

    # These settings are fetched for display purposes if guild membership is required
    setting_discord_guild_id = Setting.get('DISCORD_GUILD_ID')
    setting_discord_server_invite_url = Setting.get('DISCORD_SERVER_INVITE_URL')
    show_discord_button = oauth_is_generally_enabled
    
    # Get server name for display
    server_name = g.app_name or 'the server'

    # Get all servers for template logic
    media_service_manager = MediaServiceManager()
    all_servers = media_service_manager.get_all_servers(active_only=True)
    
    # Check if there are Plex servers in the invite (needed early for validation)
    has_plex_servers = any(server.service_type.name.upper() == 'PLEX' for server in invite.servers)
    
    # Get library information for each server in the invite
    servers_with_libraries = {}
    if invite and invite.servers:
        for server in invite.servers:
            try:
                service = MediaServiceFactory.create_service_from_db(server)
                if service:
                    libraries = service.get_libraries()
                    servers_with_libraries[server.id] = {
                        'server': server,
                        'libraries': {lib.get('external_id'): lib['name'] for lib in libraries if lib.get('external_id')}
                    }
            except Exception as e:
                current_app.logger.error(f"Failed to fetch libraries for server {server.server_nickname}: {e}")
                servers_with_libraries[server.id] = {'server': server, 'libraries': {}}
    
    # Check if user accounts are enabled
    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    user_account_created = session.get(f'invite_{invite.id}_user_account_created', False)
    
    # Create user account form if needed
    account_form = None
    if allow_user_accounts:
        from app.forms import UserAccountCreationForm
        account_form = UserAccountCreationForm()

    if request.method == 'POST':
        auth_method = request.form.get('auth_method')
        action_taken = request.form.get('action')
        
        # Handle Plex conflict resolution
        if action_taken == 'link_plex_account' and plex_conflict_info and plex_conflict_info.get('type') == 'can_link':
            # User chose to link existing Plex account to local account
            # Clear the conflict and set the Plex user info to proceed
            plex_user_data = {
                'username': plex_conflict_info['plex_username'],
                'email': plex_conflict_info['plex_email'],
                # We'll need to get the full Plex account info again
            }
            session[f'invite_{invite.id}_plex_user'] = plex_user_data
            session.pop(f'invite_{invite.id}_plex_conflict', None)
            flash(f"Plex account '{plex_conflict_info['plex_username']}' will be linked to your local account.", "success")
            current_app.logger.info(f"User chose to link existing Plex account {plex_conflict_info['plex_username']}")
            
        elif action_taken == 'use_different_plex' and plex_conflict_info:
            # User chose to use a different Plex account
            session.pop(f'invite_{invite.id}_plex_conflict', None)
            session.pop(f'invite_{invite.id}_plex_user', None)
            flash("Please authenticate with a different Plex account.", "info")
            current_app.logger.info(f"User chose to use different Plex account instead of {plex_conflict_info['plex_username']}")
            
        # Handle user account creation if enabled (MODIFIED: Store form data in session instead of creating account)
        elif action_taken == 'create_user_account' and allow_user_accounts:
            from app.forms import UserAccountCreationForm
            
            account_form = UserAccountCreationForm()
            if account_form.validate_on_submit():
                # Store account creation data in session for later use
                session[f'invite_{invite.id}_user_account_data'] = {
                    'username': account_form.username.data,
                    'email': account_form.email.data,
                    'password': account_form.password.data
                }
                
                # Store cross-server credential preferences
                use_same_username = request.form.get('use_same_username') == 'true'
                use_same_password = request.form.get('use_same_password') == 'true'
                
                session[f'invite_{invite.id}_cross_server_prefs'] = {
                    'use_same_username': use_same_username,
                    'use_same_password': use_same_password
                }
                
                # Mark account step as completed (but not actually created yet)
                session[f'invite_{invite.id}_user_account_created'] = True
                
                flash("Account information saved! Please continue with the authentication steps.", "success")
                current_app.logger.info(f"User account data stored in session for invite {invite.id}, username: {account_form.username.data}")
                current_app.logger.info(f"Cross-server preferences: same_username={use_same_username}, same_password={use_same_password}")
                    
            else:
                # Form validation failed, show errors
                for field, errors in account_form.errors.items():
                    for error in errors:
                        flash(f"{getattr(account_form, field).label.text}: {error}", "error")
        
        elif auth_method == 'plex':
            return redirect(url_for('invites.initiate_plex_auth', invite_id=invite.id))
        
        elif auth_method == 'discord':
            return redirect(url_for('invites.initiate_discord_auth', invite_id=invite.id))

        elif action_taken == 'setup_server_access':
            # Store server-specific credentials in session for later use
            current_server_id = request.form.get('current_server_id')
            if current_server_id:
                # Store the username and password for this specific server
                server_credentials = {
                    'username': request.form.get('jellyfin_username', ''),
                    'password': request.form.get('jellyfin_password', ''),
                    'email': request.form.get('jellyfin_email', '')  # In case email field is added
                }
                
                # Store server-specific credentials
                session[f'invite_{invite.id}_server_{current_server_id}_credentials'] = server_credentials
                session[f'invite_{invite.id}_server_{current_server_id}_completed'] = True
                
                current_app.logger.info(f"Stored credentials for server {current_server_id}: username={server_credentials['username']}")
                flash("Server configuration saved. Complete all steps to create accounts.", "success")
            else:
                flash("No server specified for setup.", "error")

        elif action_taken == 'accept_invite':
            # This is now the "All Servers Configured" step - create local account and all service accounts together
            if not already_authenticated_plex_user_info and has_plex_servers: 
                flash("Please sign in with Plex first to accept the invite.", "warning")
            elif effective_require_sso and not already_authenticated_discord_user_info: 
                flash("Discord account linking is required for this invite. Please link your Discord account.", "warning")
            elif allow_user_accounts and not session.get(f'invite_{invite.id}_user_account_data'):
                flash("Please complete the account setup step first.", "warning")
            else:
                # Create local user account from stored session data if needed
                user_app_access = None
                
                # Check if we have stored user account data to create
                user_account_data = session.get(f'invite_{invite.id}_user_account_data')
                if user_account_data and allow_user_accounts:
                    try:
                        # Create the local user account now
                        user_app_access = User(
                            userType=UserType.LOCAL,
                            localUsername=user_account_data['username'],
                            email=user_account_data['email'],
                            created_at=utcnow(),
                            used_invite_id=invite.id
                        )
                        user_app_access.set_password(user_account_data['password'])
                        db.session.add(user_app_access)
                        db.session.flush()  # Get the ID without committing yet
                        
                        current_app.logger.info(f"Created local user account '{user_account_data['username']}' for invite {invite.id}")
                        log_event(EventType.MUM_USER_ADDED_FROM_PLEX, f"Local user account '{user_account_data['username']}' created via invite {invite.id}", invite_id=invite.id)
                        
                    except Exception as e:
                        db.session.rollback()
                        current_app.logger.error(f"Error creating local user account for invite {invite.id}: {e}")
                        flash("Error creating your account. Please try again.", "error")
                        return redirect(url_for('invites.process_invite_form', invite_path_or_token=invite_path_or_token))
                
                current_app.logger.debug(f"Invite acceptance - User app access: {user_app_access.localUsername if user_app_access else 'None'}")
                current_app.logger.debug(f"Invite acceptance - Session keys: {list(session.keys())}")
                
                success, result_object_or_message = invite_service.accept_invite_and_grant_access(
                    invite=invite, 
                    plex_user_uuid=already_authenticated_plex_user_info.get('uuid') if already_authenticated_plex_user_info else None, 
                    plex_username=already_authenticated_plex_user_info.get('username') if already_authenticated_plex_user_info else None, 
                    plex_email=already_authenticated_plex_user_info.get('email') if already_authenticated_plex_user_info else None, 
                    plex_thumb=already_authenticated_plex_user_info.get('thumb') if already_authenticated_plex_user_info else None, 
                    # Pass the entire dictionary as a single argument
                    discord_user_info=already_authenticated_discord_user_info, 
                    ip_address=request.remote_addr,
                    app_user=user_app_access
                )
                if success: 
                    # Clear session data
                    session.pop(f'invite_{invite.id}_plex_user', None)
                    session.pop(f'invite_{invite.id}_discord_user', None)
                    session.pop(f'invite_{invite.id}_app_user_id', None)
                    session.pop(f'invite_{invite.id}_user_account_created', None)
                    session.pop(f'invite_{invite.id}_user_account_data', None)  # Clear stored account data
                    
                    # Clear server completion flags and credentials
                    for server in invite.servers:
                        session.pop(f'invite_{invite.id}_server_{server.id}_completed', None)
                        session.pop(f'invite_{invite.id}_server_{server.id}_credentials', None)
                    
                    username = user_app_access.localUsername if user_app_access else (already_authenticated_plex_user_info.get('username') if already_authenticated_plex_user_info else 'User')
                    flash(f"Welcome, {username}! All accounts have been created and linked successfully.", "success")
                    return redirect(url_for('invites.invite_success', username=username))
                else: 
                    flash(f"Failed to accept invite: {result_object_or_message}", "danger")
        
        return redirect(url_for('invites.process_invite_form', invite_path_or_token=invite_path_or_token))

    # Determine if we should use the steps-based template
    # Use steps if:
    # - User accounts are enabled (account creation needs to be step 1)
    # - Discord OAuth is enabled 
    # - Multiple servers are available in this invite
    has_multiple_servers_available = len(invite.servers) > 1
    
    # has_plex_servers already defined earlier for validation
    
    # Get cross-server preferences from session
    cross_server_prefs = session.get(f'invite_{invite.id}_cross_server_prefs', {})
    use_same_username = cross_server_prefs.get('use_same_username', False)
    use_same_password = cross_server_prefs.get('use_same_password', False)
    
    # Get user account data for default username
    user_account_data = session.get(f'invite_{invite.id}_user_account_data', {})
    local_username = user_account_data.get('username', '')
    
    # Generate invite steps for progress indicator
    invite_steps = []
    current_step = None
    
    # Step 1: User Account Creation (if enabled)
    if allow_user_accounts:
        invite_steps.append({
            'id': 'user_account',
            'name': 'Account Details',
            'icon': 'fa-solid fa-user-plus',
            'required': True,
            'completed': user_account_created
        })
    
    # Step 2: Discord Authentication (if required)
    if show_discord_button:
        invite_steps.append({
            'id': 'discord',
            'name': 'Discord Login',
            'icon': 'fa-brands fa-discord',
            'required': effective_require_sso,
            'completed': already_authenticated_discord_user_info is not None
        })
    
    # Step 3: Plex Authentication (if there are Plex servers)
    if has_plex_servers:
        # Get the first Plex server name for the step title
        plex_server = next((server for server in invite.servers if server.service_type.name.upper() == 'PLEX'), None)
        plex_server_name = plex_server.server_nickname if plex_server else 'Plex'
        
        invite_steps.append({
            'id': 'plex',
            'name': f'{plex_server_name} Access',
            'icon': 'fa-solid fa-right-to-bracket',
            'required': True,
            'completed': already_authenticated_plex_user_info is not None
        })
    
    # Step 4+: Server Access Steps (for non-Plex servers)
    # Sort servers to prioritize those without username conflicts
    non_plex_servers = [s for s in invite.servers if s.service_type.name.upper() != 'PLEX']
    
    # Check for username conflicts if using same username
    username_conflicts = {}
    if use_same_username and local_username:
        for server in non_plex_servers:
            try:
                service = MediaServiceFactory.create_service_from_db(server)
                if hasattr(service, 'check_username_exists'):
                    username_exists = service.check_username_exists(local_username)
                    username_conflicts[server.id] = username_exists
                    current_app.logger.info(f"Username '{local_username}' exists on {server.server_nickname}: {username_exists}")
            except Exception as e:
                current_app.logger.warning(f"Could not check username on {server.server_nickname}: {e}")
                username_conflicts[server.id] = False
    
    # Sort servers: non-conflicting first, then conflicting
    def server_sort_key(server):
        has_conflict = username_conflicts.get(server.id, False)
        return (has_conflict, server.server_nickname)  # False sorts before True
    
    sorted_non_plex_servers = sorted(non_plex_servers, key=server_sort_key)
    
    for server in sorted_non_plex_servers:
        step_id = f'server_access_{server.id}'
        server_completed = session.get(f'invite_{invite.id}_server_{server.id}_completed', False)
        invite_steps.append({
            'id': step_id,
            'name': f'{server.server_nickname} Access',
            'icon': 'fa-solid fa-server',
            'required': True,
            'completed': server_completed,
            'server_id': server.id,
            'server_name': server.server_nickname,
            'server_type': server.service_type.name.upper()
        })
        
        # Set current step if this server setup is not completed
        if not server_completed and current_step is None:
            # Check if prerequisites are met
            discord_ready = not show_discord_button or already_authenticated_discord_user_info
            plex_ready = not has_plex_servers or already_authenticated_plex_user_info
            account_ready = not allow_user_accounts or user_account_created
            
            if discord_ready and plex_ready and account_ready:
                current_step = invite_steps[-1]  # Set this as current step
    
    # Always use the steps template for a consistent, modern design
    # The steps template handles all scenarios properly (user accounts disabled, single server, etc.)
    
    # Prepare template variables for current step
    server_username_taken = False
    preferred_username = ""
    default_username = ""
    
    if current_step and current_step.get('server_id'):
        server_id = current_step['server_id']
        server_username_taken = username_conflicts.get(server_id, False)
        
        # Determine default username
        if use_same_username and local_username:
            preferred_username = local_username
            default_username = local_username if not server_username_taken else ""
        elif already_authenticated_plex_user_info:
            default_username = already_authenticated_plex_user_info.get('username', '')
        
    return render_template('invite/steps/index.html', 
                           form=form_instance, 
                           invite=invite, 
                           error=None,
                           invite_path_or_token=invite_path_or_token, 
                           # Pass the effective values to the template
                           discord_sso_is_mandatory=effective_require_sso,
                           setting_require_guild_membership=effective_require_guild,
                           show_discord_button=show_discord_button,
                           already_authenticated_plex_user=already_authenticated_plex_user_info, 
                           already_authenticated_discord_user=already_authenticated_discord_user_info,
                           setting_discord_guild_id=setting_discord_guild_id,
                           setting_discord_server_invite_url=setting_discord_server_invite_url,
                           server_name=server_name,
                           allow_user_accounts=allow_user_accounts,
                           user_account_created=user_account_created,
                           account_form=account_form,
                           servers_with_libraries=servers_with_libraries,
                           # Add missing variables
                           has_plex_servers=has_plex_servers,
                           invite_steps=invite_steps,
                           current_step=current_step,
                           # Cross-server credential variables
                           use_same_username=use_same_username,
                           use_same_password=use_same_password,
                           server_username_taken=server_username_taken,
                           preferred_username=preferred_username,
                           default_username=default_username,
                           # Plex conflict variables
                           plex_conflict_info=plex_conflict_info
                           )

@invites_bp.route('/success') # Path is /invites/success
@setup_required 
def invite_success():
    username = request.args.get('username', 'there')
    servers = request.args.get('servers', '')
    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    
    # Parse server names and determine service types
    server_list = [s.strip() for s in servers.split(',') if s.strip()] if servers else []
    
    # Get server information from the database to determine service types
    media_service_manager = MediaServiceManager()
    all_servers = media_service_manager.get_all_servers(active_only=True)
    
    configured_servers = []
    has_plex = False
    has_jellyfin = False
    has_other = False
    
    for server_name in server_list:
        # Find the server in the database
        server = next((s for s in all_servers if s.server_nickname == server_name), None)
        if server:
            configured_servers.append({
                'name': server.server_nickname,
                'type': server.service_type.name.upper(),
                'url': get_server_url(server)
            })
            
            if server.service_type.name.upper() == 'PLEX':
                has_plex = True
            elif server.service_type.name.upper() == 'JELLYFIN':
                has_jellyfin = True
            else:
                has_other = True
    
    return render_template('invite/steps/_success.html', 
                         username=username, 
                         configured_servers=configured_servers,
                         has_plex=has_plex,
                         has_jellyfin=has_jellyfin,
                         has_other=has_other,
                         allow_user_accounts=allow_user_accounts)

@invites_bp.route('/') # Defines the base /invites/ path
@setup_required 
def invite_landing_page(): # Renamed from placeholder
    flash("Please use a specific invite link.", "info")
    if current_user.is_authenticated: 
        return redirect(url_for('dashboard.index'))
    # If not authenticated and no specific invite, perhaps redirect to admin login or a generic info page
    return redirect(url_for('auth.app_login'))

@invites_bp.route('/invite/', methods=['GET', 'POST'])
@setup_required
def invite_code_entry():
    """Landing page where users can enter their invite code"""
    from flask_wtf import FlaskForm
    from wtforms import StringField, SubmitField
    from wtforms.validators import DataRequired, Length
    from app.services import invite_service
    
    class InviteCodeForm(FlaskForm):
        invite_code = StringField('Invite Code', 
                                validators=[DataRequired(), Length(min=1, max=100)],
                                render_kw={"placeholder": "Enter your invite code", "class": "input input-bordered w-full"})
        submit = SubmitField('Access Invite', render_kw={"class": "btn btn-primary w-full"})
    
    form = InviteCodeForm()
    error_message = None
    
    if form.validate_on_submit():
        invite_code = form.invite_code.data.strip()
        
        # Validate the invite code before redirecting
        invite, error_message_from_validation = invite_service.validate_invite_usability(invite_code)
        
        if error_message_from_validation or not invite:
            # Invalid invite - show error message and stay on the page
            error_message = error_message_from_validation or "Invalid invite code. Please check your code and try again."
        else:
            # Valid invite - redirect to the invite process
            return redirect(url_for('invites.process_invite_form', invite_path_or_token=invite_code))
    
    return render_template('invite/index.html', form=form, error_message=error_message) 

def get_server_url(server):
    """Get the appropriate URL for a server based on its type"""
    if server.service_type.name.upper() == 'PLEX':
        return "https://app.plex.tv"
    elif server.service_type.name.upper() == 'JELLYFIN':
        return server.url
    elif server.service_type.name.upper() == 'EMBY':
        return server.url
    else:
        return server.url