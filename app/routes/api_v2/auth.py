from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from flask import jsonify, request, current_app, g, url_for, session, redirect, flash
## Flask-Login removed (JWT-only)
from sqlalchemy import func
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.extensions import db
from app.models import User, UserType, Setting, EventType
from app.routes.api_v2 import api_v2
from app.utils.helpers import log_event
from app.utils.timeout_helper import get_api_timeout
from plexapi.myplex import MyPlexAccount
from plexapi.exceptions import PlexApiException
import requests
from urllib.parse import urlencode
from urllib.parse import urlencode
import requests
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    jwt_required,
    get_jwt_identity,
    get_jwt,
    set_refresh_cookies,
    set_access_cookies,
    unset_jwt_cookies,
    verify_jwt_in_request,
)
from app.utils.jwt_decorators import jwt_required_with_user
from app.utils.jwt_helpers import make_access_token, make_refresh_token, set_refresh_cookie, clear_jwt_cookies, revoke_token


auth_tag = Tag(name="Authentication", description="Authentication and session management")


def _serialize_user(user: User | None) -> dict | None:
    if not user:
        return None
    return {
        'uuid': user.uuid,
        'username': user.localUsername or user.external_username,
        'email': user.email or user.discord_email,
        'user_type': user.userType.value if hasattr(user.userType, 'value') else str(user.userType),
        'display_name': getattr(user, 'get_display_name', lambda: None)(),
        'permissions': [role.name for role in getattr(user, 'admin_roles', [])],
        'admin_roles': [role.name for role in getattr(user, 'admin_roles', [])],
        'user_roles': [role.name for role in getattr(user, 'user_roles', [])],
        'has_admin_access': getattr(user, 'has_admin_access', lambda: False)(),
        'is_active': getattr(user, 'is_active', True),
        'last_login_at': user.last_login_at.isoformat() if getattr(user, 'last_login_at', None) else None,
        'force_password_change': getattr(user, 'force_password_change', False)
    }


def _admin_login_query(identifier: str):
    lowered = identifier.lower()
    return User.query.filter(User.userType.in_([UserType.OWNER, UserType.LOCAL])).filter(func.lower(User.localUsername) == lowered).first()


def _find_admin_user(identifier: str) -> User | None:
    if not identifier:
        return None
    lowered = identifier.strip().lower()
    if not lowered:
        return None
    user = _admin_login_query(lowered)
    if user:
        return user
    return User.query.filter(User.userType.in_([UserType.OWNER, UserType.LOCAL])).filter(func.lower(User.email) == lowered).first()


def _issue_session_payload(user: User | None):
    user_data = _serialize_user(user)
    return {
        'user': user_data,
        'permissions': user_data.get('permissions', []) if user_data else [],
        'feature_flags': {},
        'setup_complete': getattr(g, 'setup_complete', False),
        'force_password_change': getattr(user, 'force_password_change', False) if user else False
    }


    # CSRF token endpoint removed (JWT migration): use Authorization header.


class LogoutResponse(BaseModel):
    data: dict
    meta: dict


class SessionResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


@api_v2.post(
    "/auth/logout",
    tags=[auth_tag],
    summary="Admin logout (no-op; use /auth/jwt/logout)",
    responses={200: LogoutResponse},
)
@jwt_required_with_user()
def admin_logout_v2(current_user):
    request_id = str(uuid4())
    actor = _serialize_user(current_user)
    if actor:
        log_event(EventType.ADMIN_LOGOUT, f"User '{actor.get('username')}' logged out.")
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id, 'deprecated': False}}), 200


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


