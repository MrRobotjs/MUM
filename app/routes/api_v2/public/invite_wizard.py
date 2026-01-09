from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4

import requests
from flask import jsonify, request, session, current_app, url_for, g, redirect
from urllib.parse import urlencode
from pydantic import BaseModel

from app.models import Invite, User, UserType, Setting, EventType
from app.extensions import db
from app.services import invite_service
from app.services.media_service_factory import MediaServiceFactory
from app.utils.timezone_utils import utcnow

from . import api_v2_public, public_wizard_tag
import time

# Discord API base URL for OAuth interactions
DISCORD_API_BASE_URL = 'https://discord.com/api/v10'


def _response_meta(request_id: str) -> Dict[str, Any]:
    return {'request_id': request_id, 'generated_at': datetime.utcnow().isoformat() + 'Z'}


def _error_response(request_id: str, status_code: int, code: str, message: str):
    payload = {'error': {'code': code, 'message': message}, 'meta': _response_meta(request_id)}
    return jsonify(payload), status_code


def _get_invite(token_or_path: str) -> Optional[Invite]:
    return Invite.query.filter((Invite.token == token_or_path) | (Invite.custom_path == token_or_path)).first()


def _serialize_libraries(library_dict: Dict[str, str]) -> List[Dict[str, str]]:
    return [{'id': library_id, 'name': library_name} for library_id, library_name in library_dict.items()]


def _server_access_url(server) -> Optional[str]:
    service_type = server.service_type.name.upper()
    if service_type == 'PLEX':
        return "https://app.plex.tv"
    if hasattr(server, 'url') and server.url:
        return server.url
    return None


