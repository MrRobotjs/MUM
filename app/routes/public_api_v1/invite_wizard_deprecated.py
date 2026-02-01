"""DEPRECATED: Public API v1 invite wizard (use /api/v2/invite-wizard endpoints)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4

import requests
from flask import jsonify, request, session, current_app, url_for, g
from urllib.parse import urlencode

from app.routes.public_api_v1 import bp
from app.models import Invite, User, UserType, Setting
from app.extensions import db
from app.services import invite_service
from app.services.media_service_factory import MediaServiceFactory
from app.utils.timezone_utils import utcnow


def _response_meta(request_id: str) -> Dict[str, Any]:
    return {
        'request_id': request_id,
        'generated_at': datetime.utcnow().isoformat() + 'Z',
    }


def _error_response(request_id: str, status_code: int, code: str, message: str):
    payload = {
        'error': {
            'code': code,
            'message': message,
        },
        'meta': _response_meta(request_id),
    }
    return jsonify(payload), status_code


def _get_invite(token_or_path: str) -> Optional[Invite]:
    return Invite.query.filter(
        (Invite.token == token_or_path) | (Invite.custom_path == token_or_path)
    ).first()


def _serialize_libraries(library_dict: Dict[str, str]) -> List[Dict[str, str]]:
    return [
        {'id': library_id, 'name': library_name}
        for library_id, library_name in library_dict.items()
    ]


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
    account_data_sanitized = {
        'username': account_data.get('username'),
        'email': account_data.get('email'),
        'password': account_data.get('password'),
    } if account_data else None

    cross_server_prefs = session.get(f'{prefix}cross_server_prefs', {}) if allow_user_accounts else {}
    use_same_username = bool(cross_server_prefs.get('use_same_username'))
    use_same_email = bool(cross_server_prefs.get('use_same_email'))
    use_same_password = bool(cross_server_prefs.get('use_same_password'))

    oauth_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    require_discord_auth = bool(invite.require_discord_auth)
    require_discord_guild = bool(invite.require_discord_guild_membership)
    discord_guild_id = Setting.get('DISCORD_GUILD_ID')
    discord_invite_url = Setting.get('DISCORD_SERVER_INVITE_URL')

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
                        db_library = MediaLibrary.query.filter_by(
                            server_id=server.id,
                            external_id=lib.get('external_id')
                        ).first()
                        if db_library and db_library.internal_id:
                            libraries[db_library.internal_id] = lib['name']
                    else:
                        external_id = lib.get('external_id')
                        if external_id:
                            libraries[external_id] = lib['name']
        except Exception as exc:
            current_app.logger.error(
                "Failed to fetch libraries for server %s (%s): %s",
                server.server_nickname,
                server.service_type.name,
                exc,
            )

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
                current_app.logger.warning(
                    "Could not check username on %s: %s",
                    server.server_nickname,
                    exc,
                )
                username_conflicts[server.id] = False

    invite_steps: List[Dict[str, Any]] = []
    if allow_user_accounts:
        invite_steps.append({
            'id': 'user_account',
            'name': 'Account Details',
            'icon': 'fa-solid fa-user-plus',
            'required': True,
            'completed': user_account_created,
        })

    if oauth_enabled:
        invite_steps.append({
            'id': 'discord',
            'name': 'Discord Login',
            'icon': 'fa-brands fa-discord',
            'required': require_discord_auth,
            'completed': already_authenticated_discord_user is not None,
        })

    if has_plex_servers:
        plex_server = next((srv for srv in invite.servers if srv.service_type.name.upper() == 'PLEX'), None)
        plex_name = plex_server.server_nickname if plex_server else 'Plex'
        invite_steps.append({
            'id': 'plex',
            'name': f'{plex_name} Access',
            'icon': 'fa-solid fa-right-to-bracket',
            'required': True,
            'completed': already_authenticated_plex_user is not None,
        })

    non_plex_servers = [
        server for server in invite.servers
        if server.service_type.name.upper() != 'PLEX'
    ]

    def server_sort_key(server):
        return (
            username_conflicts.get(server.id, False),
            server.server_nickname,
        )

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


@bp.route('/public/invite/<token>/wizard', methods=['GET'])
def get_invite_wizard_state(token):
    request_id = str(uuid4())
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')
    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


@bp.route('/public/invite/<token>/account', methods=['POST'])
def save_invite_account(token):
    request_id = str(uuid4())
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    if not Setting.get_bool('ALLOW_USER_ACCOUNTS', False):
        return _error_response(request_id, 400, 'USER_ACCOUNTS_DISABLED', 'Local account creation is disabled for this server.')

    payload = request.get_json(silent=True) or {}
    required_fields = {'username', 'email', 'password', 'confirm_password'}
    if not required_fields.issubset(payload.keys()):
        return _error_response(request_id, 400, 'INVALID_PAYLOAD', 'Missing required fields for account creation.')

    from app.forms import UserAccountCreationForm

    form = UserAccountCreationForm(meta={'csrf': False})
    form.username.data = (payload.get('username') or '').strip()
    form.email.data = (payload.get('email') or '').strip()
    form.password.data = payload.get('password') or ''
    form.confirm_password.data = payload.get('confirm_password') or ''

    if not form.validate():
        errors = {field: errs for field, errs in form.errors.items()}
        return jsonify({
            'error': {
                'code': 'ACCOUNT_VALIDATION_FAILED',
                'message': 'Account information is invalid.',
                'details': errors,
            },
            'meta': _response_meta(request_id)
        }), 400

    prefix = f'invite_{invite.id}_'
    session[f'{prefix}user_account_data'] = {
        'username': form.username.data,
        'email': form.email.data,
        'password': form.password.data,
    }
    session[f'{prefix}cross_server_prefs'] = {
        'use_same_username': bool(payload.get('use_same_username')),
        'use_same_email': bool(payload.get('use_same_email')),
        'use_same_password': bool(payload.get('use_same_password')),
    }
    session[f'{prefix}user_account_created'] = True

    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


@bp.route('/public/invite/<token>/server/<int:server_id>/credentials', methods=['POST'])
def save_server_credentials(token, server_id):
    request_id = str(uuid4())
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
    mark_completed = payload.get('completed', True)

    prefix = f'invite_{invite.id}_'
    session[f'{prefix}server_{server_id}_credentials'] = credentials
    session[f'{prefix}server_{server_id}_completed'] = bool(mark_completed)

    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


@bp.route('/public/invite/<token>/plex/start', methods=['POST'])
def start_plex_auth(token):
    request_id = str(uuid4())
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
            current_app.logger.error(
                "Plex PIN creation failed for invite %s: %s - %s",
                invite.id,
                pin_response.status_code,
                pin_response.text[:200],
            )
            return _error_response(request_id, 502, 'PLEX_PIN_FAILED', 'Could not initiate Plex login.')

        pin_data = pin_response.json()
        pin_id = pin_data["id"]
        pin_code = pin_data["code"]

        session['plex_pin_code_invite_flow'] = pin_code
        session['plex_pin_id_invite_flow'] = pin_id
        session['plex_client_id_invite_flow'] = client_id
        session['plex_app_name_invite_flow'] = app_name

        app_base_url = Setting.get('APP_BASE_URL', request.url_root.rstrip('/'))
        callback_path = url_for('invites.plex_oauth_callback', _external=False)
        forward_url = f"{app_base_url.rstrip('/')}{callback_path}"

        params = {
            "clientID": client_id,
            "code": pin_code,
            "context[device][product]": app_name,
            "forwardUrl": forward_url,
        }
        encoded = urlencode(params)
        redirect_url = f"https://app.plex.tv/auth#?{encoded}"

        state = _build_invite_state(invite)
        return jsonify({
            'data': {
                'redirect_url': redirect_url,
                'state': state,
            },
            'meta': _response_meta(request_id),
        }), 200
    except Exception as exc:
        current_app.logger.exception("Failed to start Plex auth for invite %s: %s", invite.id, exc)
        return _error_response(request_id, 500, 'PLEX_AUTH_ERROR', 'Unexpected error starting Plex authentication.')


@bp.route('/public/invite/<token>/plex/resolve', methods=['POST'])
def resolve_plex_conflict(token):
    request_id = str(uuid4())
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
        session[f'{prefix}plex_user'] = {
            'username': plex_conflict_info['plex_username'],
            'email': plex_conflict_info.get('plex_email'),
        }
        session.pop(f'{prefix}plex_conflict', None)
    elif action == 'use_different':
        session.pop(f'{prefix}plex_conflict', None)
        session.pop(f'{prefix}plex_user', None)
    else:
        return _error_response(request_id, 400, 'INVALID_ACTION', 'Unsupported Plex conflict action.')

    state = _build_invite_state(invite)
    return jsonify({'data': state, 'meta': _response_meta(request_id)}), 200


@bp.route('/public/invite/<token>/discord/start', methods=['POST'])
def start_discord_auth(token):
    request_id = str(uuid4())
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
    redirect_uri = Setting.get('DISCORD_REDIRECT_URI_INVITE') or url_for('invites.discord_oauth_callback', _external=True)

    if provided_oauth_url:
        from urllib.parse import urlparse, parse_qs, urlunparse, urlencode

        parsed_url = urlparse(provided_oauth_url)
        query = parse_qs(parsed_url.query)
        query['state'] = [state_token]
        if query.get('redirect_uri', [None])[0] != redirect_uri:
            query['redirect_uri'] = [redirect_uri]
        final_query = urlencode(query, doseq=True)
        redirect_url = urlunparse(parsed_url._replace(query=final_query))
    else:
        from urllib.parse import urlencode

        params = {
            'client_id': client_id,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': 'identify email guilds',
            'state': state_token,
        }
        redirect_url = f"https://discord.com/api/v10/oauth2/authorize?{urlencode(params)}"

    state = _build_invite_state(invite)
    return jsonify({
        'data': {
            'redirect_url': redirect_url,
            'state': state,
        },
        'meta': _response_meta(request_id),
    }), 200


@bp.route('/public/invite/<token>/complete', methods=['POST'])
def complete_invite(token):
    request_id = str(uuid4())
    invite = _get_invite(token)
    if not invite:
        return _error_response(request_id, 404, 'INVITE_NOT_FOUND', 'Invite not found.')

    prefix = f'invite_{invite.id}_'
    plex_user = session.get(f'{prefix}plex_user')
    discord_user = session.get(f'{prefix}discord_user')
    plex_conflict = session.get(f'{prefix}plex_conflict')

    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    account_created = session.get(f'{prefix}user_account_created', False)
    account_data = session.get(f'{prefix}user_account_data') if account_created else None

    has_plex_servers = any(server.service_type.name.upper() == 'PLEX' for server in invite.servers)
    oauth_enabled = Setting.get_bool('DISCORD_OAUTH_ENABLED', False)
    requires_discord = bool(invite.require_discord_auth)

    if has_plex_servers and not plex_user:
        return _error_response(request_id, 400, 'PLEX_REQUIRED', 'Please sign in with Plex before completing the invite.')

    if requires_discord and oauth_enabled and not discord_user:
        return _error_response(request_id, 400, 'DISCORD_REQUIRED', 'Discord account linking is required for this invite.')

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

        session.pop(f'{prefix}plex_user', None)
        session.pop(f'{prefix}discord_user', None)
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