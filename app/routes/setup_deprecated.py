"""DEPRECATED: SSR setup flows replaced by SPA + API v2.

This module previously provided SSR routes for account/app/discord setup and
Plex SSO callbacks. The SPA now serves UI under /setup/ui and API v2 under
/api/v2 handles setup-related actions. Keep only for historical reference.
"""
import uuid
from flask import Blueprint, render_template, redirect, url_for, flash, request, current_app, session, g
from flask_login import login_user, logout_user, current_user, login_required
from plexapi.exceptions import Unauthorized, NotFound, PlexApiException
from plexapi.myplex import MyPlexAccount 
import secrets
import urllib.parse 
from app.models import User, UserType, Setting, EventType, SettingValueType
from app.forms import AccountSetupForm, AppBaseUrlForm, DiscordConfigForm
from app.extensions import db
from sqlalchemy import inspect
from app.utils.helpers import log_event
from app.utils.plex_auth_helpers_deprecated import create_plex_pin_login, check_plex_pin_status, get_plex_auth_url

bp = Blueprint('setup', __name__)

# Removed direct API URLs and headers function - now using plexapi helpers

def get_completed_steps():
    completed = set()
    owner_table_exists_steps = False
    try:
        inspector = inspect(db.engine)
        owner_table_exists_steps = inspector.has_table(User.__tablename__)
    except Exception as e:
        current_app.logger.error(f"DB inspection error in get_completed_steps: {e}")
    if owner_table_exists_steps and User.get_owner(): completed.add('account')
    if Setting.get('APP_BASE_URL'): completed.add('app')
    
    # Check if plugins have been configured (enabled AND have servers)
    from app.services.plugin_manager import plugin_manager
    from app.models_plugins import Plugin, PluginStatus
    enabled_plugins_with_servers = Plugin.query.filter(
        Plugin.status == PluginStatus.ENABLED,
        Plugin.servers_count > 0
    ).all()
    if enabled_plugins_with_servers: completed.add('plugins')
    
    discord_enabled_setting_val = Setting.get('DISCORD_OAUTH_ENABLED') # Can be bool or string default
    if discord_enabled_setting_val is not None:
        is_discord_truly_disabled = (isinstance(discord_enabled_setting_val, bool) and not discord_enabled_setting_val) or \
                                    (isinstance(discord_enabled_setting_val, str) and discord_enabled_setting_val.lower() == 'false')
        is_discord_configured_if_enabled = Setting.get('DISCORD_CLIENT_ID') and Setting.get('DISCORD_CLIENT_SECRET')
        is_discord_truly_enabled = (isinstance(discord_enabled_setting_val, bool) and discord_enabled_setting_val) or \
                                   (isinstance(discord_enabled_setting_val, str) and discord_enabled_setting_val.lower() == 'true')

        if is_discord_truly_disabled: completed.add('discord')
        elif is_discord_truly_enabled and is_discord_configured_if_enabled : completed.add('discord')
    return completed

@bp.before_request
def check_setup_status_for_blueprint():
    setup_complete_flag = getattr(g, 'setup_complete', False)
    if setup_complete_flag and not current_user.is_authenticated:
        if request.endpoint and not request.endpoint.startswith('auth.'): return redirect(url_for('auth.app_login'))

