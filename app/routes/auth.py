# File: app/routes/auth.py
import uuid
from flask import Blueprint, render_template, redirect, url_for, flash, request, session, current_app, g
from flask_login import login_user, logout_user, login_required, current_user
from urllib.parse import urlsplit, urljoin, urlencode, quote as url_quote
import datetime 
import time
from app.utils.helpers import log_event
from app.utils.timeout_helper import get_api_timeout
from app.models import User, UserType, Setting, EventType, SettingValueType
from app.forms import LoginForm, UserLoginForm
from app.extensions import db, csrf # <<< IMPORT CSRF
from plexapi.myplex import MyPlexAccount 
from plexapi.exceptions import Unauthorized, NotFound, PlexApiException
from datetime import datetime, timezone, timedelta
from app.utils.plex_auth_helpers import create_plex_pin_login, check_plex_pin_status, get_plex_auth_url
import requests

bp = Blueprint('auth', __name__)

# Removed direct API URLs and headers function - now using plexapi helpers

def is_safe_url(target):
    host_url = urlsplit(request.host_url); redirect_url = urlsplit(urljoin(request.host_url, target))
    return redirect_url.scheme in ('http', 'https') and host_url.netloc == redirect_url.netloc

@bp.route('/auth/login', methods=['GET', 'POST'])
def app_login():
    """Legacy login endpoint - redirects to admin or user login based on situation"""
    if current_user.is_authenticated and getattr(g, 'setup_complete', False):
        # If already logged in, redirect to the appropriate dashboard
        if current_user.userType == UserType.OWNER:
            return redirect('/admin/dashboard')
        else:
            return redirect(url_for('user.index'))
    
    # Check if we're in setup mode
    try:
        if not User.get_owner():
            flash('App setup not complete. Please set up an owner account.', 'warning')
            return redirect(url_for('setup.account_setup'))
    except Exception as e_db:
        current_app.logger.warning(f"Could not query Owner in login: {e_db}")
    
    # Check if user accounts are enabled
    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    
    # Determine where to redirect based on the URL the user was trying to access
    next_page = request.args.get('next')
    
    # If the target URL is related to admin, redirect to admin login
    if next_page and any(admin_area in next_page for admin_area in ['/admin/', '/admin?', '/admin#']):
        return redirect(url_for('auth.admin_login', next=next_page))
    
    # If user accounts are enabled and there's no specific admin next URL, default to user login
    if allow_user_accounts:
        return redirect(url_for('auth.user_login', next=next_page))
    
    # If user accounts are not enabled, redirect to admin login
    return redirect(url_for('auth.admin_login', next=next_page))


