"""
OAuth callback handlers - Plex and Discord authentication callbacks
"""

import time
from flask import redirect, url_for, flash, request, current_app, session
from markupsafe import Markup
from plexapi.myplex import MyPlexAccount
from plexapi.exceptions import PlexApiException
from app.models import User, UserType, Invite, Setting, EventType
from app.utils.helpers import setup_required, log_event
from app.utils.timeout_helper import get_api_timeout
from app.services.media_service_factory import MediaServiceFactory
from . import invites_public_bp as invites_bp
import requests

DISCORD_API_BASE_URL = 'https://discord.com/api/v10'

@invites_bp.route('/plex_callback') # Path is /invites/plex_callback
@setup_required
def plex_oauth_callback():
    invite_id = session.get('plex_oauth_invite_id')
    pin_code_from_session = session.get('plex_pin_code_invite_flow')
    pin_id_from_session = session.get('plex_pin_id_invite_flow')
    client_id_from_session = session.get('plex_client_id_invite_flow')
    app_name_from_session = session.get('plex_app_name_invite_flow')
    
    current_app.logger.debug(f"Plex callback - invite_id from session: {invite_id}")
    current_app.logger.debug(f"Plex callback - pin_code_from_session: {pin_code_from_session}")
    current_app.logger.debug(f"Plex callback - pin_id_from_session: {pin_id_from_session}")
    current_app.logger.debug(f"Plex callback - client_id_from_session: {client_id_from_session}")
    
    invite_path_or_token_for_redirect = "error_path" 
    if invite_id: 
        temp_invite_for_redirect = Invite.query.get(invite_id)
        if temp_invite_for_redirect: 
            invite_path_or_token_for_redirect = temp_invite_for_redirect.custom_path or temp_invite_for_redirect.token

    fallback_redirect = url_for('public_spa.invite_token_spa', invite_path_or_token=invite_path_or_token_for_redirect)
    
    if not invite_id or not pin_code_from_session or not pin_id_from_session or not client_id_from_session:
        flash('Plex login callback invalid. Try invite again.', 'danger')
        # Clear all session keys related to this flow
        session.pop('plex_oauth_invite_id', None)
        session.pop('plex_pin_code_invite_flow', None)
        session.pop('plex_pin_id_invite_flow', None)
        session.pop('plex_client_id_invite_flow', None)
        session.pop('plex_app_name_invite_flow', None)
        return redirect(fallback_redirect) 
    
    invite = Invite.query.get(invite_id)
    if not invite: 
        flash('Invite not found. Try again.', 'danger')
        return redirect(url_for('public_spa.invite_landing_spa'))

    return_path = session.get(f'invite_{invite.id}_return_path')
    if return_path:
        fallback_redirect = return_path
    
    try:
        # Use direct API approach exactly like the sample code
        current_app.logger.debug(f"Plex callback - Using direct API approach to check PIN ID {pin_id_from_session} (PIN code: {pin_code_from_session})")
        
        # Retry mechanism for OAuth timing issues
        max_retries = 3
        retry_delay = 1  # seconds
        plex_auth_token = None
        
        for attempt in range(max_retries):
            current_app.logger.debug(f"Plex callback - Authentication attempt {attempt + 1}/{max_retries}")
            
            try:
                # Make direct API call exactly like the sample code
                headers = {"accept": "application/json"}
                data = {"code": pin_code_from_session, "X-Plex-Client-Identifier": client_id_from_session}
                
                check_url = f"https://plex.tv/api/v2/pins/{pin_id_from_session}"
                timeout = get_api_timeout()
                response = requests.get(check_url, headers=headers, data=data, timeout=timeout)
                
                current_app.logger.debug(f"Plex callback - PIN check response status: {response.status_code}")
                current_app.logger.debug(f"Plex callback - PIN check response text: {response.text[:500]}")
                
                if response.status_code == 200:
                    pin_data = response.json()
                    current_app.logger.debug(f"Plex callback - PIN data: {pin_data}")
                    
                    if pin_data.get('authToken'):
                        plex_auth_token = pin_data['authToken']
                        current_app.logger.info(f"Plex callback - Successfully retrieved auth token via direct API for PIN {pin_code_from_session}")
                        break
                    else:
                        current_app.logger.debug(f"Plex callback - PIN {pin_code_from_session} not yet authenticated (no authToken)")
                elif response.status_code == 404:
                    current_app.logger.warning(f"Plex callback - PIN {pin_code_from_session} not found (404)")
                else:
                    current_app.logger.warning(f"Plex callback - PIN check failed with status {response.status_code}: {response.text[:200]}")
                    
            except Exception as e:
                current_app.logger.error(f"Plex callback - Error checking PIN via API: {e}")
                
            if attempt < max_retries - 1:  # Don't sleep on the last attempt
                current_app.logger.debug(f"Plex callback - Waiting {retry_delay}s before retry...")
                time.sleep(retry_delay)
        
        if not plex_auth_token:
            current_app.logger.warning(f"Plex callback - PIN {pin_code_from_session} not authenticated after {max_retries} attempts")
            flash('Plex PIN not yet authenticated. Please complete the authentication on plex.tv/link', 'warning')
            return redirect(fallback_redirect)

        plex_account = MyPlexAccount(token=plex_auth_token)
        
        # Check if this Plex user is already in any of the invite's Plex servers
        plex_servers_in_invite = [s for s in invite.servers if s.service_type.name.upper() == 'PLEX']
        plex_user_already_exists = False
        existing_server_name = ""
        existing_local_account = None
        
        for plex_server in plex_servers_in_invite:
            try:
                service = MediaServiceFactory.create_service_from_db(plex_server)
                users = service.get_users()
                
                for user in users:
                    # Check if this Plex user already exists in the server
                    if (user.get('uuid') == plex_account.uuid or 
                        user.get('email', '').lower() == plex_account.email.lower()):
                        plex_user_already_exists = True
                        existing_server_name = plex_server.server_nickname
                        
                        # Check if this Plex user is already linked to a local account
                        from sqlalchemy import or_
                        
                        existing_access = User.query.filter_by(userType=UserType.SERVICE).filter(
                            User.server_id == plex_server.id,
                            or_(
                                User.external_user_id == str(plex_account.uuid),
                                User.external_user_alt_id == str(plex_account.uuid),
                                User.external_user_id == str(plex_account.id),
                                User.external_user_alt_id == str(plex_account.id)
                            )
                        ).first()
                        
                        if existing_access and existing_access.linkedUserId and existing_access.user_app_access:
                            existing_local_account = existing_access.user_app_access
                        
                        current_app.logger.info(f"Plex user {plex_account.localUsername} already exists in {existing_server_name}")
                        break
                
                if plex_user_already_exists:
                    break
                    
            except Exception as e:
                current_app.logger.warning(f"Could not check existing users in {plex_server.server_nickname}: {e}")
        
        # Handle the different scenarios
        if plex_user_already_exists:
            allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
            
            if existing_local_account:
                # Plex user is already linked to a local account
                session[f'invite_{invite.id}_plex_conflict'] = {
                    'type': 'already_linked',
                    'server_name': existing_server_name,
                    'linked_username': existing_local_account.localUsername,
                    'plex_username': plex_account.localUsername,
                    'plex_email': plex_account.email
                }
                current_app.logger.info(f"Plex user {plex_account.localUsername} is already linked to local account {existing_local_account.localUsername}")
            elif allow_user_accounts:
                # Plex user exists but not linked - offer to link
                session[f'invite_{invite.id}_plex_conflict'] = {
                    'type': 'can_link',
                    'server_name': existing_server_name,
                    'plex_username': plex_account.localUsername,
                    'plex_email': plex_account.email
                }
                current_app.logger.info(f"Plex user {plex_account.localUsername} exists but not linked - offering to link")
            else:
                # Plex user exists but no local accounts feature
                session[f'invite_{invite.id}_plex_conflict'] = {
                    'type': 'already_exists_no_linking',
                    'server_name': existing_server_name,
                    'plex_username': plex_account.localUsername,
                    'plex_email': plex_account.email
                }
                current_app.logger.info(f"Plex user {plex_account.localUsername} already exists and no local account linking available")
        else:
            # Plex user is new - proceed normally
            session[f'invite_{invite.id}_plex_user'] = {
                'id': getattr(plex_account, 'id', None), 
                'uuid': getattr(plex_account, 'uuid', None), 
                'username': getattr(plex_account, 'username', None), 
                'email': getattr(plex_account, 'email', None), 
                'thumb': getattr(plex_account, 'thumb', None)
            }
            log_event(EventType.INVITE_USED_SUCCESS_PLEX, f"Plex auth success for {plex_account.localUsername} on invite {invite.id}.", invite_id=invite.id)
            current_app.logger.info(f"New Plex user {plex_account.localUsername} - proceeding with invite")

    except PlexApiException as e_plex:
        flash(f'Plex API error: {str(e_plex)}', 'danger')
        log_event(EventType.ERROR_PLEX_API, f"Invite {invite.id}: Plex PIN check PlexApiException: {e_plex}", invite_id=invite.id)
    except Exception as e: 
        flash(f"Error during Plex login for invite: {str(e)[:150]}", "danger")
        log_event(EventType.ERROR_PLEX_API, f"Invite {invite.id}: Plex callback error: {e}", invite_id=invite.id)
    finally: 
        session.pop('plex_oauth_invite_id', None)
        session.pop('plex_pin_code_invite_flow', None)
        session.pop('plex_headers_invite_flow', None)
        
    return redirect(fallback_redirect)