@bp.route('/account', methods=['GET', 'POST'])
def account_setup():
    form = AccountSetupForm()
    error_message = None # Initialize error_message

    # Check if admin account already exists - we'll show completion state in template instead of redirecting
    # This allows users to navigate back and see that the step is completed

    if request.method == 'GET' and request.args.get('submit_type') == 'plex_sso':
        current_app.logger.info("GET /setup/account?submit_type=plex_sso: START")
        try:
            session['admin_setup_method'] = 'plex_sso'
            current_app.logger.info("CHECKPOINT 1: Session admin_setup_method set")

            # Use plexapi instead of direct HTTP requests
            pin_login, error_msg = create_plex_pin_login(client_identifier_suffix="AdminSetup")
            if not pin_login:
                current_app.logger.error(f"Failed to create Plex PIN: {error_msg}")
                raise Exception(f"Could not create Plex PIN: {error_msg}")

            pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', 'unknown'))
            current_app.logger.info(f"CHECKPOINT 2-8: PIN created successfully. PIN: {pin_login.pin}, ID: {pin_id}")

            # Store the pin_login object details in session
            # Handle different attribute names for PIN ID
            pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', None))
            session['plex_pin_id_admin_setup'] = pin_id
            session['plex_pin_code_admin_setup'] = pin_login.pin
            # Store headers for callback recreation - only store serializable dict
            try:
                if hasattr(pin_login, '_headers'):
                    headers = pin_login._headers() if callable(pin_login._headers) else pin_login._headers
                    if isinstance(headers, dict):
                        session['plex_headers_admin_setup'] = {k: str(v) for k, v in headers.items() if isinstance(v, (str, int, float, bool))}
                    else:
                        session['plex_headers_admin_setup'] = {}
                else:
                    session['plex_headers_admin_setup'] = {}
            except Exception as e:
                current_app.logger.warning(f"Could not store headers in session: {e}")
                session['plex_headers_admin_setup'] = {}
            current_app.logger.info("CHECKPOINT 9: PIN details stored in session.")

            # Attempt to get APP_BASE_URL from settings; fallback to request.url_root
            # Setting.get handles DB not ready by falling back to app.config or default None
            app_base_url_setting = Setting.get('APP_BASE_URL')
            current_app.logger.info(f"CHECKPOINT 10: Setting.get('APP_BASE_URL') returned: {app_base_url_setting}")
            
            app_base_url = app_base_url_setting if app_base_url_setting else request.url_root.rstrip('/')
            current_app.logger.info(f"CHECKPOINT 11: Effective app_base_url: {app_base_url}")

            if not app_base_url_setting and app_base_url == request.url_root.rstrip('/'): # Log only if we actually used request.url_root
                current_app.logger.warning("Plex SSO Setup (GET): APP_BASE_URL not set! Using request.url_root for callback.")

            callback_path_segment = url_for('setup.plex_sso_callback_setup_admin', _external=False)
            current_app.logger.info(f"CHECKPOINT 12: Callback path segment: {callback_path_segment}")
            
            forward_url_to_our_app = f"{app_base_url.rstrip('/')}{callback_path_segment}"
            current_app.logger.info(f"CHECKPOINT 13: Full forwardUrl: {forward_url_to_our_app}")

            # Use plexapi helper to get auth URL
            auth_url_for_user_to_visit = get_plex_auth_url(pin_login, forward_url_to_our_app)
            current_app.logger.info(f"CHECKPOINT 14: Final auth URL for user: {auth_url_for_user_to_visit}")

            pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', 'unknown'))
            current_app.logger.info(f"Plex SSO Setup (GET): About to redirect. PIN: {pin_login.pin}, ID: {pin_id}.")
            return redirect(auth_url_for_user_to_visit)

        except PlexApiException as e_plex:
            current_app.logger.error(f"Plex SSO Setup (GET) EXCEPTION - PlexApiException: {e_plex}", exc_info=True)
            error_message = f"Plex API error: {str(e_plex)}"
        except Exception as e: # Generic catch-all
            current_app.logger.error(f"Plex SSO Setup (GET) EXCEPTION - Generic: {type(e).__name__} - {e}", exc_info=True)
            error_message = f"An unexpected error occurred: {type(e).__name__}."
        
        current_app.logger.info(f"GET /setup/account?submit_type=plex_sso: Reached end of GET SSO block, error_message: '{error_message}'. Will render_template.")
        # If an exception occurred, error_message is set, and it falls through to the final render_template

    elif request.method == 'POST':
        submit_type = request.form.get('submit_type')
        current_app.logger.info(f"POST /setup/account: submit_type='{submit_type}'") # Log POST attempts

        if submit_type == 'plex_sso':
            session['admin_setup_method'] = 'plex_sso'
            try:
                # Use plexapi instead of direct HTTP requests
                pin_login, error_msg = create_plex_pin_login(client_identifier_suffix="AdminSetup")
                if not pin_login:
                    current_app.logger.error(f"Failed to create Plex PIN: {error_msg}")
                    raise Exception(f"Could not create Plex PIN: {error_msg}")
                
                pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', None))
                session['plex_pin_id_admin_setup'] = pin_id
                session['plex_pin_code_admin_setup'] = pin_login.pin
                session['plex_headers_admin_setup'] = pin_login._headers if hasattr(pin_login, '_headers') else {}

                app_base_url_setting = Setting.get('APP_BASE_URL')
                app_base_url = app_base_url_setting if app_base_url_setting else request.url_root.rstrip('/')
                if not app_base_url_setting and app_base_url == request.url_root.rstrip('/'):
                     current_app.logger.warning("Plex SSO Setup (POST): APP_BASE_URL not set! Using request.url_root for callback.")
                
                callback_path_segment = url_for('setup.plex_sso_callback_setup_admin', _external=False)
                forward_url_to_our_app = f"{app_base_url.rstrip('/')}{callback_path_segment}"
                
                auth_url_for_user_to_visit = get_plex_auth_url(pin_login, forward_url_to_our_app)
                pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', 'unknown'))
                current_app.logger.info(f"Plex SSO Setup (POST): PIN: {pin_login.pin}, ID: {pin_id}. Redirecting user to: {auth_url_for_user_to_visit}")
                return redirect(auth_url_for_user_to_visit)
            except PlexApiException as e_plex:
                current_app.logger.error(f"Plex SSO Setup (POST): PlexApiException: {e_plex}", exc_info=True)
                error_message = f"Plex API error: {str(e_plex)}"
            except Exception as e:
                current_app.logger.error(f"Error initiating Plex PIN for admin setup (POST): {e}", exc_info=True)
                error_message = f"Could not initiate Plex SSO PIN. Error: {type(e).__name__}."
            # If an exception occurred, error_message is set, and it falls through to render_template

        elif submit_type == 'username_password':
            # Log form data for debugging
            current_app.logger.info(f"Form validation attempt: username='{form.username.data}', password_length={len(form.password.data) if form.password.data else 0}")
            
            if form.validate_on_submit():
                try:
                    if User.get_owner(): # This will fail if table doesn't exist
                        flash('Admin account already exists. If you need to reset, consult documentation.', 'warning')
                        return redirect(url_for('setup.plugins'))
                except Exception: # Table admin_accounts likely doesn't exist, proceed with creation
                    pass

                owner = User.create_owner(username=form.username.data, password=form.password.data)
                try:
                    db.session.add(owner)
                    db.session.commit()
                    login_user(owner, remember=True) # Log in the newly created owner
                    log_event(EventType.ADMIN_LOGIN_SUCCESS, f"Owner '{owner.localUsername}' created and logged in (setup).", admin_id=owner.id) # Use owner.id
                    flash('Admin account created successfully.', 'success')
                    current_app.logger.info(f"Account setup complete, redirecting to plugins setup: {url_for('setup.plugins')}")
                    return redirect(url_for('setup.plugins'))
                except Exception as e_db_commit:
                    db.session.rollback()
                    current_app.logger.error(f"DB error creating admin account: {e_db_commit}", exc_info=True)
                    error_message = "Database error creating admin account. Check logs." # Display generic to user
            else:
                # Form validation failed for username/password - log specific errors
                current_app.logger.warning(f"Form validation failed. Errors: {form.errors}")
                # Don't set a generic error message - let the individual field errors show in the template
    
    # For SPA replacement, serve the React app for GET or error cases
    if request.method == 'GET' or error_message is not None:
        from flask import send_from_directory
        dist_path = os.path.join(current_app.root_path, 'static', 'dist')
        index_path = os.path.join(dist_path, 'index.html')
        if not os.path.exists(index_path):
            current_app.logger.error("React SPA build not found at %s", index_path)
            return (
                "<h1>React App Not Built</h1>"
                "<p>The React admin interface has not been built yet.</p>"
                "<p>Please run: <code>cd frontend && npm run build</code></p>",
                500,
            )
        return send_from_directory(dist_path, 'index.html')
    # Otherwise fall back to redirecting to plugins (should not normally happen)
    return redirect(url_for('setup.plugins'))