def _build_invite_state(invite: Invite) -> Dict[str, Any]:
    prefix = f'invite_{invite.id}_'

    already_authenticated_plex_user = session.get(f'{prefix}plex_user')
    already_authenticated_discord_user = session.get(f'{prefix}discord_user')
    plex_conflict_info = session.get(f'{prefix}plex_conflict')

    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    user_account_created = session.get(f'{prefix}user_account_created', False)
    account_data = session.get(f'{prefix}user_account_data', {}) if allow_user_accounts else {}
    account_data_sanitized = {'username': account_data.get('username'), 'email': account_data.get('email'), 'password': account_data.get('password')} if account_data else None

    cross_server_prefs = session.get(f'{prefix}cross_server_prefs', {}) if allow_user_accounts else {}
    use_same_username = bool(cross_server_prefs.get('use_same_username'))
    use_same_email = bool(cross_server_prefs.get('use_same_email'))
    use_same_password = bool(cross_server_prefs.get('use_same_password'))

    oauth_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    require_discord_auth = bool(invite.require_discord_auth)
    require_discord_guild = bool(invite.require_discord_guild_membership)
    discord_guild_id = Setting.get('DISCORD_GUILD_ID')
    discord_invite_url = Setting.get('DISCORD_SERVER_INVITE_URL')
    guild_verified = session.get(f'{prefix}discord_guild_verified')
    guild_error = session.get(f'{prefix}discord_guild_error')
    if not require_discord_guild:
        guild_verified = None
        guild_error = None

    has_plex_servers = any(server.service_type.name.upper() == 'PLEX' for server in invite.servers)
    servers_with_libraries: Dict[int, Dict[str, Any]] = {}
    for server in invite.servers or []:
        libraries = {}
        try:
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                fetched_libraries = service.get_libraries()
                for lib in fetched_libraries:
                    if server.service_type.value == 'kavita':
                        from app.models_media_services import MediaLibrary
                        db_library = MediaLibrary.query.filter_by(server_id=server.id, external_id=lib.get('external_id')).first()
                        if db_library and db_library.internal_id:
                            libraries[db_library.internal_id] = lib['name']
                    else:
                        external_id = lib.get('external_id')
                        if external_id:
                            libraries[external_id] = lib['name']
        except Exception as exc:
            current_app.logger.error("Failed to fetch libraries for server %s (%s): %s", server.server_nickname, server.service_type.name, exc)

        servers_with_libraries[server.id] = {
            'id': server.id,
            'name': server.server_nickname,
            'service_type': server.service_type.name.upper(),
            'libraries': libraries,
            'completed': session.get(f'{prefix}server_{server.id}_completed', False),
            'credentials': session.get(f'{prefix}server_{server.id}_credentials', {}),
            'access_url': _server_access_url(server),
        }

    local_username = account_data.get('username') if account_data else ''

    username_conflicts: Dict[int, bool] = {}
    if use_same_username and local_username:
        for server in invite.servers:
            if server.service_type.name.upper() == 'PLEX':
                continue
            try:
                service = MediaServiceFactory.create_service_from_db(server)
                if hasattr(service, 'check_username_exists'):
                    exists = service.check_username_exists(local_username)
                    username_conflicts[server.id] = bool(exists)
                else:
                    username_conflicts[server.id] = False
            except Exception as exc:
                current_app.logger.warning("Could not check username on %s: %s", server.server_nickname, exc)
                username_conflicts[server.id] = False

    invite_steps: List[Dict[str, Any]] = []
    if allow_user_accounts:
        invite_steps.append({'id': 'user_account', 'name': 'Account Details', 'icon': 'fa-solid fa-user-plus', 'required': True, 'completed': user_account_created})

    if oauth_enabled:
        invite_steps.append({'id': 'discord', 'name': 'Discord Login', 'icon': 'fa-brands fa-discord', 'required': require_discord_auth, 'completed': already_authenticated_discord_user is not None})

    if has_plex_servers:
        plex_server = next((srv for srv in invite.servers if srv.service_type.name.upper() == 'PLEX'), None)
        plex_name = plex_server.server_nickname if plex_server else 'Plex'
        invite_steps.append({'id': 'plex', 'name': f'{plex_name} Access', 'icon': 'fa-solid fa-right-to-bracket', 'required': True, 'completed': already_authenticated_plex_user is not None})

    non_plex_servers = [server for server in invite.servers if server.service_type.name.upper() != 'PLEX']

    def server_sort_key(server):
        return (username_conflicts.get(server.id, False), server.server_nickname)

    for server in sorted(non_plex_servers, key=server_sort_key):
        invite_steps.append({
            'id': f'server_access_{server.id}',
            'name': f'{server.server_nickname} Access',
            'icon': 'fa-solid fa-server',
            'required': True,
            'completed': servers_with_libraries[server.id]['completed'],
            'server_id': server.id,
            'server_name': server.server_nickname,
            'server_type': server.service_type.name.upper(),
            'username_conflict': username_conflicts.get(server.id, False),
        })

    next_step_id: Optional[str] = None
    for step in invite_steps:
        if step['completed']:
            continue
        if step['id'] == 'user_account':
            next_step_id = step['id']
            break
        if step['id'] == 'discord':
            if allow_user_accounts and not user_account_created:
                next_step_id = 'user_account'
            else:
                next_step_id = step['id']
            break
        if step['id'] == 'plex':
            if allow_user_accounts and not user_account_created:
                next_step_id = 'user_account'
            elif oauth_enabled and require_discord_auth and not already_authenticated_discord_user:
                next_step_id = 'discord'
            else:
                next_step_id = step['id']
            break
        if step['id'].startswith('server_access_'):
            if allow_user_accounts and not user_account_created:
                next_step_id = 'user_account'
                break
            if oauth_enabled and require_discord_auth and not already_authenticated_discord_user:
                next_step_id = 'discord'
                break
            if has_plex_servers and not already_authenticated_plex_user:
                next_step_id = 'plex'
                break
            next_step_id = step['id']
            break

    server_details = []
    for server_id, info in servers_with_libraries.items():
        server_details.append({
            'id': server_id,
            'name': info['name'],
            'service_type': info['service_type'],
            'completed': info['completed'],
            'credentials': info['credentials'],
            'libraries': _serialize_libraries(info['libraries']),
            'username_conflict': username_conflicts.get(server_id, False),
            'access_url': info.get('access_url'),
        })

    server_name = getattr(g, 'app_name', None) or Setting.get('APP_NAME', 'the server')

    # Build per-server features lookup from InviteServerFeature
    server_features_map: Dict[int, Dict[str, Any]] = {}
    for sf in invite.server_features or []:
        server_features_map[sf.server_id] = {
            'allow_downloads': sf.allow_downloads,
            'invite_to_plex_home': sf.invite_to_plex_home,
            'allow_live_tv': sf.allow_live_tv,
            'allow_4k_transcode': sf.allow_4k_transcode,
        }

    # Add features to server_details
    for server_detail in server_details:
        srv_id = server_detail['id']
        # Use per-server override if available, else fall back to invite-level defaults
        if srv_id in server_features_map:
            sf = server_features_map[srv_id]
            server_detail['features'] = {
                'allow_downloads': sf['allow_downloads'] if sf['allow_downloads'] is not None else invite.allow_downloads,
                'invite_to_plex_home': sf['invite_to_plex_home'] if sf['invite_to_plex_home'] is not None else invite.invite_to_plex_home,
                'allow_live_tv': sf['allow_live_tv'] if sf['allow_live_tv'] is not None else invite.allow_live_tv,
                'allow_4k_transcode': sf['allow_4k_transcode'] if sf['allow_4k_transcode'] is not None else invite.allow_4k_transcode,
            }
        else:
            server_detail['features'] = {
                'allow_downloads': invite.allow_downloads,
                'invite_to_plex_home': invite.invite_to_plex_home,
                'allow_live_tv': invite.allow_live_tv,
                'allow_4k_transcode': invite.allow_4k_transcode,
            }

    return {
        'invite': {
            'id': invite.id,
            'token': invite.token,
            'custom_path': invite.custom_path,
            'expires_at': invite.expires_at.isoformat() if invite.expires_at else None,
            'max_uses': invite.max_uses,
            'current_uses': invite.current_uses,
            'is_active': invite.is_active,
            'allow_downloads': invite.allow_downloads,
            'invite_to_plex_home': invite.invite_to_plex_home,
            'allow_live_tv': invite.allow_live_tv,
            'allow_4k_transcode': invite.allow_4k_transcode,
            'membership_duration_days': invite.membership_duration_days,
            'grant_library_ids': invite.grant_library_ids,
            'require_discord_auth': require_discord_auth,
            'require_discord_guild_membership': require_discord_guild,
            'server_count': len(invite.servers or []),
        },
        'steps': invite_steps,
        'next_step_id': next_step_id,
        'plex': {
            'has_plex_servers': has_plex_servers,
            'authenticated': already_authenticated_plex_user is not None,
            'user': already_authenticated_plex_user,
            'conflict': plex_conflict_info,
        },
        'discord': {
            'oauth_enabled': oauth_enabled,
            'requires_auth': require_discord_auth,
            'requires_guild': require_discord_guild,
            'authenticated': already_authenticated_discord_user is not None,
            'user': already_authenticated_discord_user,
            'guild_id': discord_guild_id,
            'invite_url': discord_invite_url,
            'guild_verified': guild_verified,
            'guild_error': guild_error,
        },
        'account': {
            'allowed': allow_user_accounts,
            'completed': bool(user_account_created),
            'data': account_data_sanitized,
            'preferences': {
                'use_same_username': use_same_username,
                'use_same_email': use_same_email,
                'use_same_password': use_same_password,
            }
        },
        'servers': server_details,
        'meta': {
            'server_label': server_name,
            'has_multiple_servers': len(invite.servers or []) > 1,
        }
    }