@bp.route('/admin', methods=['GET', 'POST'], endpoint='admin_login')
@bp.route('/admin/login', methods=['GET', 'POST'], endpoint='admin_login2')
def admin_login():
    """Admin-specific login endpoint"""
    if current_user.is_authenticated and current_user.userType == UserType.OWNER and getattr(g, 'setup_complete', False):
        return redirect('/admin/dashboard')
    
    # Check if owner account exists for the setup redirect
    try:
        if not User.get_owner():
            flash('App setup not complete. Please set up an owner account.', 'warning')
            return redirect(url_for('setup.account_setup'))
    except Exception as e_db:
        current_app.logger.warning(f"Could not query Owner in admin login: {e_db}")
        # Allow rendering the login page even if DB check fails, it will likely fail on submit anyway
    
    # Check if user accounts are enabled (for displaying the link to user login)
    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    
    # Prepare the login form
    form = LoginForm()

    if form.validate_on_submit():
        # Normalize inputs
        input_username = (form.username.data or '').strip()
        input_password = (form.password.data or '')
        
        # For admin login, only try to find an Owner account
        owner = User.get_by_local_username(input_username)
        if owner and owner.userType != UserType.OWNER:
            owner = None  # Only allow OWNER users to login as admin
        
        if owner and owner.check_password(input_password):
            # Owner login successful
            login_user(owner, remember=True)
            owner.last_login_at = db.func.now()
            db.session.commit()
            log_event(EventType.ADMIN_LOGIN_SUCCESS, f"Owner '{owner.localUsername}' logged in (password).")
            
            # Check if setup is complete, if not redirect to appropriate setup step
            if not getattr(g, 'setup_complete', False):
                try:
                    from app.models_plugins import Plugin
                    
                    enabled_plugins_with_servers = Plugin.query.filter(
                        Plugin.is_enabled == True,
                        Plugin.servers_count > 0
                    ).count()
                    
                    if enabled_plugins_with_servers == 0:
                        flash('Please configure at least one media service to continue.', 'info')
                        return redirect(url_for('setup.plugins'))
                    
                    app_config_done = Setting.get_bool('APP_CONFIG_DONE', False)
                    if not app_config_done:
                        return redirect(url_for('setup.app_config'))
                        
                except Exception as e:
                    current_app.logger.error(f"Error checking setup state: {e}")
                    return redirect(url_for('setup.plugins'))

            next_page = request.args.get('next')
            if not next_page or not is_safe_url(next_page):
                next_page = '/admin/dashboard'
            return redirect(next_page)
        else:
            # Admin login failed
            log_event(EventType.ADMIN_LOGIN_FAIL, f"Failed admin login attempt for username '{input_username}'.")
            flash('Invalid admin username or password.', 'danger')
            
    # Render the admin login template
    return render_template('auth/login_admin.html', title="Admin Login", form=form, allow_user_accounts=allow_user_accounts)


@bp.route('/', methods=['GET', 'POST'], endpoint='user_login')
def user_login():
    """User-specific login endpoint"""
    # If user accounts are not enabled, redirect to admin login
    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    if not allow_user_accounts:
        return redirect(url_for('auth.admin_login'))
        
    if current_user.is_authenticated:
        if current_user.userType == UserType.OWNER:
            # Admin user should be at admin dashboard
            return redirect('/admin/dashboard')
        else:
            # Regular user at user dashboard
            return redirect(url_for('user.index'))
    
    # Check if we're in setup mode
    try:
        if not User.get_owner():
            flash('App setup not complete. Please set up an owner account.', 'warning')
            return redirect(url_for('setup.account_setup'))
    except Exception as e_db:
        current_app.logger.warning(f"Could not query Owner in user login: {e_db}")
    
    # Prepare the login form
    form = UserLoginForm() if hasattr(UserLoginForm, 'username') else LoginForm()

    if form.validate_on_submit():
        # Normalize inputs
        input_username = (form.username.data or '').strip()
        input_password = (form.password.data or '')
        
        # For user login, only try to find a local user account
        user_app_access = None
        
        # First try username
        try:
            from sqlalchemy import func
            user_app_access = User.query.filter(
                User.userType == UserType.LOCAL,
                func.lower(User.localUsername) == func.lower(input_username)
            ).first()
        except Exception:
            user_app_access = User.query.filter_by(
                userType=UserType.LOCAL,
                localUsername=input_username
            ).first()
        
        # Then try email
        if not user_app_access and input_username:
            try:
                user_app_access = User.query.filter(
                    User.userType == UserType.LOCAL,
                    func.lower(User.discord_email) == func.lower(input_username)
                ).first()
            except Exception:
                user_app_access = User.query.filter_by(
                    userType=UserType.LOCAL,
                    discord_email=input_username
                ).first()
        
        if user_app_access and user_app_access.check_password(input_password):
            # Local user login successful
            login_user(user_app_access, remember=True)
            user_app_access.last_login_at = datetime.utcnow()
            user_app_access.updated_at = datetime.utcnow()
            db.session.commit()
            
            log_event(EventType.ADMIN_LOGIN_SUCCESS, f"App user '{user_app_access.localUsername}' logged in.")
            
            next_page = request.args.get('next')
            if not next_page or not is_safe_url(next_page):
                next_page = url_for('user.index')
            return redirect(next_page)
        else:
            # User login failed
            log_event(EventType.ADMIN_LOGIN_FAIL, f"Failed user login attempt for username '{input_username}'.")
            flash('Invalid username or password.', 'danger')
    
    # Render the user login template
    return render_template('auth/login_user.html', title="User Login", form=form)