@bp.route('/plex_sso_callback_setup_admin') 
def plex_sso_callback_setup_admin():
    # Debug session contents
    current_app.logger.info(f"Plex SSO Callback (Setup): Session keys: {list(session.keys())}")
    current_app.logger.info(f"Plex SSO Callback (Setup): Full session: {dict(session)}")
    
    pin_id_from_session = session.get('plex_pin_id_admin_setup')
    pin_headers = session.get('plex_headers_admin_setup', {})
    pin_code = session.get('plex_pin_code_admin_setup')
    
    current_app.logger.info(f"Plex SSO Callback (Setup): pin_id={pin_id_from_session}, pin_code={pin_code}, headers_keys={list(pin_headers.keys()) if pin_headers else 'None'}")
    
    if not pin_id_from_session:
        flash('Plex login callback invalid or session expired.', 'danger')
        current_app.logger.warning("Plex SSO Callback (Setup): Missing pin_id in session.")
        return redirect(url_for('setup.account_setup'))
    
    current_app.logger.info(f"Plex SSO Callback (Setup): Checking PIN ID {pin_id_from_session}")
    try:
        # Recreate pin login object for checking status
        from plexapi.myplex import MyPlexPinLogin
        pin_login = MyPlexPinLogin(headers=pin_headers, oauth=False)
        # Restore PIN ID using safe attribute setting
        if hasattr(pin_login, 'id'):
            pin_login.id = pin_id_from_session
        elif hasattr(pin_login, 'identifier'):
            pin_login.identifier = pin_id_from_session
        pin_login.pin = session.get('plex_pin_code_admin_setup')
        
        # Use plexapi helper to check PIN status
        plex_auth_token, error_msg = check_plex_pin_status(pin_login)
        if not plex_auth_token: 
            flash('Plex PIN not yet linked or has expired.', 'warning')
            current_app.logger.warning(f"Plex SSO Callback (Setup): PIN {pin_id_from_session} checked, but no authToken found.")
            return redirect(url_for('setup.account_setup', show_pin_retry_message=True, pin_code_to_display=session.get('plex_pin_code_admin_setup')))
        plex_account = MyPlexAccount(token=plex_auth_token)
        owner_table_exists_cb = False
        try:
            inspector = inspect(db.engine)
            owner_table_exists_cb = inspector.has_table(User.__tablename__)
        except Exception:
            owner_table_exists_cb = False
        if owner_table_exists_cb and User.get_owner():
            flash('Owner account already exists.', 'warning'); existing_owner = User.query.filter_by(userType=UserType.OWNER).filter_by(plex_uuid=plex_account.uuid).first()
            if existing_owner: login_user(existing_owner, remember=True); return redirect(url_for('setup.plugins'))
            else: flash("Owner account exists but doesn't match this Plex account.", "danger"); return redirect(url_for('setup.account_setup'))
        owner = User(userType=UserType.OWNER, plex_uuid=plex_account.uuid, plex_username=plex_account.localUsername, plex_thumb=plex_account.thumb, discord_email=plex_account.email)
        db.session.add(owner); db.session.commit(); login_user(owner, remember=True)
        log_event(EventType.ADMIN_LOGIN_SUCCESS, f"Owner '{owner.plex_username}' created (Plex SSO setup).")
        flash(f'Owner account for {owner.plex_username} created successfully using Plex.', 'success')
        session.pop('plex_pin_id_admin_setup', None); session.pop('plex_pin_code_admin_setup', None); session.pop('plex_headers_admin_setup', None)
        return redirect(url_for('setup.plugins'))
    except PlexApiException as e_plex:
        flash(f'Plex API error: {str(e_plex)}', 'danger')
        current_app.logger.error(f"Plex SSO Callback (Setup): PlexApiException: {e_plex}", exc_info=True)
    except Exception as e: 
        current_app.logger.error(f"Error during Plex PIN check/account creation for admin setup: {e}", exc_info=True)
        flash(f'An unexpected error: {e}', 'danger')
    session.pop('plex_pin_id_admin_setup', None); session.pop('plex_pin_code_admin_setup', None); session.pop('plex_headers_admin_setup', None)
    return redirect(url_for('setup.account_setup'))