def _get_discord_invite_redirect_uri() -> str:
    return (
        Setting.get('DISCORD_REDIRECT_URI_INVITE')
        or url_for('api_v2_public.discord_oauth_callback_public_v2', _external=True)
    )


def _handle_discord_oauth_callback(invite: Invite, fallback_path: str):
    returned_state = request.args.get('state')
    if not returned_state or returned_state != session.pop('discord_oauth_state_invite', None):
        session.pop('discord_oauth_invite_id', None)
        return redirect(fallback_path)
    code = request.args.get('code')
    if not code:
        session.pop('discord_oauth_invite_id', None)
        return redirect(fallback_path)
    client_id = Setting.get('DISCORD_CLIENT_ID')
    client_secret = Setting.get('DISCORD_CLIENT_SECRET')
    redirect_uri = _get_discord_invite_redirect_uri()
    if not client_id or not client_secret or not redirect_uri:
        session.pop('discord_oauth_invite_id', None)
        return redirect(fallback_path)
    token_url = f"https://discord.com/api/v10/oauth2/token"
    payload = {
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirect_uri,
    }
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}
    try:
        token_response = requests.post(token_url, data=payload, headers=headers, timeout=10)
        token_response.raise_for_status()
        token_data = token_response.json()
        access_token = token_data['access_token']
        user_info_url = f"https://discord.com/api/v10/users/@me"
        auth_headers = {'Authorization': f'Bearer {access_token}'}
        user_response = requests.get(user_info_url, headers=auth_headers, timeout=10)
        user_response.raise_for_status()
        discord_user = user_response.json()
        prefix = f'invite_{invite.id}_'
        session[f'{prefix}discord_user'] = {
            'id': discord_user.get('id'),
            'username': discord_user.get('username'),
            'email': discord_user.get('email'),
            'avatar': discord_user.get('avatar'),
            'discriminator': discord_user.get('discriminator'),
            'verified': discord_user.get('verified'),
        }
        if invite.require_discord_guild_membership:
            guild_id = Setting.get('DISCORD_GUILD_ID')
            is_member = False
            if guild_id:
                guilds_url = f"{DISCORD_API_BASE_URL}/users/@me/guilds"
                guilds_response = requests.get(guilds_url, headers=auth_headers, timeout=10)
                if guilds_response.ok:
                    try:
                        guilds = guilds_response.json()
                        guild_id_str = str(guild_id)
                        is_member = any(
                            str(guild.get('id')) == guild_id_str
                            for guild in guilds
                            if isinstance(guild, dict)
                        )
                    except Exception:
                        is_member = False
                else:
                    current_app.logger.warning(
                        "Discord guild check failed for invite %s: %s - %s",
                        invite.id,
                        guilds_response.status_code,
                        guilds_response.text[:200],
                    )
            if not is_member:
                session.pop(f'{prefix}discord_user', None)
                session[f'{prefix}discord_guild_verified'] = False
                session[f'{prefix}discord_guild_error'] = "You must join the Discord server before continuing."
            else:
                session[f'{prefix}discord_guild_verified'] = True
                session.pop(f'{prefix}discord_guild_error', None)
    except Exception as exc:
        current_app.logger.error("Discord callback failed for invite %s: %s", invite.id, exc)
    return_path = session.get(f'invite_{invite.id}_return_path')
    session.pop('discord_oauth_invite_id', None)
    return redirect(return_path or fallback_path)