@bp.route('/plex_sso_admin', methods=['POST'])
def plex_sso_login_admin():
    # Only redirect to dashboard if already logged in AND already linked to Plex.
    # This allows a logged-in, non-linked user to proceed.
    if current_user.is_authenticated and current_user.plex_uuid and getattr(g, 'setup_complete', False):
        return redirect('/admin/dashboard')

    try:
        # Use direct API calls like the working invite flow
        import requests
        from urllib.parse import urlencode
        
        # Generate headers like the sample code
        app_name = Setting.get('APP_NAME', 'MUM')
        client_id = f"MUM-AdminLogin"
        
        # Step 1: Create PIN using direct API call
        pin_response = requests.post(
            "https://plex.tv/api/v2/pins",
            headers={"Accept": "application/json"},
            data={
                "strong": "true",
                "X-Plex-Product": app_name,
                "X-Plex-Client-Identifier": client_id,
            },
        )
        
        if pin_response.status_code != 201:
            raise Exception(f"Failed to create PIN: {pin_response.status_code} - {pin_response.text}")
        
        pin_data = pin_response.json()
        pin_id = pin_data["id"]
        pin_code = pin_data["code"]
        
        current_app.logger.debug(f"Admin PIN creation - PIN code: {pin_code}")
        current_app.logger.debug(f"Admin PIN creation - PIN ID: {pin_id}")
        
        # Store the necessary details for the callback
        session['plex_pin_id_admin_login'] = pin_id
        session['plex_pin_code_admin_login'] = pin_code
        session['plex_client_id_admin_login'] = client_id
        session['plex_app_name_admin_login'] = app_name
        
        # Step 2: Generate auth URL like the sample code
        app_base_url = Setting.get('APP_BASE_URL', request.url_root.rstrip('/'))
        callback_path_segment = url_for('auth.plex_sso_callback_admin', _external=False)
        forward_url_to_our_app = f"{app_base_url.rstrip('/')}{callback_path_segment}"
        
        encoded_params = urlencode({
            "clientID": client_id,
            "code": pin_code,
            "context[device][product]": app_name,
            "forwardUrl": forward_url_to_our_app,
        })
        auth_url_for_user_to_visit = f"https://app.plex.tv/auth#?{encoded_params}"
        
        # If user is already logged in, the "next page" should be their account settings.
        # Otherwise, it's a fresh login, so go to the dashboard.
        if current_user.is_authenticated:
            session['plex_admin_login_next_url'] = url_for('dashboard.account')
        else:
            session['plex_admin_login_next_url'] = request.args.get('next') or '/admin/dashboard'

        return redirect(auth_url_for_user_to_visit)
        
    except Exception as e:
        current_app.logger.error(f"Error initiating Plex PIN for admin login: {e}", exc_info=True)
        flash(f"Could not initiate Plex SSO. Error: {e}", "danger")

    # If an error occurs, send the user back to the most relevant page
    if current_user.is_authenticated:
        return redirect(url_for('dashboard.account'))
    else:
        return redirect(url_for('auth.app_login'))

