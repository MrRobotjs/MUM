"""
Authentication-related invite functionality - Plex and Discord auth initiation
"""

import uuid
from flask import redirect, url_for, flash, request, current_app, session
from urllib.parse import urlencode
from app.models import User, UserType, Invite, Setting, EventType
from app.utils.helpers import setup_required, log_event
from app.utils.timeout_helper import get_api_timeout
from . import invites_public_bp as invites_bp
import requests

@invites_bp.route('/plex_auth/<int:invite_id>')
@setup_required
def initiate_plex_auth(invite_id):
    """Initiate Plex authentication for an invite"""
    invite = Invite.query.get_or_404(invite_id)
    session['plex_oauth_invite_id'] = invite.id 
    
    try:
        # Use direct API calls like the sample code instead of plexapi
        # Generate headers like the sample code
        app_name = Setting.get('APP_NAME', 'MUM')
        client_id = f"MUM-InvitePlexLink-{str(invite.id)[:8]}"
        
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
        
        current_app.logger.debug(f"PIN creation - PIN code: {pin_code}")
        current_app.logger.debug(f"PIN creation - PIN ID: {pin_id}")
        
        # Store the necessary details for the callback
        session['plex_pin_code_invite_flow'] = pin_code
        session['plex_pin_id_invite_flow'] = pin_id
        session['plex_client_id_invite_flow'] = client_id
        session['plex_app_name_invite_flow'] = app_name
        
        # Step 2: Generate auth URL like the sample code
        app_base_url = Setting.get('APP_BASE_URL', request.url_root.rstrip('/'))
        callback_path_segment = url_for('invites.plex_oauth_callback', _external=False)
        forward_url_to_our_app = f"{app_base_url.rstrip('/')}{callback_path_segment}"
        
        encoded_params = urlencode({
            "clientID": client_id,
            "code": pin_code,
            "context[device][product]": app_name,
            "forwardUrl": forward_url_to_our_app,
        })
        auth_url_for_user_to_visit = f"https://app.plex.tv/auth#?{encoded_params}"
        
        return redirect(auth_url_for_user_to_visit)
    except Exception as e:
        flash(f"Could not initiate Plex login: {str(e)[:150]}", "danger")
        log_event(EventType.ERROR_PLEX_API, f"Invite {invite.id}: Plex PIN init failed: {e}", invite_id=invite.id)
        return redirect(url_for('public_spa.invite_token_spa', invite_path_or_token=invite.custom_path or invite.token))

@invites_bp.route('/discord_auth/<int:invite_id>')
@setup_required
def initiate_discord_auth(invite_id):
    """Initiate Discord authentication for an invite"""
    invite = Invite.query.get_or_404(invite_id)
    
    oauth_is_generally_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    if not oauth_is_generally_enabled:
        flash("Discord login is not currently available.", "warning")
        return redirect(url_for('public_spa.invite_token_spa', invite_path_or_token=invite.custom_path or invite.token))
    
    admin_provided_oauth_url = Setting.get('DISCORD_OAUTH_AUTH_URL')
    client_id_from_settings = Setting.get('DISCORD_CLIENT_ID')
    
    if admin_provided_oauth_url and client_id_from_settings:
        session['discord_oauth_invite_id'] = invite.id
        session['discord_oauth_state_invite'] = str(uuid.uuid4())
        
        from urllib.parse import urlparse, parse_qs, urlunparse
        parsed_url = urlparse(admin_provided_oauth_url)
        query_params = parse_qs(parsed_url.query)
        query_params['state'] = [session['discord_oauth_state_invite']]
        expected_redirect_uri = Setting.get('DISCORD_REDIRECT_URI_INVITE') or url_for('invites.discord_oauth_callback', _external=True)
        if 'redirect_uri' not in query_params or query_params.get('redirect_uri', [''])[0] != expected_redirect_uri: 
            query_params['redirect_uri'] = [expected_redirect_uri]
        final_query_string = urlencode(query_params, doseq=True)
        final_discord_auth_url = urlunparse((parsed_url.scheme, parsed_url.netloc, parsed_url.path, parsed_url.params, final_query_string, parsed_url.fragment))
        return redirect(final_discord_auth_url)
    elif client_id_from_settings:
        session['discord_oauth_invite_id'] = invite.id
        session['discord_oauth_state_invite'] = str(uuid.uuid4())
        redirect_uri = Setting.get('DISCORD_REDIRECT_URI_INVITE') or url_for('invites.discord_oauth_callback', _external=True)
        required_scopes = "identify email guilds"
        params = {
            'client_id': client_id_from_settings, 
            'redirect_uri': redirect_uri, 
            'response_type': 'code', 
            'scope': required_scopes, 
            'state': session['discord_oauth_state_invite']
        }
        
        DISCORD_API_BASE_URL = 'https://discord.com/api/v10'
        discord_auth_url = f"{DISCORD_API_BASE_URL}/oauth2/authorize?{urlencode(params)}"
        return redirect(discord_auth_url)
    else: 
        flash("Discord integration is not properly configured by admin for login.", "danger")
        return redirect(url_for('public_spa.invite_token_spa', invite_path_or_token=invite.custom_path or invite.token))