@bp.route('/app', methods=['GET', 'POST'])
def app_config():
    # Check if plugins have been configured first (new flow)
    if not 'plugins' in get_completed_steps(): return redirect(url_for('setup.plugins'))
    if 'app' in get_completed_steps() and request.method == 'GET': return redirect(url_for('setup.discord_config'))
    
    form = AppBaseUrlForm()
    if form.validate_on_submit():
        app_name = form.app_name.data
        app_base_url = form.app_base_url.data.rstrip('/')
        app_local_url = form.app_local_url.data.rstrip('/') if form.app_local_url.data else None
        
        Setting.set('APP_NAME', app_name, SettingValueType.STRING, "Application Name")
        Setting.set('APP_BASE_URL', app_base_url, SettingValueType.STRING, "Application Public URL")
        Setting.set('APP_LOCAL_URL', app_local_url or '', SettingValueType.STRING, "Application Local URL")
        
        current_app.config['APP_NAME'] = app_name
        current_app.config['APP_BASE_URL'] = app_base_url
        current_app.config['APP_LOCAL_URL'] = app_local_url
        if hasattr(g, 'app_name'): g.app_name = app_name
        if hasattr(g, 'app_base_url'): g.app_base_url = app_base_url
        if hasattr(g, 'app_local_url'): g.app_local_url = app_local_url
        
        log_message = f"App settings updated: Name='{app_name}', Public URL='{app_base_url}'"
        if app_local_url:
            log_message += f", Local URL='{app_local_url}'"
        # Only log event if user is authenticated (during setup, user might not be fully authenticated)
        if current_user.is_authenticated:
            log_event(EventType.SETTING_CHANGE, log_message, admin_id=current_user.id)
        flash('Application settings saved.', 'success')
        return redirect(url_for('setup.discord_config'))
        
    if request.method == 'GET':
        from flask import send_from_directory
        dist_path = os.path.join(current_app.root_path, 'static', 'dist')
        index_path = os.path.join(dist_path, 'index.html')
        if not os.path.exists(index_path):
            current_app.logger.error("React SPA build not found at %s", index_path)
            return (
                "<h1>React App Not Built</h1>"
                "<p>The React admin interface has not been built yet.</p>"
                "<p>Please run: <code>cd frontend && npm run build</code></p>",
                500,
            )
        return send_from_directory(dist_path, 'index.html')
    # For POST validation failures, serve SPA as well
    from flask import send_from_directory
    dist_path = os.path.join(current_app.root_path, 'static', 'dist')
    return send_from_directory(dist_path, 'index.html')