@bp.route('/plex_sso_callback_admin') 
def plex_sso_callback_admin():
    pin_id_from_session = session.get('plex_pin_id_admin_login')
    pin_code_from_session = session.get('plex_pin_code_admin_login')
    client_id_from_session = session.get('plex_client_id_admin_login')
    
    # Context-aware fallback URL
    fallback_url = url_for('dashboard.account') if current_user.is_authenticated else url_for('auth.app_login')
    
    if not pin_id_from_session or not pin_code_from_session or not client_id_from_session:
        flash('Plex login callback invalid or session expired.', 'danger')
        # Clear session data
        session.pop('plex_pin_id_admin_login', None)
        session.pop('plex_pin_code_admin_login', None)
        session.pop('plex_client_id_admin_login', None)
        session.pop('plex_app_name_admin_login', None)
        return redirect(fallback_url)
    
    try:
        # Use direct API approach exactly like the working invite flow
        import requests
        
        current_app.logger.debug(f"Checking admin PIN status for PIN ID: {pin_id_from_session} (PIN code: {pin_code_from_session})")
        
        # Retry mechanism for OAuth timing issues
        max_retries = 3
        retry_delay = 1  # seconds
        plex_auth_token = None
        
        for attempt in range(max_retries):
            current_app.logger.debug(f"Admin PIN check - Authentication attempt {attempt + 1}/{max_retries}")
            
            try:
                # Make direct API call exactly like the sample code
                headers = {"accept": "application/json"}
                data = {"code": pin_code_from_session, "X-Plex-Client-Identifier": client_id_from_session}
                
                check_url = f"https://plex.tv/api/v2/pins/{pin_id_from_session}"
                timeout = get_api_timeout()
                response = requests.get(check_url, headers=headers, data=data, timeout=timeout)
                
                current_app.logger.debug(f"Admin PIN check - Response status: {response.status_code}")
                
                if response.status_code == 200:
                    pin_data = response.json()
                    current_app.logger.debug(f"Admin PIN check - PIN data: {pin_data}")
                    
                    if pin_data.get('authToken'):
                        plex_auth_token = pin_data['authToken']
                        current_app.logger.info(f"Admin PIN check - Successfully retrieved auth token for PIN {pin_code_from_session}")
                        break
                    else:
                        current_app.logger.debug(f"Admin PIN check - PIN {pin_code_from_session} not yet authenticated (no authToken)")
                else:
                    current_app.logger.warning(f"Admin PIN check - Failed with status {response.status_code}: {response.text[:200]}")
                    
            except Exception as e:
                current_app.logger.error(f"Admin PIN check - Error checking PIN via API: {e}")
                
            if attempt < max_retries - 1:  # Don't sleep on the last attempt
                current_app.logger.debug(f"Admin PIN check - Waiting {retry_delay}s before retry...")
                time.sleep(retry_delay)
        
        if not plex_auth_token:
            current_app.logger.warning(f"Admin PIN check - PIN {pin_code_from_session} not authenticated after {max_retries} attempts")
            flash('Plex PIN not yet linked or has expired.', 'warning')
            return redirect(fallback_url)
        
        plex_account = MyPlexAccount(token=plex_auth_token)
        
        admin_to_update = None
        log_message = ""
        
        # Determine if we're linking an existing account or logging in a new one
        if current_user.is_authenticated:
            admin_to_update = current_user
            log_message = f"Admin '{admin_to_update.localUsername}' linked their Plex account '{plex_account.localUsername}'."
        else:
            # Find Owner by plex_uuid (local users don't have plex_uuid)
            admin_to_update = User.query.filter_by(userType=UserType.OWNER).filter_by(plex_uuid=plex_account.uuid).first()
            log_message = f"Admin '{plex_account.localUsername}' logged in via Plex SSO."
        
        if not admin_to_update:
            flash(f"Plex account '{plex_account.localUsername}' is not a configured admin.", "danger")
            return redirect(fallback_url)
        
        # Check if the returning Plex account is already assigned to a different MUM admin
        if admin_to_update.plex_uuid and admin_to_update.plex_uuid != plex_account.uuid:
             flash("This Plex account is already linked to a different admin.", "danger")
             return redirect(fallback_url)

        # Update the admin record with the latest details from Plex
        admin_to_update.plex_uuid = plex_account.uuid
        admin_to_update.plex_username = plex_account.localUsername
        admin_to_update.plex_thumb = plex_account.thumb
        admin_to_update.email = plex_account.email
        admin_to_update.last_login_at = db.func.now()
        db.session.commit()
        
        login_user(admin_to_update, remember=True)
        log_event(EventType.ADMIN_LOGIN_SUCCESS, log_message, admin_id=admin_to_update.id)
        
        next_url = session.pop('plex_admin_login_next_url', '/admin/dashboard')
        if not is_safe_url(next_url):
            next_url = fallback_url
        
        # Clean up session
        session.pop('plex_pin_id_admin_login', None)
        session.pop('plex_pin_code_admin_login', None)
        session.pop('plex_client_id_admin_login', None)
        session.pop('plex_app_name_admin_login', None)

        return redirect(next_url)

    except PlexApiException as e_plex:
        flash(f'Plex API error: {str(e_plex)}', 'danger')
        current_app.logger.error(f"Plex admin callback PlexApiException: {e_plex}", exc_info=True)
    except Exception as e:
        current_app.logger.error(f"Error during Plex admin callback: {e}", exc_info=True)
        flash(f'An unexpected error occurred: {e}', 'danger')
    
    # Cleanup session and redirect on error
    session.pop('plex_pin_id_admin_login', None)
    session.pop('plex_pin_code_admin_login', None)
    session.pop('plex_headers_admin_login', None)
    return redirect(fallback_url)