class WizardStateResponse(BaseModel):
    data: dict
    meta: dict


class InvitePath(BaseModel):
    token: str

class InviteServerPath(BaseModel):
    token: str
    server_id: int


@api_v2_public.get(
    "/public/invite/<token>/wizard",
    tags=[public_wizard_tag],
    summary="Get invite wizard state",
    responses={200: WizardStateResponse, 404: WizardStateResponse},
)
def get_invite_wizard_state_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')
    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


@api_v2_public.post(
    "/public/invite/<token>/account",
    tags=[public_wizard_tag],
    summary="Save invite account details",
    responses={200: WizardStateResponse, 400: WizardStateResponse, 404: WizardStateResponse},
)
def save_invite_account_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    if not Setting.get_bool('ALLOW_USER_ACCOUNTS', False):
        return _error_response(request_id, 400, 'USER_ACCOUNTS_DISABLED', 'Local account creation is disabled for this server.')

    payload = request.get_json(silent=True) or {}
    required_fields = {'username', 'email', 'password', 'confirm_password'}
    if not required_fields.issubset(payload.keys()):
        return _error_response(request_id, 400, 'INVALID_PAYLOAD', 'Missing required account fields.')

    username = (payload.get('username') or '').strip()
    email = (payload.get('email') or '').strip()
    password = payload.get('password') or ''
    confirm_password = payload.get('confirm_password') or ''
    prefs = payload.get('preferences') or {}

    if not username or not email or not password:
        return _error_response(request_id, 400, 'INVALID_PAYLOAD', 'Username, email, and password are required.')
    if password != confirm_password:
        return _error_response(request_id, 400, 'PASSWORD_MISMATCH', 'Passwords do not match.')

    prefix = f'invite_{invite.id}_'
    session[f'{prefix}user_account_created'] = True
    session[f'{prefix}user_account_data'] = {'username': username, 'email': email, 'password': password}
    session[f'{prefix}cross_server_prefs'] = {
        'use_same_username': bool(prefs.get('use_same_username')),
        'use_same_email': bool(prefs.get('use_same_email')),
        'use_same_password': bool(prefs.get('use_same_password')),
    }

    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