@bp.route('/discord', methods=['GET', 'POST'])
@login_required
def discord_config():
    if not 'app' in get_completed_steps(): return redirect(url_for('setup.app_config'))
    if not 'plugins' in get_completed_steps(): return redirect(url_for('setup.plugins'))
    form = DiscordConfigForm()
    app_base_url = Setting.get('APP_BASE_URL')
    discord_invite_redirect_uri = url_for('invites.discord_oauth_callback', _external=True) if app_base_url else "Set App Base URL first"
    discord_admin_link_redirect_uri = url_for('auth.discord_callback_admin', _external=True) if app_base_url else "Set App Base URL first"
    if form.validate_on_submit():
        enable_discord = form.enable_discord_oauth.data
        Setting.set('DISCORD_OAUTH_ENABLED', enable_discord, SettingValueType.BOOLEAN, "Enable Discord OAuth for Invites") # Store as bool
        if enable_discord:
            if not form.discord_client_id.data or not form.discord_client_secret.data:
                flash('Discord Client ID and Secret are required if enabled.', 'warning')
                return render_template('setup/discord/index.html', form=form, discord_invite_redirect_uri=discord_invite_redirect_uri, discord_admin_link_redirect_uri=discord_admin_link_redirect_uri, saved_discord_enabled=enable_discord, prev_step_url=url_for('setup.app_config'), completed_steps=get_completed_steps(), current_step_id='discord')
            Setting.set('DISCORD_CLIENT_ID', form.discord_client_id.data, SettingValueType.STRING); Setting.set('DISCORD_CLIENT_SECRET', form.discord_client_secret.data, SettingValueType.SECRET)
            Setting.set('DISCORD_REDIRECT_URI_INVITE', discord_invite_redirect_uri, SettingValueType.STRING); Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', discord_admin_link_redirect_uri, SettingValueType.STRING)
            log_event(EventType.DISCORD_CONFIG_SAVE, "Discord OAuth enabled/configured.", admin_id=current_user.id); flash('Discord configuration saved.', 'success')
        else:
            Setting.set('DISCORD_CLIENT_ID', "", SettingValueType.STRING); Setting.set('DISCORD_CLIENT_SECRET', "", SettingValueType.SECRET)
            log_event(EventType.DISCORD_CONFIG_SAVE, "Discord OAuth disabled.", admin_id=current_user.id); flash('Discord OAuth disabled.', 'info')
        return redirect(url_for('setup.finish_setup'))
    if request.method == 'GET':
        from flask import send_from_directory
        dist_path = os.path.join(current_app.root_path, 'static', 'dist')
        index_path = os.path.join(dist_path, 'index.html')
        if not os.path.exists(index_path):
            current_app.logger.error("React SPA build not found at %s", index_path)
            return (
                "<h1>React App Not Built</h1>"
                "<p>The React admin interface has not been built yet.</p>"
                "<p>Please run: <code>cd frontend && npm run build</code></p>",
                500,
            )
        return send_from_directory(dist_path, 'index.html')
    # For POST (including validation errors), fall back to SPA
    from flask import send_from_directory
    dist_path = os.path.join(current_app.root_path, 'static', 'dist')
    return send_from_directory(dist_path, 'index.html')