@bp.route('/logout')
@login_required
def logout():
    # Store user type before logout to determine redirect
    is_admin = current_user.userType == UserType.OWNER
    
    # Handle Owner and local user objects only
    if current_user.userType == UserType.OWNER:
        # Owner
        user_name = current_user.localUsername
        log_event(EventType.ADMIN_LOGOUT, f"Owner '{user_name}' logged out.")
    elif current_user.userType == UserType.LOCAL:
        # Local user
        user_name = current_user.localUsername
        log_event(EventType.ADMIN_LOGOUT, f"App user '{user_name}' logged out.")
    else:
        # Unknown user type
        user_name = getattr(current_user, 'username', 'Unknown')
        log_event(EventType.ADMIN_LOGOUT, f"Unknown user type '{user_name}' logged out.")
    
    logout_user()
    flash('You have been logged out.', 'success')
    
    # Redirect to appropriate login page based on user type
    if is_admin:
        return redirect(url_for('auth.admin_login'))
    else:
        # Check if user accounts are enabled
        allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
        if allow_user_accounts:
            return redirect(url_for('auth.user_login'))
        else:
            # If user accounts are disabled, redirect to admin login
            return redirect(url_for('auth.admin_login'))

@bp.route('/logout_setup')
def logout_setup():
    # ... (same)
    if current_user.is_authenticated:
        admin_name = current_user.localUsername or current_user.plex_username
        log_event(EventType.ADMIN_LOGOUT, f"Admin '{admin_name}' logged out during setup.", admin_id=current_user.id)
        logout_user()
    session.clear(); flash('Logged out of setup.', 'info'); return redirect(url_for('setup.account_setup'))

        

DISCORD_API_BASE_URL = 'https://discord.com/api/v10'