@api_v2_public.post(
    "/public/invite/<token>/plex/start",
    tags=[public_wizard_tag],
    summary="Start Plex authentication for invite",
    responses={200: WizardStateResponse, 400: WizardStateResponse, 404: WizardStateResponse, 502: WizardStateResponse},
)
def start_plex_auth_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    payload = request.get_json(silent=True) or {}

    prefix = f'invite_{invite.id}_'

    return_path = payload.get('return_path')
    if isinstance(return_path, str) and return_path:
        session[f'{prefix}return_path'] = return_path

    session['plex_oauth_invite_id'] = invite.id

    try:
        app_name = Setting.get('APP_NAME', 'MUM')
        client_id = f"MUM-InvitePlexLink-{str(invite.id)[:8]}"

        pin_response = requests.post(
            "https://plex.tv/api/v2/pins",
            headers={"Accept": "application/json"},
            data={
                "strong": "true",
                "X-Plex-Product": app_name,
                "X-Plex-Client-Identifier": client_id,
            },
            timeout=10,
        )

        if pin_response.status_code != 201:
            current_app.logger.error("Plex PIN creation failed for invite %s: %s - %s", invite.id, pin_response.status_code, pin_response.text[:200])
            return _error_response(request_id, 502, 'PLEX_PIN_FAILED', 'Could not initiate Plex login.')

        pin_data = pin_response.json()
        pin_id = pin_data["id"]
        pin_code = pin_data["code"]

        session['plex_pin_code_invite_flow'] = pin_code
        session['plex_pin_id_invite_flow'] = pin_id
        session['plex_client_id_invite_flow'] = client_id
        session['plex_app_name_invite_flow'] = app_name

        app_base_url = Setting.get('APP_BASE_URL', request.url_root.rstrip('/'))
        callback_url = url_for('api_v2_public.plex_oauth_callback_v2', token=token, _external=True)
        params = {"clientID": client_id, "code": pin_code, "context[device][product]": app_name, "forwardUrl": callback_url}
        encoded = urlencode(params)
        redirect_url = f"https://app.plex.tv/auth#?{encoded}"

        state = _build_invite_state(invite)
        return jsonify({'data': {'redirect_url': redirect_url, 'state': state}, 'meta': _response_meta(request_id)}), 200
    except Exception as exc:
        current_app.logger.exception("Failed to start Plex auth for invite %s: %s", invite.id, exc)
        return _error_response(request_id, 500, 'PLEX_AUTH_ERROR', 'Unexpected error starting Plex authentication.')