@bp.route('/discord/toggle_partial', methods=['POST'])
@login_required
def toggle_discord_partial():
    form = DiscordConfigForm(request.form) 
    app_base_url = Setting.get('APP_BASE_URL')
    discord_invite_redirect_uri = url_for('invites.discord_oauth_callback', _external=True) if app_base_url else "Set App Base URL first"
    discord_admin_link_redirect_uri = url_for('auth.discord_callback_admin', _external=True) if app_base_url else "Set App Base URL first"
    if form.enable_discord_oauth.data:
        form.discord_client_id.data = Setting.get('DISCORD_CLIENT_ID', form.discord_client_id.data)
    # Pass the boolean from the form directly to the partial for its state
    return render_template('setup/discord/_partials/discord_oauth_fields.html', form=form, discord_invite_redirect_uri=discord_invite_redirect_uri, discord_admin_link_redirect_uri=discord_admin_link_redirect_uri, initial_discord_enabled_state=form.enable_discord_oauth.data)


@bp.route('/finish')
@login_required
def finish_setup():
    required_steps_complete = (User.get_owner() and Setting.get('APP_BASE_URL'))
    if not required_steps_complete:
        flash("Not all required setup steps are complete.", "warning")
        if not User.get_owner(): return redirect(url_for('setup.account_setup'))
        if not Setting.get('APP_BASE_URL'): return redirect(url_for('setup.app_config'))
    if not Setting.get('SECRET_KEY'):
        app_secret_key = secrets.token_hex(32)
        Setting.set('SECRET_KEY', app_secret_key, SettingValueType.SECRET, "Application Secret Key"); current_app.config['SECRET_KEY'] = app_secret_key
        log_event(EventType.SETTING_CHANGE, "SECRET_KEY generated at finish.")
    flash('Application setup complete!', 'success'); log_event(EventType.APP_STARTUP, "Setup completed.", admin_id=current_user.id)
    if hasattr(g, 'setup_complete'): g.setup_complete = True; current_app.config['SETUP_COMPLETE'] = True
    return redirect('/admin/dashboard')

@bp.route('/plugins')
def plugins():
    """Redirect to admin Plugins settings (SPA)."""
    return redirect('/admin/settings/plugins')
