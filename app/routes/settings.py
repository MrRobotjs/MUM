# File: app/routes/settings.py
from flask import (
    Blueprint, render_template, redirect, url_for, 
    flash, request, current_app, g, make_response, session, jsonify
)
import requests
from flask_login import login_required, current_user, logout_user 
import secrets
from app.models import User, UserType, Invite, HistoryLog, Setting, EventType, SettingValueType, Role, UserPreferences
from app.models_media_services import MediaServer
from app.forms import (
    GeneralSettingsForm, DiscordConfigForm, SetPasswordForm, ChangePasswordForm, TimezonePreferenceForm, AdvancedSettingsForm
)
from app.extensions import db
from app.utils.helpers import log_event, setup_required, permission_required
from app.services import history_service
import json
from datetime import datetime 

bp = Blueprint('settings', __name__)

@bp.route('/')
@login_required
@setup_required
def index():
    # Redirect AppUsers without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('manage_general_settings'):
        flash('You do not have permission to access the settings page.', 'danger')
        return redirect(url_for('user.index'))
    
    # Defines the order of tabs to check for permissions.
    # The first one the user has access to will be their destination.
    permission_map = [
        ('manage_general_settings', 'settings.general'),
        ('manage_users_general', 'settings.users_general'),
        ('view_admins_tab', 'admin_management.index'),
        ('view_admins_tab', 'role_management.index'), # Use same perm for both admin tabs
        ('manage_discord_settings', 'settings.discord'),
        ('manage_plugins', 'plugin_management.index'),
        ('manage_advanced_settings', 'settings.advanced'), # A placeholder for a more general 'advanced' perm
    ]

    # Owner can see everything, default to general.
    if current_user.userType == UserType.OWNER:
        return redirect(url_for('settings.general'))

    # Find the first settings page the user has permission to view.
    for permission, endpoint in permission_map:
        if current_user.has_permission(permission):
            return redirect(url_for(endpoint))

    # If the user has a login but no settings permissions at all, deny access.
    flash("You do not have permission to view any settings pages.", "danger")
    return redirect(url_for('dashboard.index'))