@api_v2.post(
    "/auth/change-password",
    tags=[auth_tag],
    summary="Change current user's password",
    responses={200: SessionResponse, 400: SessionResponse, 401: SessionResponse, 422: SessionResponse, 500: SessionResponse},
)
@jwt_required_with_user()
def change_password(current_user):
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    current_password = payload.get('current_password') or ''
    new_password = payload.get('new_password') or ''
    if not current_password or not new_password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'current_password and new_password are required.'}, 'meta': {'request_id': request_id}}), 400
    if len(new_password) < 8:
        return jsonify({'error': {'code': 'WEAK_PASSWORD', 'message': 'New password must be at least 8 characters long.'}, 'meta': {'request_id': request_id}}), 422
    if not current_user.check_password(current_password):
        return jsonify({'error': {'code': 'INVALID_CREDENTIALS', 'message': 'Current password is incorrect.'}, 'meta': {'request_id': request_id}}), 401
    current_user.set_password(new_password)
    current_user.force_password_change = False
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to update password: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({'error': {'code': 'PASSWORD_UPDATE_FAILED', 'message': 'Failed to update password.'}, 'meta': {'request_id': request_id}}), 500
    log_event(EventType.ADMIN_PASSWORD_CHANGE, f"Password changed for '{current_user.localUsername}'.", admin_id=current_user.id)
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id, 'deprecated': False}}), 200


class SetPasswordBody(BaseModel):
    new_password: str


@api_v2.post(
    "/auth/set-password",
    tags=[auth_tag],
    summary="Set initial password for flagged accounts",
    responses={200: SessionResponse, 400: SessionResponse, 409: SessionResponse, 422: SessionResponse, 500: SessionResponse},
)
@jwt_required_with_user()
def set_password(current_user):
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    new_password = payload.get('new_password') or ''
    if not new_password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'new_password is required.'}, 'meta': {'request_id': request_id}}), 400
    if len(new_password) < 8:
        return jsonify({'error': {'code': 'WEAK_PASSWORD', 'message': 'New password must be at least 8 characters long.'}, 'meta': {'request_id': request_id}}), 422
    if not current_user.force_password_change and current_user.password_hash:
        return jsonify({'error': {'code': 'PASSWORD_CHANGE_NOT_REQUIRED', 'message': 'Account is not flagged for password reset.'}, 'meta': {'request_id': request_id}}), 409
    current_user.set_password(new_password)
    current_user.force_password_change = False
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to set password: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({'error': {'code': 'PASSWORD_UPDATE_FAILED', 'message': 'Failed to set password.'}, 'meta': {'request_id': request_id}}), 500
    log_event(EventType.ADMIN_PASSWORD_CHANGE, f"Password set for '{current_user.localUsername}'.", admin_id=current_user.id)
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id, 'deprecated': False}}), 200


@api_v2.get(
    "/auth/session",
    tags=[auth_tag],
    summary="Get current session",
    responses={200: SessionResponse},
)
@jwt_required_with_user()
def get_session(current_user):
    request_id = str(uuid4())
    return jsonify({'data': _issue_session_payload(current_user), 'meta': {'request_id': request_id, 'deprecated': False, 'config': {'allow_user_accounts': Setting.get_bool('ALLOW_USER_ACCOUNTS', False)}}}), 200


class JwtLoginBody(BaseModel):
    username: str
    password: str


class JwtLoginResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/jwt/login",
    tags=[auth_tag],
    summary="JWT login (returns access token; sets refresh cookie)",
    responses={200: JwtLoginResponse, 400: JwtLoginResponse, 401: JwtLoginResponse, 409: JwtLoginResponse},
)
def jwt_login():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''

    if not username or not password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'Username and password are required.'}, 'meta': {'request_id': request_id}}), 400
    if not User.get_owner():
        return jsonify({'error': {'code': 'SETUP_REQUIRED', 'message': 'Owner account not configured. Complete setup before logging in.'}, 'meta': {'request_id': request_id}}), 409

    user = _find_admin_user(username)
    if not user or not user.check_password(password):
        log_event(EventType.ADMIN_LOGIN_FAIL, f"Failed admin login attempt for '{username}'.")
        return jsonify({'error': {'code': 'INVALID_CREDENTIALS', 'message': 'Invalid username or password.'}, 'meta': {'request_id': request_id}}), 401
    if not user.is_active:
        return jsonify({'error': {'code': 'ACCOUNT_DISABLED', 'message': 'Account is disabled.'}, 'meta': {'request_id': request_id}}), 403

    # Issue JWTs
    access_token = make_access_token(user)
    refresh_token = make_refresh_token(user)

    user.last_login_at = datetime.utcnow()
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to update last login: {exc}")
        db.session.rollback()

    resp = jsonify({'data': {'access_token': access_token, 'user': _serialize_user(user)}, 'meta': {'request_id': request_id}})
    # Set both access (for browser primitives) and refresh cookies
    try:
        set_access_cookies(resp, access_token)
    except Exception:
        pass
    set_refresh_cookie(resp, refresh_token)
    log_event(EventType.ADMIN_LOGIN_SUCCESS, f"Admin '{user.localUsername}' logged in (JWT).")
    return resp, 200


class JwtRefreshResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/jwt/refresh",
    tags=[auth_tag],
    summary="Refresh access token (uses refresh cookie)",
    responses={200: JwtRefreshResponse, 401: JwtRefreshResponse},
)
@jwt_required(refresh=True)
def jwt_refresh():
    request_id = str(uuid4())
    identity = get_jwt_identity()
    if not identity:
        return jsonify({'error': {'code': 'UNAUTHORIZED', 'message': 'Invalid refresh token.'}, 'meta': {'request_id': request_id}}), 401
    user = User.query.filter_by(uuid=identity).first()
    if not user or not user.is_active:
        return jsonify({'error': {'code': 'FORBIDDEN', 'message': 'Account is disabled.'}, 'meta': {'request_id': request_id}}), 403

    # Optional: rotate refresh token (revoke old; set new)
    old_jti = get_jwt().get('jti')
    if old_jti:
        revoke_token(old_jti, 'refresh', user_uuid=user.uuid)
    new_refresh = make_refresh_token(user)
    new_access = make_access_token(user)

    resp = jsonify({'data': {'access_token': new_access}, 'meta': {'request_id': request_id}})
    try:
        set_access_cookies(resp, new_access)
    except Exception:
        pass
    set_refresh_cookie(resp, new_refresh)
    return resp, 200


class JwtLogoutResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/jwt/logout",
    tags=[auth_tag],
    summary="Logout (revokes refresh; clears cookie)",
    responses={200: JwtLogoutResponse},
)
def jwt_logout():
    request_id = str(uuid4())
    # Try to revoke refresh token if present and valid
    # Use verify_jwt_in_request with optional=True to avoid 422 errors
    try:
        verify_jwt_in_request(optional=True, refresh=True)
        jwt_data = get_jwt()
        jti = jwt_data.get('jti') if jwt_data else None
        identity = get_jwt_identity()
        if jti and identity:
            revoke_token(jti, 'refresh', user_uuid=identity)
    except Exception:
        # If token is invalid/missing/expired, continue with cleanup anyway
        # Logout should always succeed to clear client-side state
        pass
    resp = jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}})
    clear_jwt_cookies(resp)
    return resp, 200


class RedirectResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/plex/start",
    tags=[auth_tag],
    summary="Initiate Plex SSO for admin (returns redirect URL)",
    responses={200: RedirectResponse, 400: RedirectResponse, 500: RedirectResponse},
)
def start_admin_plex_sso():
    request_id = str(uuid4())
    try:
        app_name = Setting.get('APP_NAME', 'MUM')
        client_id = "MUM-AdminLogin"

        # Create PIN with Plex API
        pin_response = requests.post(
            "https://plex.tv/api/v2/pins",
            headers={"Accept": "application/json"},
            data={"strong": "true", "X-Plex-Product": app_name, "X-Plex-Client-Identifier": client_id},
        )
        if pin_response.status_code != 201:
            return jsonify({'error': {'code': 'PLEX_PIN_CREATE_FAILED', 'message': f'Failed to create PIN: {pin_response.status_code}'}, 'meta': {'request_id': request_id}}), 500
        pin_data = pin_response.json()
        pin_id = pin_data.get('id')
        pin_code = pin_data.get('code')
        if not pin_id or not pin_code:
            return jsonify({'error': {'code': 'PLEX_PIN_INVALID', 'message': 'PIN response missing id or code.'}, 'meta': {'request_id': request_id}}), 500

        # Store session details for callback
        session['plex_pin_id_admin_login'] = pin_id
        session['plex_pin_code_admin_login'] = pin_code
        session['plex_client_id_admin_login'] = client_id
        session['plex_app_name_admin_login'] = app_name

        app_base_url = Setting.get('APP_BASE_URL', request.url_root.rstrip('/'))
        callback_url = url_for('api_v2.plex_sso_callback_admin_v2', _external=True)
        encoded = urlencode({
            "clientID": client_id,
            "code": pin_code,
            "context[device][product]": app_name,
            "forwardUrl": callback_url,
        })
        redirect_url = f"https://app.plex.tv/auth#?{encoded}"

        # Decide where to go after callback
        session['plex_admin_login_next_url'] = request.args.get('next') or '/admin/dashboard'

        return jsonify({'data': {'redirect_url': redirect_url}, 'meta': {'request_id': request_id}}), 200
    except Exception as exc:
        current_app.logger.error(f"Failed to start Plex SSO: {exc}", exc_info=True)
        return jsonify({'error': {'code': 'PLEX_SSO_START_FAILED', 'message': 'Unable to initiate Plex SSO.'}, 'meta': {'request_id': request_id}}), 500


@api_v2.post(
    "/auth/discord/link",
    tags=[auth_tag],
    summary="Initiate Discord link for admin (returns redirect URL)",
    responses={200: RedirectResponse, 400: RedirectResponse, 500: RedirectResponse},
)
@jwt_required_with_user()
def start_admin_discord_link(current_user):
    request_id = str(uuid4())
    try:
        enabled_setting_val = Setting.get('DISCORD_OAUTH_ENABLED', False)
        client_id_val = Setting.get('DISCORD_CLIENT_ID')
        app_base_url_val = Setting.get('APP_BASE_URL')

        if not (isinstance(enabled_setting_val, bool) and enabled_setting_val) and str(enabled_setting_val).lower() != 'true':
            return jsonify({'error': {'code': 'DISCORD_DISABLED', 'message': 'Discord OAuth is not enabled.'}, 'meta': {'request_id': request_id}}), 400
        if not client_id_val or not app_base_url_val:
            return jsonify({'error': {'code': 'DISCORD_NOT_CONFIGURED', 'message': 'Discord client_id or APP_BASE_URL missing.'}, 'meta': {'request_id': request_id}}), 400

        from flask import session
        session['discord_oauth_state_admin_link'] = str(uuid4())
        redirect_uri = url_for('api_v2.discord_callback_admin_v2', _external=True)
        Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', redirect_uri)

        params = {
            'client_id': client_id_val,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': 'identify email guilds.join',
            'state': session['discord_oauth_state_admin_link'],
            'prompt': 'consent'
        }
        discord_api_base = 'https://discord.com/api/v10'
        redirect_url = f"{discord_api_base}/oauth2/authorize?{urlencode(params)}"
        return jsonify({'data': {'redirect_url': redirect_url}, 'meta': {'request_id': request_id}}), 200
    except Exception as exc:
        current_app.logger.error(f"Failed to start Discord link: {exc}", exc_info=True)
        return jsonify({'error': {'code': 'DISCORD_LINK_START_FAILED', 'message': 'Unable to initiate Discord link.'}, 'meta': {'request_id': request_id}}), 500