@api_v2_public.get(
    "/public/invite/<token>/plex/callback",
    tags=[public_wizard_tag],
    summary="Plex OAuth callback (public invite)",
)
def plex_oauth_callback_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')
    invite_id = invite.id
    pin_code = session.get('plex_pin_code_invite_flow')
    pin_id = session.get('plex_pin_id_invite_flow')
    client_id = session.get('plex_client_id_invite_flow')
    if not pin_code or not pin_id or not client_id:
        return redirect(f"/invite/{token}")
    try:
        headers = {"accept": "application/json"}
        data = {"code": pin_code, "X-Plex-Client-Identifier": client_id}
        check_url = f"https://plex.tv/api/v2/pins/{pin_id}"
        auth_token = None

        # Step 1: Check PIN status to get the auth token
        for _ in range(3):
            resp = requests.get(check_url, headers=headers, data=data, timeout=10)
            if resp.status_code == 200:
                j = resp.json()
                if j.get('authToken'):
                    auth_token = j.get('authToken')
                    current_app.logger.debug(f"Plex callback: Got auth token for invite {invite_id}")
                    break
            time.sleep(1)

        # Step 2: If we got an auth token, fetch the user's account details
        if auth_token:
            user_headers = {
                "accept": "application/json",
                "X-Plex-Token": auth_token,
                "X-Plex-Client-Identifier": client_id,
            }
            user_resp = requests.get("https://plex.tv/api/v2/user", headers=user_headers, timeout=10)
            if user_resp.status_code == 200:
                user_data = user_resp.json()
                session[f'invite_{invite_id}_plex_user'] = {
                    'uuid': user_data.get('uuid'),
                    'username': user_data.get('username'),
                    'email': user_data.get('email'),
                    'thumb': user_data.get('thumb'),
                }
                current_app.logger.info(f"Plex callback: Successfully retrieved user info for invite {invite_id}: username={user_data.get('username')}")
            else:
                current_app.logger.error(f"Plex callback: Failed to fetch user details. Status: {user_resp.status_code}, Response: {user_resp.text[:200]}")
        else:
            current_app.logger.warning(f"Plex callback: No auth token received for invite {invite_id}")

    except Exception as exc:
        current_app.logger.error("Plex callback failed for invite %s: %s", invite_id, exc)
    session.pop('plex_pin_code_invite_flow', None)
    session.pop('plex_headers_invite_flow', None)
    return_path = session.get(f'invite_{invite_id}_return_path')
    return redirect(return_path or f"/invite/{token}")


@api_v2_public.post(
    "/public/invite/<token>/plex/resolve",
    tags=[public_wizard_tag],
    summary="Resolve Plex account conflict",
    responses={200: WizardStateResponse, 400: WizardStateResponse, 404: WizardStateResponse},
)
def resolve_plex_conflict_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    payload = request.get_json(silent=True) or {}
    action = payload.get('action')

    prefix = f'invite_{invite.id}_'
    plex_conflict_info = session.get(f'{prefix}plex_conflict')

    if not plex_conflict_info:
        return _error_response(request_id, 400, 'NO_PLEX_CONFLICT', 'There is no Plex account conflict to resolve.')

    if action == 'link_existing' and plex_conflict_info.get('type') == 'can_link':
        session[f'{prefix}plex_user'] = {'username': plex_conflict_info['plex_username'], 'email': plex_conflict_info.get('plex_email')}
        session.pop(f'{prefix}plex_conflict', None)
    elif action == 'use_different':
        session.pop(f'{prefix}plex_conflict', None)
        session.pop(f'{prefix}plex_user', None)
    else:
        return _error_response(request_id, 400, 'INVALID_ACTION', 'Unsupported Plex conflict action.')

    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


@api_v2_public.post(
    "/public/invite/<token>/discord/start",
    tags=[public_wizard_tag],
    summary="Start Discord OAuth for invite",
    responses={200: WizardStateResponse, 400: WizardStateResponse, 404: WizardStateResponse},
)
def start_discord_auth_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    payload = request.get_json(silent=True) or {}

    if not Setting.get_bool('DISCORD_OAUTH_ENABLED', False):
        return _error_response(request_id, 400, 'DISCORD_OAUTH_DISABLED', 'Discord login is not currently available.')

    client_id = Setting.get('DISCORD_CLIENT_ID')
    if not client_id:
        return _error_response(request_id, 400, 'DISCORD_NOT_CONFIGURED', 'Discord integration is not configured.')

    session['discord_oauth_invite_id'] = invite.id
    state_token = str(uuid4())
    session['discord_oauth_state_invite'] = state_token

    prefix = f'invite_{invite.id}_'
    return_path = payload.get('return_path')
    if isinstance(return_path, str) and return_path:
        session[f'{prefix}return_path'] = return_path

    provided_oauth_url = Setting.get('DISCORD_OAUTH_AUTH_URL')
    if provided_oauth_url:
        oauth_url = (
            provided_oauth_url
            .replace('{STATE}', state_token)
            .replace('%7BSTATE%7D', state_token)
            .replace('%7bSTATE%7d', state_token)
        )
    else:
        redirect_uri = _get_discord_invite_redirect_uri()
        params = {
            'response_type': 'code',
            'client_id': client_id,
            'scope': 'identify email guilds',
            'state': state_token,
            'redirect_uri': redirect_uri,
            'prompt': 'consent',
        }
        oauth_url = f"https://discord.com/api/v10/oauth2/authorize?{urlencode(params)}"

    state = _build_invite_state(invite)
    return jsonify({'data': {'redirect_url': oauth_url, 'state': state}, 'meta': _response_meta(request_id)}), 200