@invites_bp.route('/discord_callback')
@setup_required
def discord_oauth_callback():
    invite_id_from_session = session.get('discord_oauth_invite_id')
    returned_state = request.args.get('state')
    
    invite_path_for_redirect_on_error = "unknown_invite_path"
    invite_object_for_redirect = None
    if invite_id_from_session:
        invite_object_for_redirect = Invite.query.get(invite_id_from_session)
        if invite_object_for_redirect:
            invite_path_for_redirect_on_error = invite_object_for_redirect.custom_path or invite_object_for_redirect.token
    
    public_invite_page_url_with_path = url_for('public_spa.invite_token_spa', invite_path_or_token=invite_path_for_redirect_on_error)
    generic_invite_landing_url = url_for('public_spa.invite_landing_spa')

    if not invite_id_from_session or not returned_state or returned_state != session.pop('discord_oauth_state_invite', None):
        flash('Discord login failed: Invalid session or state. Please try the invite link again.', 'danger')
        current_app.logger.warning("Discord OAuth Callback: Invalid state or missing invite_id in session.")
        return redirect(public_invite_page_url_with_path if invite_object_for_redirect else generic_invite_landing_url)

    if not invite_object_for_redirect:
        flash('Discord login failed: Invite information is no longer available. Please try a fresh invite link.', 'danger')
        current_app.logger.warning(f"Discord OAuth Callback: Invite ID {invite_id_from_session} not found in DB after state check.")
        return redirect(generic_invite_landing_url)

    return_path = session.get(f'invite_{invite_object_for_redirect.id}_return_path')
    if return_path:
        public_invite_page_url_with_path = return_path

    code = request.args.get('code')
    if not code:
        error_description = request.args.get("error_description", "Authentication with Discord failed. No authorization code received.")
        flash(f'Discord login failed: {error_description}', 'danger')
        log_event(EventType.ERROR_DISCORD_API, f"Discord OAuth callback failed (no code): {error_description}", invite_id=invite_id_from_session)
        return redirect(public_invite_page_url_with_path)

    client_id = Setting.get('DISCORD_CLIENT_ID')
    client_secret = Setting.get('DISCORD_CLIENT_SECRET')
    redirect_uri_for_token_exchange = Setting.get('DISCORD_REDIRECT_URI_INVITE') 
    
    if not (client_id and client_secret and redirect_uri_for_token_exchange):
        flash('Discord integration is not properly configured by the admin. Cannot complete login.', 'danger')
        log_event(EventType.ERROR_DISCORD_API, "Discord OAuth callback failed: MUM settings (client_id/secret/redirect_uri_invite) missing.", invite_id=invite_id_from_session)
        return redirect(public_invite_page_url_with_path)

    token_url = f"{DISCORD_API_BASE_URL}/oauth2/token"
    payload = {
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirect_uri_for_token_exchange
    }
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}

    try:
        timeout = get_api_timeout()
        token_response = requests.post(token_url, data=payload, headers=headers, timeout=timeout)
        token_response.raise_for_status()
        token_data = token_response.json()
        access_token = token_data['access_token']
        
        user_info_url = f"{DISCORD_API_BASE_URL}/users/@me"
        auth_headers = {'Authorization': f'Bearer {access_token}'}
        user_response = requests.get(user_info_url, headers=auth_headers, timeout=timeout)
        user_response.raise_for_status()
        discord_user_data = user_response.json()
        
        discord_username_from_oauth = f"{discord_user_data['username']}#{discord_user_data['discriminator']}" if discord_user_data.get('discriminator') and discord_user_data.get('discriminator') != '0' else discord_user_data['username']
        
        # Determine the effective "Require Guild Membership" setting for this specific invite
        if invite_object_for_redirect.require_discord_guild_membership:
            effective_require_guild = invite_object_for_redirect.require_discord_guild_membership
        else:
            effective_require_guild = Setting.get_bool('DISCORD_REQUIRE_GUILD_MEMBERSHIP', False)
        
        if effective_require_guild:
            current_app.logger.info(f"Discord OAuth Callback: Guild membership is required for invite {invite_object_for_redirect.id}.")
            configured_guild_id_str = Setting.get('DISCORD_GUILD_ID')
            if not configured_guild_id_str or not configured_guild_id_str.isdigit():
                flash('Server configuration error: Target Discord Server ID for membership check is not set or invalid. Please contact admin.', 'danger')
                session.pop('discord_oauth_invite_id', None)
                return redirect(public_invite_page_url_with_path)
            
            configured_guild_id = int(configured_guild_id_str)
            user_guilds_url = f"{DISCORD_API_BASE_URL}/users/@me/guilds"
            guilds_response = requests.get(user_guilds_url, headers=auth_headers, timeout=timeout)
            guilds_response.raise_for_status()
            user_guilds_list = guilds_response.json()
            is_member = any(str(g.get('id')) == str(configured_guild_id) for g in user_guilds_list)

            if not is_member:
                server_invite_link = Setting.get('DISCORD_SERVER_INVITE_URL')
                error_html = "To accept this invite, you must be a member of our Discord server."
                if server_invite_link: error_html += f" Please join using the button below and then attempt to link your Discord account again on the invite page."
                else: error_html += " Please contact an administrator for an invite to the server."
                flash(Markup(error_html), 'warning')
                log_event(EventType.DISCORD_BOT_GUILD_MEMBER_CHECK_FAIL, f"User {discord_username_from_oauth} (ID: {discord_user_data['id']}) failed guild membership check for guild {configured_guild_id}.", invite_id=invite_object_for_redirect.id)
                session.pop('discord_oauth_invite_id', None)
                return redirect(public_invite_page_url_with_path)
        
        # If all checks pass, store all relevant info in the session
        discord_user_info_for_session = {
            'id': discord_user_data.get('id'), 
            'username': discord_username_from_oauth,
            'avatar': discord_user_data.get('avatar'),
            'email': discord_user_data.get('email'),
            'verified': discord_user_data.get('verified')
        }
        session[f'invite_{invite_object_for_redirect.id}_discord_user'] = discord_user_info_for_session
        log_event(EventType.INVITE_USED_SUCCESS_DISCORD, f"Discord auth success for {discord_username_from_oauth} on invite {invite_object_for_redirect.id}.", invite_id=invite_object_for_redirect.id)

    except requests.exceptions.HTTPError as e_http:
        error_message = f"Discord API Error ({e_http.response.status_code})"
        try: 
            error_json = e_http.response.json()
            error_message = error_json.get('error_description', error_json.get('message', error_message))
        except ValueError: 
            error_message = e_http.response.text[:200] if e_http.response.text else error_message
        flash(f'Failed to link Discord: {error_message}', 'danger')
        log_event(EventType.ERROR_DISCORD_API, f"Invite {invite_id_from_session}: Discord callback HTTPError: {error_message}", invite_id=invite_id_from_session, details={'status_code': e_http.response.status_code})

    except Exception as e_gen:
        flash('An unexpected error occurred during Discord login. Please try again.', 'danger')
        log_event(EventType.ERROR_DISCORD_API, f"Invite {invite_id_from_session}: Unexpected Discord callback error: {e_gen}", invite_id=invite_id_from_session, details={'error': str(e_gen)})
    finally:
        session.pop('discord_oauth_invite_id', None) 

    return redirect(public_invite_page_url_with_path)