@api_v2.get(
    "/auth/plex/callback",
    tags=[auth_tag],
    summary="Plex SSO callback (admin)",
)
def plex_sso_callback_admin_v2():
    pin_id_from_session = session.get('plex_pin_id_admin_login')
    pin_code_from_session = session.get('plex_pin_code_admin_login')
    client_id_from_session = session.get('plex_client_id_admin_login')

    fallback_url = '/admin/account' if current_user.is_authenticated else '/admin/login'

    if not pin_id_from_session or not pin_code_from_session or not client_id_from_session:
        flash('Plex login callback invalid or session expired.', 'danger')
        session.pop('plex_pin_id_admin_login', None)
        session.pop('plex_pin_code_admin_login', None)
        session.pop('plex_client_id_admin_login', None)
        session.pop('plex_app_name_admin_login', None)
        return redirect(fallback_url)

    try:
        current_app.logger.debug(f"Checking admin PIN status for PIN ID: {pin_id_from_session} (PIN code: {pin_code_from_session})")
        max_retries = 3
        retry_delay = 1
        plex_auth_token = None
        for attempt in range(max_retries):
            try:
                headers = {"accept": "application/json"}
                data = {"code": pin_code_from_session, "X-Plex-Client-Identifier": client_id_from_session}
                check_url = f"https://plex.tv/api/v2/pins/{pin_id_from_session}"
                timeout = get_api_timeout()
                response = requests.get(check_url, headers=headers, data=data, timeout=timeout)
                current_app.logger.debug(f"Admin PIN check - Response status: {response.status_code}")
                if response.status_code == 200:
                    pin_data = response.json()
                    if pin_data.get('authToken'):
                        plex_auth_token = pin_data['authToken']
                        break
            except Exception as e:
                current_app.logger.error(f"Admin PIN check - Error checking PIN via API: {e}")
            if attempt < max_retries - 1:
                time.sleep(retry_delay)
        if not plex_auth_token:
            flash('Plex PIN not yet linked or has expired.', 'warning')
            return redirect(fallback_url)

        plex_account = MyPlexAccount(token=plex_auth_token)
        admin_to_update = current_user
        if not admin_to_update:
            flash(f"Plex account '{plex_account.localUsername}' is not a configured admin.", 'danger')
            return redirect(fallback_url)
        if admin_to_update.plex_uuid and admin_to_update.plex_uuid != plex_account.uuid:
            flash('This Plex account is already linked to a different admin.', 'danger')
            return redirect(fallback_url)

        admin_to_update.plex_uuid = plex_account.uuid
        admin_to_update.plex_username = plex_account.localUsername
        admin_to_update.plex_thumb = plex_account.thumb
        admin_to_update.email = plex_account.email
        admin_to_update.last_login_at = db.func.now()
        db.session.commit()
        log_event(EventType.ADMIN_LOGIN_SUCCESS, f"Admin '{admin_to_update.localUsername or admin_to_update.plex_username}' linked via Plex.", admin_id=admin_to_update.id)

        next_url = session.pop('plex_admin_login_next_url', '/admin/settings/discord')
        return redirect(next_url)
    except PlexApiException as e_plex:
        flash(f'Plex API error: {str(e_plex)}', 'danger')
        current_app.logger.error(f"Plex admin callback PlexApiException: {e_plex}", exc_info=True)
    except Exception as e:
        current_app.logger.error(f"Error during Plex admin callback: {e}", exc_info=True)
        flash(f'An unexpected error occurred: {e}', 'danger')
    session.pop('plex_pin_id_admin_login', None)
    session.pop('plex_pin_code_admin_login', None)
    session.pop('plex_headers_admin_login', None)
    return redirect(fallback_url)