@api_v2_public.post(
    "/public/invite/<token>/server/<int:server_id>/credentials",
    tags=[public_wizard_tag],
    summary="Save per-server credentials in wizard session",
    responses={200: WizardStateResponse, 400: WizardStateResponse, 404: WizardStateResponse},
)
def save_server_credentials_v2(path: InviteServerPath):
    request_id = str(uuid4())
    token = path.token
    server_id = path.server_id
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    if not any(server.id == server_id for server in invite.servers):
        return _error_response(request_id, 404, 'INVITE_SERVER_NOT_FOUND', 'Server is not attached to this invite.')

    payload = request.get_json(silent=True) or {}
    credentials = {
        'username': (payload.get('username') or '').strip(),
        'password': payload.get('password') or '',
        'email': (payload.get('email') or '').strip(),
    }
    mark_completed = bool(payload.get('completed', True))

    prefix = f'invite_{invite.id}_'
    session[f'{prefix}server_{server_id}_credentials'] = credentials
    session[f'{prefix}server_{server_id}_completed'] = mark_completed

    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


class CompletionResponse(BaseModel):
    data: dict
    meta: dict


@api_v2_public.get(
    "/public/invite/<token>/discord/callback",
    tags=[public_wizard_tag],
    summary="Discord OAuth callback (public invite)",
)
def discord_oauth_callback_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')
    return _handle_discord_oauth_callback(invite, f"/invite/{token}")


@api_v2_public.get(
    "/public/discord/callback",
    tags=[public_wizard_tag],
    summary="Discord OAuth callback (public invite)",
)
def discord_oauth_callback_public_v2():
    invite_id = session.get('discord_oauth_invite_id')
    if not invite_id:
        return redirect("/invite")
    invite = Invite.query.get(invite_id)
    if not invite:
        session.pop('discord_oauth_invite_id', None)
        return redirect("/invite")
    fallback_token = invite.custom_path or invite.token
    return _handle_discord_oauth_callback(invite, f"/invite/{fallback_token}")