@bp.route('/discord/link_admin', methods=['POST'])
@login_required
def discord_link_admin():
    current_app.logger.info("--- discord_link_admin CALLED (CSRF Exempted for Test) ---") # New log
    enabled_setting_val = Setting.get('DISCORD_OAUTH_ENABLED', False)
    client_id_val = Setting.get('DISCORD_CLIENT_ID')
    client_secret_val = Setting.get('DISCORD_CLIENT_SECRET') 
    app_base_url_val = Setting.get('APP_BASE_URL')

    current_app.logger.info(f"Retrieved DISCORD_OAUTH_ENABLED: {enabled_setting_val} (Type: {type(enabled_setting_val)})")
    current_app.logger.info(f"Retrieved DISCORD_CLIENT_ID: '{client_id_val}'")
    current_app.logger.info(f"Retrieved DISCORD_CLIENT_SECRET: '{client_secret_val}'")
    current_app.logger.info(f"Retrieved APP_BASE_URL: '{app_base_url_val}'")

    discord_enabled_for_invitees = False
    if isinstance(enabled_setting_val, bool):
        discord_enabled_for_invitees = enabled_setting_val
    else:
        discord_enabled_for_invitees = str(enabled_setting_val).lower() == 'true'

    if not discord_enabled_for_invitees:
        flash('Discord OAuth for Invitees must be enabled and configured before linking your admin account.', 'warning')
        return redirect(url_for('settings.discord'))

    # The flash message you saw "Discord Client ID and Secret are required if enabled."
    # does not come from this route. It comes from dashboard.settings_discord on *saving* that form.
    # This route checks client_id and app_base_url for initiating the link.
    # The client_secret is only needed in the callback.
    if not client_id_val or not app_base_url_val: 
        flash_msg = "Discord configuration is incomplete for linking. Required: "
        missing = []
        if not client_id_val: missing.append("Client ID (Save in Discord Settings first)")
        if not app_base_url_val: missing.append("Application Base URL (Save in App URL Settings first)")
        flash(flash_msg + ", ".join(missing) + ".", "danger")
        return redirect(url_for('dashboard.settings_discord'))
    
    # Client secret is NOT needed to initiate the OAuth flow with Discord, only in the callback.
    # So, the check for client_secret_val here was likely causing the redirect if it was failing.
    # The original flash message "Discord Client ID and Secret are required if enabled." is from the other route.

    redirect_uri = url_for('auth.discord_callback_admin', _external=True)
    Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', redirect_uri, SettingValueType.STRING, "Discord OAuth Admin Link Redirect URI (auto-set)") # This is fine

    session['discord_oauth_state_admin_link'] = str(uuid.uuid4())
    
    params = {
        'client_id': client_id_val, # Use the value retrieved from settings
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': 'identify email guilds.join', 
        'state': session['discord_oauth_state_admin_link'],
        'prompt': 'consent' 
    }
    discord_auth_url = f"{DISCORD_API_BASE_URL}/oauth2/authorize?{urlencode(params)}"
    return redirect(discord_auth_url)