@bp.route('/general', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('manage_general_settings')
def general():
    # Redirect AppUsers without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('manage_general_settings'):
        flash('You do not have permission to access the general settings page.', 'danger')
        return redirect(url_for('user.index'))
    form = GeneralSettingsForm()
    if form.validate_on_submit():
        # This route now ONLY handles general app settings.
        Setting.set('APP_NAME', form.app_name.data, SettingValueType.STRING, "Application Name")
        Setting.set('APP_BASE_URL', form.app_base_url.data.rstrip('/'), SettingValueType.STRING, "Application Base URL")
        app_local_url = form.app_local_url.data.rstrip('/') if form.app_local_url.data else None
        Setting.set('APP_LOCAL_URL', app_local_url or '', SettingValueType.STRING, "Application Local URL")
        Setting.set('ENABLE_NAVBAR_STREAM_BADGE', form.enable_navbar_stream_badge.data, SettingValueType.BOOLEAN, "Enable Nav Bar Stream Badge")
        Setting.set('SESSION_MONITORING_INTERVAL_SECONDS', form.session_monitoring_interval.data, SettingValueType.INTEGER, "Session Monitoring Interval")
        Setting.set('API_TIMEOUT_SECONDS', form.api_timeout_seconds.data, SettingValueType.INTEGER, "API Request Timeout")
        
        # Update app config
        current_app.config['APP_NAME'] = form.app_name.data
        current_app.config['APP_BASE_URL'] = form.app_base_url.data.rstrip('/')
        current_app.config['APP_LOCAL_URL'] = app_local_url
        current_app.config['SESSION_MONITORING_INTERVAL_SECONDS'] = form.session_monitoring_interval.data
        if hasattr(g, 'app_name'): g.app_name = form.app_name.data
        if hasattr(g, 'app_base_url'): g.app_base_url = form.app_base_url.data.rstrip('/')
        if hasattr(g, 'app_local_url'): g.app_local_url = app_local_url
        
        log_event(EventType.SETTING_CHANGE, "General application settings updated.", admin_id=current_user.id)
        flash('General settings saved successfully.', 'success')
        return redirect(url_for('settings.general'))
    elif request.method == 'GET':
        form.app_name.data = Setting.get('APP_NAME')
        form.app_base_url.data = Setting.get('APP_BASE_URL')
        form.app_local_url.data = Setting.get('APP_LOCAL_URL')
        form.enable_navbar_stream_badge.data = Setting.get_bool('ENABLE_NAVBAR_STREAM_BADGE', False)
        form.session_monitoring_interval.data = Setting.get('SESSION_MONITORING_INTERVAL_SECONDS', 30)
        form.api_timeout_seconds.data = Setting.get('API_TIMEOUT_SECONDS', 3)
    return render_template(
        'settings/index.html',
        title="General Settings", 
        form=form, 
        active_tab='general'
    )


@bp.route('/account', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('manage_general_settings')
def account():
    set_password_form = SetPasswordForm()
    change_password_form = ChangePasswordForm()
    # Get timezone preferences first
    prefs = UserPreferences.get_timezone_preference(current_user.id)
    current_app.logger.debug(f"Settings account route: timezone prefs = {prefs}")
    
    timezone_form = TimezonePreferenceForm(user_timezone=prefs.get('local_timezone'))
    current_app.logger.debug(f"Settings account route: form created with timezone = {prefs.get('local_timezone')}")

    if 'submit_timezone' in request.form and timezone_form.validate_on_submit():
        UserPreferences.set_timezone_preference(
            owner_id=current_user.id,
            preference=timezone_form.timezone_preference.data,
            local_timezone=timezone_form.local_timezone.data,
            time_format=timezone_form.time_format.data
        )
        flash('Timezone preference saved.', 'success')
        return redirect(url_for('settings.account'))

    # --- Handle "Change Password" Form Submission ---
    if 'submit_change_password' in request.form and change_password_form.validate_on_submit():
        user = current_user
        # Verify the current password first
        if user.check_password(change_password_form.current_password.data):
            user.set_password(change_password_form.new_password.data)
            user.force_password_change = False
            db.session.commit()
            log_event(EventType.ADMIN_PASSWORD_CHANGE, "Admin changed their password.", admin_id=current_user.id)
            flash('Your password has been changed successfully.', 'success')
            return redirect(url_for('settings.account'))
        else:
            flash('Incorrect current password.', 'danger')

    # --- Handle "Set Initial Password" Form Submission (moved from general) ---
    elif 'submit_set_password' in request.form and set_password_form.validate_on_submit():
        user = current_user
        user.localUsername = set_password_form.localUsername.data
        user.set_password(set_password_form.password.data)
        user.is_plex_sso_only = False
        db.session.commit()
        log_event(EventType.ADMIN_PASSWORD_CHANGE, "Admin added username/password to their SSO-only account.", admin_id=current_user.id)
        flash('Username and password have been set successfully!', 'success')
        return redirect(url_for('settings.account'))

    if request.method == 'GET':
        prefs = UserPreferences.get_timezone_preference(current_user.id)
        timezone_form.timezone_preference.data = prefs.get('preference')
        timezone_form.local_timezone.data = prefs.get('local_timezone')
        timezone_form.time_format.data = prefs.get('time_format', '12')

    return render_template(
        'account/index.html', #<-- Render the new standalone template
        title="My Account",
        set_password_form=set_password_form,
        change_password_form=change_password_form,
        timezone_form=timezone_form
    )

@bp.route('/discord', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('manage_discord_settings')
def discord():
    # Redirect local users without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('manage_discord_settings'):
        flash('You do not have permission to access the Discord settings page.', 'danger')
        return redirect(url_for('user.index'))
    form = DiscordConfigForm(request.form if request.method == 'POST' else None)
    
    app_base_url_from_settings = Setting.get('APP_BASE_URL')
    invite_callback_path = "/invites/discord_callback" 
    admin_link_callback_path = "/auth/discord_callback_admin"
    try:
        invite_callback_path = url_for('invites.discord_oauth_callback', _external=False)
        admin_link_callback_path = url_for('auth.discord_callback_admin', _external=False)
    except Exception as e_url_gen:
        current_app.logger.error(f"Error generating relative callback paths for Discord settings display: {e_url_gen}")

    if app_base_url_from_settings:
        clean_app_base = app_base_url_from_settings.rstrip('/')
        if not invite_callback_path.startswith('/'): invite_callback_path = '/' + invite_callback_path
        if not admin_link_callback_path.startswith('/'): admin_link_callback_path = '/' + admin_link_callback_path
        discord_invite_redirect_uri_generated = f"{clean_app_base}{invite_callback_path}"
        discord_admin_link_redirect_uri_generated = f"{clean_app_base}{admin_link_callback_path}"
    else:
        discord_invite_redirect_uri_generated = "APP_BASE_URL not set - Cannot generate Invite Redirect URI"
        discord_admin_link_redirect_uri_generated = "APP_BASE_URL not set - Cannot generate Admin Link Redirect URI"
    
    discord_admin_linked = bool(current_user.discord_user_id)
    discord_admin_user_info = {
        'username': current_user.discord_username, 
        'id': current_user.discord_user_id, 
        'avatar': current_user.discord_avatar_hash 
    } if discord_admin_linked else None
    
    initial_oauth_enabled_for_admin_link_section = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)

    if request.method == 'POST':
        if form.validate_on_submit():
            # Store original global setting state BEFORE changes
            original_require_guild = Setting.get_bool('DISCORD_REQUIRE_GUILD_MEMBERSHIP', False)

            enable_oauth_from_form = form.enable_discord_oauth.data
            enable_bot_from_form = form.enable_discord_bot.data
            require_guild_membership_from_form = form.enable_discord_membership_requirement.data

            final_enable_oauth = enable_oauth_from_form
            if (enable_bot_from_form or require_guild_membership_from_form) and not final_enable_oauth:
                final_enable_oauth = True
                flash_msg = "Discord OAuth (Section 1) was automatically enabled because "
                if enable_bot_from_form: flash_msg += "Bot Features require it."
                elif require_guild_membership_from_form: flash_msg += "'Require Server Membership' needs it."
                flash(flash_msg, "info")
            
            Setting.set('DISCORD_OAUTH_ENABLED', final_enable_oauth, SettingValueType.BOOLEAN)
            current_app.config['DISCORD_OAUTH_ENABLED'] = final_enable_oauth
            if hasattr(g, 'discord_oauth_enabled_for_invite'):
                g.discord_oauth_enabled_for_invite = final_enable_oauth

            if final_enable_oauth:
                Setting.set('DISCORD_CLIENT_ID', form.discord_client_id.data or Setting.get('DISCORD_CLIENT_ID', ""), SettingValueType.STRING)
                if form.discord_client_secret.data: 
                    Setting.set('DISCORD_CLIENT_SECRET', form.discord_client_secret.data, SettingValueType.SECRET)
                Setting.set('DISCORD_OAUTH_AUTH_URL', form.discord_oauth_auth_url.data or Setting.get('DISCORD_OAUTH_AUTH_URL', ""), SettingValueType.STRING)
                Setting.set('DISCORD_REDIRECT_URI_INVITE', discord_invite_redirect_uri_generated, SettingValueType.STRING)
                Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', discord_admin_link_redirect_uri_generated, SettingValueType.STRING)

                Setting.set('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', require_guild_membership_from_form, SettingValueType.BOOLEAN)
                
                if enable_bot_from_form or require_guild_membership_from_form:
                    Setting.set('DISCORD_GUILD_ID', form.discord_guild_id.data or Setting.get('DISCORD_GUILD_ID', ""), SettingValueType.STRING)
                    if require_guild_membership_from_form:
                        Setting.set('DISCORD_SERVER_INVITE_URL', form.discord_server_invite_url.data or Setting.get('DISCORD_SERVER_INVITE_URL', ""), SettingValueType.STRING)
                    elif not enable_bot_from_form: 
                        Setting.set('DISCORD_SERVER_INVITE_URL', "", SettingValueType.STRING) 
                else:
                    Setting.set('DISCORD_GUILD_ID', "", SettingValueType.STRING)
                    Setting.set('DISCORD_SERVER_INVITE_URL', "", SettingValueType.STRING)
            else: 
                # If OAuth is disabled, clear all related settings
                Setting.set('DISCORD_CLIENT_ID', "", SettingValueType.STRING)
                Setting.set('DISCORD_CLIENT_SECRET', "", SettingValueType.SECRET)
                Setting.set('DISCORD_OAUTH_AUTH_URL', "", SettingValueType.STRING)
                Setting.set('DISCORD_REDIRECT_URI_INVITE', "", SettingValueType.STRING)
                Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', "", SettingValueType.STRING)
                Setting.set('DISCORD_BOT_REQUIRE_SSO_ON_INVITE', False, SettingValueType.BOOLEAN)
                Setting.set('DISCORD_REQUIRE_GUILD_MEMBERSHIP', False, SettingValueType.BOOLEAN)
                Setting.set('DISCORD_GUILD_ID', "", SettingValueType.STRING)
                Setting.set('DISCORD_SERVER_INVITE_URL', "", SettingValueType.STRING)

            # Bot settings save logic (unchanged)
            Setting.set('DISCORD_BOT_ENABLED', enable_bot_from_form, SettingValueType.BOOLEAN)
            if enable_bot_from_form:
                if form.discord_bot_token.data: Setting.set('DISCORD_BOT_TOKEN', form.discord_bot_token.data, SettingValueType.SECRET)
                Setting.set('DISCORD_MONITORED_ROLE_ID', form.discord_monitored_role_id.data or Setting.get('DISCORD_MONITORED_ROLE_ID', ""), SettingValueType.STRING)
                Setting.set('DISCORD_THREAD_CHANNEL_ID', form.discord_thread_channel_id.data or Setting.get('DISCORD_THREAD_CHANNEL_ID', ""), SettingValueType.STRING)
                Setting.set('DISCORD_BOT_LOG_CHANNEL_ID', form.discord_bot_log_channel_id.data or Setting.get('DISCORD_BOT_LOG_CHANNEL_ID', ""), SettingValueType.STRING)
                if not require_guild_membership_from_form:
                    Setting.set('DISCORD_SERVER_INVITE_URL', form.discord_server_invite_url.data or Setting.get('DISCORD_SERVER_INVITE_URL', ""), SettingValueType.STRING)
                Setting.set('DISCORD_BOT_WHITELIST_SHARERS', form.discord_bot_whitelist_sharers.data, SettingValueType.BOOLEAN)
                log_event(EventType.DISCORD_CONFIG_SAVE, "Discord settings updated (Bot Enabled).", admin_id=current_user.id)
            else: 
                if form.discord_bot_token.data:
                    Setting.set('DISCORD_BOT_TOKEN', "", SettingValueType.SECRET)
                Setting.set('DISCORD_BOT_WHITELIST_SHARERS', form.discord_bot_whitelist_sharers.data, SettingValueType.BOOLEAN)
                log_event(EventType.DISCORD_CONFIG_SAVE, "Discord settings updated (Bot Disabled).", admin_id=current_user.id)

            db.session.commit() # A single commit at the end to save grandfathered invites and settings
            flash('Discord settings saved successfully.', 'success')
            return redirect(url_for('settings.discord'))

    if request.method == 'GET':
        is_oauth_enabled_db = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
        form.enable_discord_oauth.data = is_oauth_enabled_db
        if is_oauth_enabled_db:
            form.discord_client_id.data = Setting.get('DISCORD_CLIENT_ID')
            form.discord_oauth_auth_url.data = Setting.get('DISCORD_OAUTH_AUTH_URL')
        
        is_bot_enabled_db = Setting.get_bool('DISCORD_BOT_ENABLED', False)
        form.enable_discord_bot.data = is_bot_enabled_db

        if is_oauth_enabled_db:
            form.enable_discord_membership_requirement.data = Setting.get_bool('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', False)
        else:
            form.enable_discord_membership_requirement.data = False
            
        form.discord_guild_id.data = Setting.get('DISCORD_GUILD_ID')
        form.discord_server_invite_url.data = Setting.get('DISCORD_SERVER_INVITE_URL')
        
        if is_bot_enabled_db:
            form.discord_monitored_role_id.data = Setting.get('DISCORD_MONITORED_ROLE_ID')
            form.discord_thread_channel_id.data = Setting.get('DISCORD_THREAD_CHANNEL_ID')
            form.discord_bot_log_channel_id.data = Setting.get('DISCORD_BOT_LOG_CHANNEL_ID')
        form.discord_bot_whitelist_sharers.data = Setting.get_bool('DISCORD_BOT_WHITELIST_SHARERS', False)
            
    return render_template('settings/index.html', 
                           title="Discord Settings", 
                           form=form,
                           active_tab='discord',
                           discord_invite_redirect_uri=discord_invite_redirect_uri_generated,
                           discord_admin_link_redirect_uri=discord_admin_link_redirect_uri_generated,
                           discord_admin_linked=discord_admin_linked,
                           discord_admin_user_info=discord_admin_user_info,
                           initial_discord_enabled_state=initial_oauth_enabled_for_admin_link_section)

@bp.route('/advanced', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('manage_advanced_settings')
def advanced():
    # Redirect local users without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('manage_advanced_settings'):
        flash('You do not have permission to access the advanced settings page.', 'danger')
        return redirect(url_for('user.index'))
    
    form = AdvancedSettingsForm()
    
    if form.validate_on_submit():
        # Handle CSRF token timeout setting
        csrf_timeout_minutes = form.csrf_token_timeout_minutes.data
        if csrf_timeout_minutes is None:
            csrf_timeout_minutes = 50  # Default fallback
        
        if csrf_timeout_minutes == 0:
            # Set to None to disable expiration
            Setting.set('WTF_CSRF_TIME_LIMIT', None, SettingValueType.STRING, "CSRF Token Timeout")
            current_app.config['WTF_CSRF_TIME_LIMIT'] = None
        else:
            # Convert minutes to seconds for Flask-WTF
            csrf_timeout_seconds = csrf_timeout_minutes * 60
            Setting.set('WTF_CSRF_TIME_LIMIT', csrf_timeout_seconds, SettingValueType.INTEGER, "CSRF Token Timeout")
            current_app.config['WTF_CSRF_TIME_LIMIT'] = csrf_timeout_seconds
        
        log_event(EventType.SETTING_CHANGE, "Advanced settings updated.", admin_id=current_user.id)
        flash('Advanced settings saved successfully.', 'success')
        return redirect(url_for('settings.advanced'))
    
    elif request.method == 'GET':
        # Load CSRF timeout setting - convert seconds back to minutes for display
        csrf_timeout_seconds = Setting.get('WTF_CSRF_TIME_LIMIT')
        if csrf_timeout_seconds is None:
            form.csrf_token_timeout_minutes.data = 0  # 0 means disabled
        else:
            form.csrf_token_timeout_minutes.data = int(csrf_timeout_seconds) // 60 if csrf_timeout_seconds else 50
    
    all_db_settings = Setting.query.order_by(Setting.key).all()
    return render_template('settings/index.html', title="Advanced Settings", active_tab='advanced', all_db_settings=all_db_settings, form=form)

@bp.route('/regenerate_secret_key', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_advanced_settings')
def regenerate_secret_key():
    try:
        new_secret_key = secrets.token_hex(32)
        Setting.set('SECRET_KEY', new_secret_key, SettingValueType.SECRET, "Application Secret Key"); current_app.config['SECRET_KEY'] = new_secret_key
        admin_id_for_log = current_user.id if current_user and current_user.is_authenticated else None 
        logout_user() # User's session is now invalid due to new secret key
        log_event(EventType.SETTING_CHANGE, "Application SECRET_KEY re-generated by admin.", admin_id=admin_id_for_log)
        # Flash message might not be seen if user is immediately logged out and redirected by Flask-Login
        # flash('SECRET_KEY re-generated. All users (including you) have been logged out.', 'success') 
        
        # For HTMX, explicitly tell client to redirect to login
        if request.headers.get('HX-Request'):
            response = make_response('<div class="alert alert-success p-2">SECRET_KEY re-generated. You will be logged out. Refreshing...</div>')
            response.headers['HX-Refresh'] = 'true' # Or HX-Redirect to login page
            return response
        return redirect(url_for('auth.app_login')) # Redirect to login for standard request
    except Exception as e:
        current_app.logger.error(f"Error regenerating SECRET_KEY: {e}")
        log_event(EventType.ERROR_GENERAL, f"Failed to re-generate SECRET_KEY: {str(e)}", admin_id=current_user.id if current_user and current_user.is_authenticated else None)
        flash(f'Error re-generating SECRET_KEY: {e}', 'danger')
        if request.headers.get('HX-Request'): return f'<div class="alert alert-error p-2">Error: {e}</div>', 500
        return redirect(url_for('settings.advanced'))

# Helper function to build the history query based on request args
def _get_history_logs_query():
    query = HistoryLog.query
    search_message = request.args.get('search_message')
    event_type_filter = request.args.get('event_type')
    related_user_filter = request.args.get('related_user')

    if search_message: query = query.filter(HistoryLog.message.ilike(f"%{search_message}%"))
    if event_type_filter:
        try: query = query.filter(HistoryLog.event_type == EventType[event_type_filter])
        except KeyError: flash(f"Invalid event type filter: {event_type_filter}", "warning") # Flash won't show on partial
    if related_user_filter:
        from sqlalchemy import or_ 
        query = query.join(Owner, User.id == HistoryLog.admin_id, isouter=True) \
                     .join(Owner, User.id == HistoryLog.owner_id, isouter=True) \
                     .join(User, User.id == HistoryLog.linkedUserId, isouter=True) \
                     .filter(or_(
                         User.localUsername.ilike(f"%{related_user_filter}%"), 
                         User.plex_username.ilike(f"%{related_user_filter}%"), 
                         User.localUsername.ilike(f"%{related_user_filter}%"), 
                         HistoryLog.owner_id.cast(db.String).ilike(f"%{related_user_filter}%"), 
                         HistoryLog.linkedUserId.cast(db.String).ilike(f"%{related_user_filter}%")
                     ))
    return query

@bp.route('/logs/clear', methods=['POST'])
@login_required
@setup_required
@permission_required('clear_logs')
def clear_logs():
    event_types_selected = request.form.getlist('event_types_to_clear[]')
    clear_all = request.form.get('clear_all_types') == 'true'
    
    current_app.logger.info(f"Settings.py - clear_logs(): Received request to clear logs. Selected types: {event_types_selected}, Clear All: {clear_all}")

    types_to_delete_in_service = None
    if not clear_all and event_types_selected:
        types_to_delete_in_service = event_types_selected
    elif clear_all:
        types_to_delete_in_service = None
    else: 
        toast_message = "No event types selected to clear. No logs were deleted."
        toast_category = "info"
        
        response = make_response("") 
        trigger_payload = json.dumps({"showToastEvent": {"message": toast_message, "category": toast_category}})
        response.headers['HX-Trigger-After-Swap'] = trigger_payload 
        # Also trigger list refresh, though nothing changed
        refresh_trigger_payload = json.dumps({"refreshHistoryList": True})
        existing_trigger = response.headers.get('HX-Trigger-After-Swap')
        if existing_trigger:
            try:
                data = json.loads(existing_trigger)
                data.update(json.loads(refresh_trigger_payload))
                response.headers['HX-Trigger-After-Swap'] = json.dumps(data)
            except json.JSONDecodeError:
                 response.headers['HX-Trigger-After-Swap'] = refresh_trigger_payload # fallback
        else:
            response.headers['HX-Trigger-After-Swap'] = refresh_trigger_payload
        
        return response, 200 # Send 200 OK as an action was processed (even if no-op)

    toast_message = ""
    toast_category = "info"
    try:
        cleared_count = history_service.clear_history_logs(
            event_types_to_clear=types_to_delete_in_service,
            admin_id=current_user.id
        )
        toast_message = f"Successfully cleared {cleared_count} history log entries."
        toast_category = "success"
        current_app.logger.info(f"Settings.py - clear_logs(): {toast_message}")

    except Exception as e:
        current_app.logger.error(f"Settings.py - clear_logs(): Failed to clear history: {e}", exc_info=True)
        toast_message = f"Error clearing history logs: {str(e)}"
        toast_category = "danger"

    response_content_for_form = "" 
    response = make_response(response_content_for_form)
    
    triggers = {}
    if toast_message:
        triggers["showToastEvent"] = {"message": toast_message, "category": toast_category}
    
    triggers["refreshHistoryList"] = True # Always refresh the list after attempting a clear
    
    response.headers['HX-Trigger-After-Swap'] = json.dumps(triggers)
    current_app.logger.debug(f"Settings.py - clear_logs(): Sending HX-Trigger-After-Swap: {response.headers['HX-Trigger-After-Swap']}")

    return response

@bp.route('/logs')
@login_required
@setup_required
@permission_required('view_logs') # Renamed permission
def logs():
    # Redirect local users without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('view_logs'):
        flash('You do not have permission to access the logs page.', 'danger')
        return redirect(url_for('user.index'))
    # This route now just renders the main settings layout.
    # The content will be loaded via the partial included in settings/index.html
    event_types = list(EventType) 
    return render_template('settings/index.html', 
                           title="Application Logs", 
                           event_types=event_types,
                           active_tab='logs')

@bp.route('/logs/partial')
@login_required
@setup_required
@permission_required('view_logs') # Renamed permission
def logs_partial():
    page = request.args.get('page', 1, type=int)
    session_per_page_key = 'logs_list_per_page' # New session key
    default_per_page = int(current_app.config.get('DEFAULT_HISTORY_PER_PAGE', 20)) # Can keep old config name
    
    per_page_from_request = request.args.get('per_page', type=int)
    if per_page_from_request and per_page_from_request in [20, 50, 100, 200]:
        items_per_page = per_page_from_request
        session[session_per_page_key] = items_per_page
    else:
        items_per_page = session.get(session_per_page_key, default_per_page)
        if items_per_page not in [20, 50, 100, 200]:
            items_per_page = default_per_page
            session[session_per_page_key] = items_per_page

    query = _get_history_logs_query() # This helper function can be reused as is
    logs = query.order_by(HistoryLog.timestamp.desc()).paginate(page=page, per_page=items_per_page, error_out=False)
    event_types = list(EventType) 
    
    # This now renders the new partial for the log list content
    return render_template('settings/logs/_partials/logs_table.html', 
                           logs=logs, 
                           event_types=event_types,
                           current_per_page=items_per_page)

@bp.route('/streaming-settings', methods=['GET'])
@login_required
@setup_required
@permission_required('view_settings')
def get_streaming_settings():
    """Get current streaming settings as JSON"""
    try:
        enable_navbar_stream_badge = Setting.get('ENABLE_NAVBAR_STREAM_BADGE', 'false').lower() == 'true'
        session_monitoring_interval = int(Setting.get('SESSION_MONITORING_INTERVAL_SECONDS', '30'))
        
        return jsonify({
            'enable_navbar_stream_badge': enable_navbar_stream_badge,
            'session_monitoring_interval': session_monitoring_interval
        })
    except Exception as e:
        current_app.logger.error(f"Error getting streaming settings: {e}")
        return jsonify({'error': 'Failed to load settings'}), 500

@bp.route('/streaming-settings', methods=['POST'])
@login_required
@setup_required
@permission_required('edit_settings')
def update_streaming_settings():
    """Update streaming settings"""
    try:
        enable_navbar_stream_badge = request.form.get('enable_navbar_stream_badge') == 'true'
        session_monitoring_interval = request.form.get('session_monitoring_interval', '30')
        
        # Validate session monitoring interval
        try:
            interval_value = int(session_monitoring_interval)
            if interval_value < 5 or interval_value > 300:
                raise ValueError("Interval must be between 5 and 300 seconds")
        except ValueError as e:
            return jsonify({'error': f'Invalid session monitoring interval: {e}'}), 400
        
        # Save settings
        Setting.set('ENABLE_NAVBAR_STREAM_BADGE', 'true' if enable_navbar_stream_badge else 'false')
        Setting.set('SESSION_MONITORING_INTERVAL_SECONDS', str(interval_value))
        
        current_app.logger.info(f"Streaming settings updated by {current_user.localUsername}: "
                               f"navbar_badge={enable_navbar_stream_badge}, "
                               f"interval={interval_value}")
        
        return jsonify({
            'success': True,
            'message': 'Streaming settings updated successfully!'
        })
        
    except Exception as e:
        current_app.logger.error(f"Error updating streaming settings: {e}")
        return jsonify({'error': 'Failed to save settings'}), 500


@bp.route('/api_debug')
@login_required
@setup_required
@permission_required('manage_advanced_settings')
def api_debug():
    """API Debug page for testing server APIs"""
    # Get all available media servers
    servers = MediaServer.query.filter_by(is_active=True).order_by(MediaServer.server_nickname).all()
    
    return render_template('settings/index.html', 
                         title="API Debug", 
                         active_tab='api_debug',
                         servers=servers)


@bp.route('/api_debug_execute', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_advanced_settings')
def api_debug_execute():
    """Execute API call for debugging"""
    try:
        if not request.is_json:
            return jsonify({'error': 'Request must be JSON'}), 400
            
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No JSON data provided'}), 400
            
        method = data.get('method', 'GET')
        endpoint = data.get('endpoint', '')
        response_format = data.get('response_format', 'json')
        parameters = data.get('parameters', [])
        server_id = data.get('server_id')
        
        if not server_id or not endpoint:
            return jsonify({'error': 'Server and endpoint are required'}), 400
            
        # Get the server
        server = MediaServer.query.get(server_id)
        if not server:
            return jsonify({'error': 'Server not found'}), 404
            
        # Construct full URL with parameters
        base_url = server.url.rstrip('/')
        if not endpoint.startswith('/'):
            endpoint = '/' + endpoint
        full_url = base_url + endpoint
        
        # Add query parameters
        if parameters:
            query_params = []
            for param in parameters:
                if param.get('key') and param.get('value'):
                    query_params.append(f"{param['key']}={param['value']}")
            if query_params:
                separator = '&' if '?' in full_url else '?'
                full_url += separator + '&'.join(query_params)
        
        # Prepare headers and auth
        headers = {}
        
        # Set content type based on response format
        if response_format == 'xml':
            headers['Accept'] = 'application/xml, text/xml'
        else:
            headers['Accept'] = 'application/json'
            
        headers['Content-Type'] = 'application/json'
        auth = None
        
        # Add service-specific authentication
        if server.service_type.value == 'plex':
            if server.api_key:
                headers['X-Plex-Token'] = server.api_key
        elif server.service_type.value in ['jellyfin', 'emby']:
            if server.api_key:
                headers['X-Emby-Token'] = server.api_key
        elif server.service_type.value in ['kavita', 'audiobookshelf', 'komga', 'romm']:
            if server.api_key:
                headers['Authorization'] = f'Bearer {server.api_key}'
        
        # Add basic auth if username/password provided
        if server.localUsername and server.password:
            auth = (server.localUsername, server.password)
            
        # Execute the request
        timeout = 30
        
        if method.upper() == 'GET':
            response = requests.get(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
        elif method.upper() == 'POST':
            response = requests.post(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
        elif method.upper() == 'PUT':
            response = requests.put(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
        elif method.upper() == 'PATCH':
            response = requests.patch(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
        elif method.upper() == 'DELETE':
            response = requests.delete(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
        elif method.upper() == 'HEAD':
            response = requests.head(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
        elif method.upper() == 'OPTIONS':
            response = requests.options(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
        else:
            return jsonify({'error': f'Unsupported method: {method}'}), 400
            
        # Parse response based on format
        response_json = None
        response_xml = None
        
        try:
            if response_format == 'xml' or 'xml' in response.headers.get('content-type', '').lower():
                response_xml = response.text
                # Try to also parse as JSON if possible
                try:
                    response_json = response.json()
                except:
                    pass
            else:
                response_json = response.json()
        except:
            # If JSON parsing fails, treat as text
            pass
            
        # Build result
        result = {
            'success': True,
            'status_code': response.status_code,
            'status_text': response.reason,
            'headers': dict(response.headers),
            'url': full_url,
            'method': method.upper(),
            'response_text': response.text,
            'response_json': response_json,
            'response_xml': response_xml,
            'response_format': response_format,
            'elapsed_ms': int(response.elapsed.total_seconds() * 1000)
        }
        
        return jsonify(result)
        
    except requests.exceptions.Timeout:
        return jsonify({'error': 'Request timed out'}), 408
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'Connection error - could not reach server'}), 502
    except requests.exceptions.RequestException as e:
        return jsonify({'error': f'Request error: {str(e)}'}), 500
    except Exception as e:
        current_app.logger.error(f"API Debug error: {e}")
        return jsonify({'error': f'Unexpected error: {str(e)}'}), 500


# Users General Management Routes
@bp.route('/users/general', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('manage_users_general')
def users_general():
    """Display users general settings page"""
    from app.forms import UserAccountsSettingsForm
    form = UserAccountsSettingsForm()
    
    if form.validate_on_submit():
        # Handle user account settings
        Setting.set('ALLOW_USER_ACCOUNTS', form.allow_user_accounts.data, SettingValueType.BOOLEAN, "Allow User Accounts")
        
        log_event(EventType.SETTING_CHANGE, "User account settings updated.", admin_id=current_user.id)
        flash('User account settings saved successfully.', 'success')
        return redirect(url_for('settings.users_general'))
    elif request.method == 'GET':
        # Load current settings from database
        form.allow_user_accounts.data = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    
    return render_template(
        'settings/index.html',
        title="Users General Settings",
        form=form,
        active_tab='users_general'
    )

# User Roles Management Routes
@bp.route('/users/roles')
@login_required
@setup_required
@permission_required('manage_user_roles')
def user_roles():
    """Display user roles management page"""
    from app.models import UserRole
    
    # Get all user roles (visual roles) ordered by name
    user_roles = UserRole.query.order_by(UserRole.name).all()
    
    # Transform for template (similar to admin roles structure)
    roles_data = []
    for role in user_roles:
        roles_data.append({
            'type': 'visual',
            'role': role,
            'is_staff': role.name == 'Staff'
        })
    
    return render_template(
        'settings/index.html',
        title="User Role Management",
        roles=roles_data,
        user_roles=user_roles,  # For forms that need only user roles
        active_tab='user_roles'
    )

@bp.route('/users/roles/create', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('create_user_role')
def create_user_role():
    """Create new user role page"""
    from app.forms import UserRoleCreateForm
    from app.models import UserRole
    from flask import current_app
    
    form = UserRoleCreateForm()
    
    if request.method == 'POST' and form.validate_on_submit():
        try:
            current_app.logger.info(f"Creating user role - Form data: name={form.name.data}, description={form.description.data}, color={form.color.data}, icon={form.icon.data}")
            
            # Create new visual user role
            new_role = UserRole(
                name=form.name.data,
                description=form.description.data,
                color=form.color.data,
                icon=form.icon.data.strip() if form.icon.data else None
            )
            
            current_app.logger.info(f"Created UserRole object - ID: {new_role.id}, Name: {new_role.name}")
            
            db.session.add(new_role)
            current_app.logger.info("Added user role to session, about to flush")
            db.session.flush()
            current_app.logger.info(f"Flush successful, role ID: {new_role.id}")
            
            db.session.commit()
            current_app.logger.info("Commit successful")
            
            flash(f"User role '{new_role.name}' created successfully.", "success")
            return redirect(url_for('settings.user_roles'))
            
        except Exception as e:
            current_app.logger.error(f"Error creating user role: {str(e)}")
            db.session.rollback()
            flash(f"Error creating user role: {str(e)}", 'error')
    else:
        current_app.logger.warning(f"Form validation failed: {form.errors}")
    
    return render_template(
        'settings/user_roles/create.html',
        title="Create User Role",
        form=form,
        active_tab='user_roles'
    )

@bp.route('/users/roles/<string:role_id>/edit', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('edit_user_role')
def edit_user_role(role_id):
    """Edit user role page"""
    from app.forms import UserRoleEditForm
    from app.models import UserRole
    from flask import current_app
    
    role = UserRole.query.get_or_404(role_id)
    
    # Prevent editing the Staff role
    if role.is_staff_role():
        flash('The Staff role cannot be edited as it is system-managed.', 'warning')
        return redirect(url_for('settings.user_roles'))
    
    form = UserRoleEditForm(obj=role)
    
    if request.method == 'POST' and form.validate_on_submit():
        try:
            current_app.logger.info(f"Editing user role {role.name} - Form data: name={form.name.data}, description={form.description.data}, color={form.color.data}, icon={form.icon.data}")
            
            role.name = form.name.data
            role.description = form.description.data
            role.color = form.color.data
            role.icon = form.icon.data.strip() if form.icon.data else None
            
            db.session.commit()
            current_app.logger.info(f"User role '{role.name}' updated successfully")
            
            flash(f"User role '{role.name}' updated successfully.", "success")
            return redirect(url_for('settings.user_roles'))
            
        except Exception as e:
            current_app.logger.error(f"Error updating user role: {str(e)}")
            db.session.rollback()
            flash(f"Error updating user role: {str(e)}", 'error')
    
    return render_template(
        'settings/user_roles/edit.html',
        title=f"Edit User Role: {role.name}",
        form=form,
        role=role,
        active_tab='user_roles'
    )

@bp.route('/users/roles/<string:role_id>/delete', methods=['POST'])
@login_required
@setup_required
@permission_required('delete_user_role')
def delete_user_role(role_id):
    """Delete user role"""
    from app.models import UserRole
    from flask import current_app
    
    role = UserRole.query.get_or_404(role_id)
    
    # Prevent deletion of the Staff role
    if not role.can_be_deleted():
        flash('The Staff role cannot be deleted as it is system-managed.', 'danger')
        return redirect(url_for('settings.user_roles'))
    
    # Check if role is assigned to any users
    if role.users:
        flash(f"Cannot delete '{role.name}' because it is assigned to {len(role.users)} user(s). Remove the role from all users first.", 'danger')
        return redirect(url_for('settings.user_roles'))
    
    try:
        role_name = role.name
        db.session.delete(role)
        db.session.commit()
        
        current_app.logger.info(f"User role '{role_name}' deleted successfully")
        flash(f"User role '{role_name}' deleted successfully.", "success")
        
    except Exception as e:
        current_app.logger.error(f"Error deleting user role: {str(e)}")
        db.session.rollback()
        flash(f"Error deleting user role: {str(e)}", 'error')
    
    return redirect(url_for('settings.user_roles'))