@api_v2_public.post(
    "/public/invite/<token>/complete",
    tags=[public_wizard_tag],
    summary="Complete invite and grant access",
    responses={200: CompletionResponse, 400: CompletionResponse, 500: CompletionResponse},
)
def complete_invite_v2(path: InvitePath):
    request_id = str(uuid4())
    token = path.token
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    prefix = f'invite_{invite.id}_'
    plex_user = session.get(f'{prefix}plex_user')
    discord_user = session.get(f'{prefix}discord_user')
    plex_conflict = session.get(f'{prefix}plex_conflict')  # unused but kept for parity/logging

    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    account_created = session.get(f'{prefix}user_account_created', False)
    account_data = session.get(f'{prefix}user_account_data') if account_created else None

    has_plex_servers = any(server.service_type.name.upper() == 'PLEX' for server in invite.servers)
    oauth_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    requires_discord = bool(invite.require_discord_auth)

    # Log session state for debugging
    current_app.logger.debug(f"Complete invite {invite.id}: plex_user={plex_user}, discord_user={discord_user}, has_plex_servers={has_plex_servers}")

    # Validate Plex authentication - check both dict existence AND actual username value
    if has_plex_servers and (not plex_user or not plex_user.get('username')):
        current_app.logger.warning(f"Invite {invite.id} completion blocked: Plex servers exist but no valid Plex user. plex_user={plex_user}")
        return _error_response(request_id, 400, 'PLEX_REQUIRED', 'Please sign in with Plex before completing the invite.')

    if requires_discord and oauth_enabled and not discord_user:
        return _error_response(request_id, 400, 'DISCORD_REQUIRED', 'Discord account linking is required for this invite.')

    if invite.require_discord_guild_membership:
        guild_verified = session.get(f'{prefix}discord_guild_verified')
        if guild_verified is not True:
            return _error_response(
                request_id,
                400,
                'DISCORD_GUILD_REQUIRED',
                'You must be a member of the required Discord server before completing the invite.',
            )

    if allow_user_accounts and not account_data:
        return _error_response(request_id, 400, 'ACCOUNT_REQUIRED', 'Account details must be provided before completing the invite.')

    session_servers_completed = [
        session.get(f'{prefix}server_{server.id}_completed', False)
        for server in invite.servers
        if server.service_type.name.upper() != 'PLEX'
    ]
    if session_servers_completed and not all(session_servers_completed):
        return _error_response(request_id, 400, 'SERVERS_INCOMPLETE', 'Please finish configuring all servers before completing the invite.')

    new_local_user: Optional[User] = None
    try:
        if allow_user_accounts and account_data:
            new_local_user = User(
                userType=UserType.LOCAL,
                localUsername=account_data['username'],
                email=account_data['email'],
                created_at=utcnow(),
                used_invite_id=invite.id,
            )
            new_local_user.set_password(account_data['password'])
            db.session.add(new_local_user)
            db.session.flush()

            current_app.logger.info(
                "Created local user account %s for invite %s",
                account_data['username'],
                invite.id,
            )

        success, result = invite_service.accept_invite_and_grant_access(
            invite=invite,
            plex_user_uuid=plex_user.get('uuid') if plex_user else None,
            plex_username=plex_user.get('username') if plex_user else None,
            plex_email=plex_user.get('email') if plex_user else None,
            plex_thumb=plex_user.get('thumb') if plex_user else None,
            discord_user_info=discord_user,
            ip_address=request.remote_addr,
            app_user=new_local_user,
        )

        if not success:
            if new_local_user:
                db.session.rollback()
            return _error_response(request_id, 400, 'INVITE_COMPLETION_FAILED', str(result))

        username = (
            new_local_user.localUsername
            if new_local_user else
            (plex_user.get('username') if plex_user else 'User')
        )
        configured_servers = [
            {
                'name': server.server_nickname,
                'service_type': server.service_type.name.upper(),
                'access_url': _server_access_url(server),
            }
            for server in invite.servers
        ]

        # Clear session markers for this invite
        session.pop(f'{prefix}plex_user', None)
        session.pop(f'{prefix}discord_user', None)
        session.pop(f'{prefix}discord_guild_verified', None)
        session.pop(f'{prefix}discord_guild_error', None)
        session.pop(f'{prefix}plex_conflict', None)
        session.pop(f'{prefix}return_path', None)
        session.pop(f'{prefix}user_account_created', None)
        session.pop(f'{prefix}user_account_data', None)
        session.pop(f'{prefix}cross_server_prefs', None)
        session.pop(f'{prefix}app_user_id', None)
        for server in invite.servers:
            session.pop(f'{prefix}server_{server.id}_completed', None)
            session.pop(f'{prefix}server_{server.id}_credentials', None)

        state = _build_invite_state(invite)
        return jsonify({
            'data': {
                'username': username,
                'servers': configured_servers,
                'state': state,
            },
            'meta': _response_meta(request_id),
        }), 200
    except Exception as exc:
        current_app.logger.exception("Failed to complete invite %s: %s", invite.id, exc)
        db.session.rollback()
        return _error_response(request_id, 500, 'INVITE_COMPLETION_ERROR', 'Unexpected error completing the invite.')