@bp.route('/discord/callback_admin')
@login_required
def discord_callback_admin():
    returned_state = request.args.get('state')
    if not returned_state or returned_state != session.pop('discord_oauth_state_admin_link', None):
        flash('Discord linking failed: Invalid state.', 'danger')
        return redirect(url_for('settings.discord'))
    
    code = request.args.get('code')
    if not code:
        flash(f'Discord linking failed: {request.args.get("error_description", "No code.")}', 'danger')
        return redirect(url_for('settings.discord'))

    client_id = Setting.get('DISCORD_CLIENT_ID')
    client_secret = Setting.get('DISCORD_CLIENT_SECRET')
    redirect_uri = Setting.get('DISCORD_REDIRECT_URI_ADMIN_LINK')

    if not client_id or not client_secret or not redirect_uri:
        flash('Discord app details not fully configured in MUM settings.', 'danger')
        return redirect(url_for('dashboard.settings_discord'))

    token_url = f"{DISCORD_API_BASE_URL}/oauth2/token"
    payload = {
        'client_id': client_id, 'client_secret': client_secret, 
        'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect_uri
    }
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}

    try:
        token_response = requests.post(token_url, data=payload, headers=headers)
        token_response.raise_for_status()
        token_data = token_response.json()
        
        access_token = token_data['access_token']
        refresh_token = token_data.get('refresh_token') # May not always be present
        expires_in = token_data['expires_in']
        token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

        user_info_url = f"{DISCORD_API_BASE_URL}/users/@me"
        auth_headers = {'Authorization': f'Bearer {access_token}'}
        user_response = requests.get(user_info_url, headers=auth_headers)
        user_response.raise_for_status()
        discord_user = user_response.json()

        # Ensure we are working with the correct admin account instance from the DB
        admin_to_update = current_user
        if not admin_to_update:
            # Should not happen if @login_required is working
            flash('Admin account not found. Please log in again.', 'danger')
            return redirect(url_for('auth.app_login'))

        # Check if this Discord ID is already linked to a *different* user account
        existing_owner = User.query.filter_by(userType=UserType.OWNER).filter(
            User.id != admin_to_update.id,
            User.discord_user_id == discord_user['id']
        ).first()
        existing_user = User.query.filter_by(userType=UserType.LOCAL).filter(
            User.id != admin_to_update.id,
            User.discord_user_id == discord_user['id']
        ).first()
        existing_link = existing_owner or existing_user

        if existing_link:
            flash(f"Discord account '{discord_user['username']}' is already linked to another admin account ({existing_link.localUsername or existing_link.plex_username}).", 'danger')
            return redirect(url_for('settings.discord'))

        admin_to_update.discord_user_id = discord_user['id']
        admin_to_update.discord_username = discord_user['username']
        if discord_user.get('discriminator') and discord_user.get('discriminator') != '0':
            admin_to_update.discord_username = f"{discord_user['username']}#{discord_user['discriminator']}"
        admin_to_update.discord_avatar_hash = discord_user.get('avatar')
        admin_to_update.discord_email = discord_user.get('email') # NEW
        admin_to_update.discord_email_verified = discord_user.get('verified') # NEW
        admin_to_update.discord_access_token = access_token
        admin_to_update.discord_refresh_token = refresh_token
        admin_to_update.discord_token_expires_at = token_expires_at
        
        db.session.commit()
        current_app.logger.info(f"ADMIN DISCORD LINK: User {admin_to_update.id} Discord ID {admin_to_update.discord_user_id} committed to DB.")
        
        # --- KEY CHANGE: Re-login the user to refresh the session's user object ---
        # Fetch the updated user from the database to ensure all fields are current
        if admin_to_update.userType == UserType.OWNER:
            fresh_user = User.query.filter_by(userType=UserType.OWNER).get(admin_to_update.id)
        else:
            fresh_user = User.query.filter_by(userType=UserType.LOCAL).get(admin_to_update.id)
            
        if fresh_user:
            # Flask-Login's login_user function will update the user in the session
            login_user(fresh_user, remember=current_user.is_remembered if hasattr(current_user, 'is_remembered') else True) 
            current_app.logger.info(f"DISCORD LINK: User {fresh_user.id} re-logged in to refresh session data.")
        else:
            # This would be very unusual if the commit succeeded
            current_app.logger.error(f"DISCORD LINK: Could not re-fetch user {admin_to_update.id} after commit for re-login.")
        # --- END KEY CHANGE ---

        log_event(EventType.DISCORD_ADMIN_LINK_SUCCESS, f"Admin '{admin_to_update.localUsername or admin_to_update.plex_username}' linked Discord '{admin_to_update.discord_username}'.", admin_id=admin_to_update.id)
        flash('Discord account linked successfully!', 'success')

    except requests.exceptions.RequestException as e:
        error_detail = str(e)
        if e.response is not None:
            try:
                error_detail = e.response.json().get('error_description', str(e.response.text))
            except: # Fallback if response is not JSON
                error_detail = str(e.response.content) 
        current_app.logger.error(f"Discord OAuth admin error: {error_detail}", exc_info=True if not isinstance(e, requests.exceptions.HTTPError) else False)
        flash(f'Failed to link Discord: {error_detail}', 'danger')
    except Exception as e_gen: # Catch any other unexpected errors
        current_app.logger.error(f"Unexpected error during Discord admin link callback: {e_gen}", exc_info=True)
        flash('An unexpected error occurred while linking Discord.', 'danger')
        
    return redirect(url_for('settings.discord'))

@bp.route('/discord/unlink_admin', methods=['POST'])
@login_required
def discord_unlink_admin():
    discord_username_log = current_user.discord_username
    current_user.discord_user_id = None; current_user.discord_username = None; current_user.discord_avatar_hash = None
    current_user.discord_access_token = None; current_user.discord_refresh_token = None; current_user.discord_token_expires_at = None
    db.session.commit()
    log_event(EventType.DISCORD_ADMIN_UNLINK, f"Admin '{current_user.localUsername or current_user.plex_username}' unlinked Discord '{discord_username_log}'.", admin_id=current_user.id)
    flash('Discord account unlinked.', 'success'); return redirect(url_for('settings.discord'))