@api_v2.get(
    "/auth/discord/callback",
    tags=[auth_tag],
    summary="Discord link callback (admin)",
)
@jwt_required_with_user()
def discord_callback_admin_v2(current_user):
    returned_state = request.args.get('state')
    if not returned_state or returned_state != session.pop('discord_oauth_state_admin_link', None):
        flash('Discord linking failed: Invalid state.', 'danger')
        return redirect('/admin/settings/discord')
    code = request.args.get('code')
    if not code:
        flash(f"Discord linking failed: {request.args.get('error_description', 'No code.')}", 'danger')
        return redirect('/admin/settings/discord')
    client_id = Setting.get('DISCORD_CLIENT_ID')
    client_secret = Setting.get('DISCORD_CLIENT_SECRET')
    redirect_uri = Setting.get('DISCORD_REDIRECT_URI_ADMIN_LINK')
    if not client_id or not client_secret or not redirect_uri:
        flash('Discord app details not fully configured in MUM settings.', 'danger')
        return redirect('/admin/settings/discord')
    token_url = "https://discord.com/api/v10/oauth2/token"
    payload = {
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirect_uri,
    }
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}
    try:
        token_response = requests.post(token_url, data=payload, headers=headers)
        token_response.raise_for_status()
        token_data = token_response.json()
        access_token = token_data['access_token']
        refresh_token = token_data.get('refresh_token')
        expires_in = token_data['expires_in']
        token_expires_at = datetime.utcnow() + timedelta(seconds=expires_in)
        user_info_url = "https://discord.com/api/v10/users/@me"
        auth_headers = {'Authorization': f'Bearer {access_token}'}
        user_response = requests.get(user_info_url, headers=auth_headers)
        user_response.raise_for_status()
        discord_user = user_response.json()
        admin_to_update = current_user
        existing_link = User.query.filter(User.id != admin_to_update.id, User.discord_user_id == discord_user['id']).first()
        if existing_link:
            flash(f"Discord account '{discord_user['username']}' is already linked to another admin.", 'danger')
            return redirect('/admin/settings/discord')
        admin_to_update.discord_user_id = discord_user['id']
        admin_to_update.discord_username = discord_user['username'] if discord_user.get('discriminator') in (None, '0') else f"{discord_user['username']}#{discord_user['discriminator']}"
        admin_to_update.discord_avatar_hash = discord_user.get('avatar')
        admin_to_update.discord_email = discord_user.get('email')
        admin_to_update.discord_email_verified = discord_user.get('verified')
        admin_to_update.discord_access_token = access_token
        admin_to_update.discord_refresh_token = refresh_token
        admin_to_update.discord_token_expires_at = token_expires_at
        db.session.commit()
        log_event(EventType.DISCORD_ADMIN_LINK_SUCCESS, f"Admin '{admin_to_update.localUsername or admin_to_update.plex_username}' linked Discord '{admin_to_update.discord_username}'.", admin_id=admin_to_update.id)
        flash('Discord account linked successfully!', 'success')
    except requests.exceptions.RequestException as e:
        error_detail = str(e)
        if getattr(e, 'response', None) is not None:
            try:
                error_detail = e.response.json().get('error_description', str(e.response.text))
            except Exception:
                error_detail = str(e.response.content)
        current_app.logger.error(f"Discord OAuth admin error: {error_detail}", exc_info=True)
        flash(f'Failed to link Discord: {error_detail}', 'danger')
    except Exception as e_gen:
        current_app.logger.error(f"Unexpected error during Discord admin link callback: {e_gen}", exc_info=True)
        flash('An unexpected error occurred while linking Discord.', 'danger')
    return redirect('/admin/settings/discord')


class UnlinkResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/discord/unlink",
    tags=[auth_tag],
    summary="Unlink Discord from current admin",
    responses={200: UnlinkResponse},
)
@jwt_required_with_user()
def discord_unlink_admin_v2(current_user):
    request_id = str(uuid4())
    discord_username_log = getattr(current_user, 'discord_username', None)
    current_user.discord_user_id = None
    current_user.discord_username = None
    current_user.discord_avatar_hash = None
    current_user.discord_access_token = None
    current_user.discord_refresh_token = None
    current_user.discord_token_expires_at = None
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to unlink Discord: {exc}")
        db.session.rollback()
        return jsonify({'error': {'code': 'DISCORD_UNLINK_FAILED', 'message': 'Unable to unlink Discord.'}, 'meta': {'request_id': request_id}}), 500
    log_event(EventType.DISCORD_ADMIN_UNLINK, f"Admin '{current_user.localUsername or current_user.plex_username}' unlinked Discord '{discord_username_log}'.", admin_id=current_user.id)
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}}), 200
