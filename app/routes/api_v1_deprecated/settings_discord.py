from uuid import uuid4

from flask import jsonify, request, current_app, g
from flask_login import login_required, current_user

from app.routes.api_v1_deprecated import bp
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import permission_required, log_event


def _compute_redirects():
    app_base = Setting.get('APP_BASE_URL') or current_app.config.get('APP_BASE_URL') or ''
    app_base = (app_base or '').rstrip('/')
    invite_path = '/invites/discord_callback'
    admin_path = '/auth/discord_callback_admin'
    if not app_base:
        return None, None
    return f"{app_base}{invite_path}", f"{app_base}{admin_path}"


def _serialize_discord_settings():
    invite_redirect, admin_redirect = _compute_redirects()
    stored_client_secret = Setting.get('DISCORD_CLIENT_SECRET')
    stored_bot_token = Setting.get('DISCORD_BOT_TOKEN')
    return {
        'enable_oauth': Setting.get_bool('DISCORD_OAUTH_ENABLED', False),
        'client_id': Setting.get('DISCORD_CLIENT_ID'),
        'client_secret_set': bool(stored_client_secret),
        'oauth_auth_url': Setting.get('DISCORD_OAUTH_AUTH_URL'),
        'redirect_uri_invite': invite_redirect,
        'redirect_uri_admin': admin_redirect,
        'enable_membership_requirement': Setting.get_bool('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', False),
        'guild_id': Setting.get('DISCORD_GUILD_ID'),
        'server_invite_url': Setting.get('DISCORD_SERVER_INVITE_URL'),
        'enable_bot': Setting.get_bool('DISCORD_BOT_ENABLED', False),
        'bot_token_set': bool(stored_bot_token),
        'monitored_role_id': Setting.get('DISCORD_MONITORED_ROLE_ID'),
        'thread_channel_id': Setting.get('DISCORD_THREAD_CHANNEL_ID'),
        'bot_log_channel_id': Setting.get('DISCORD_BOT_LOG_CHANNEL_ID'),
        'whitelist_sharers': Setting.get_bool('DISCORD_BOT_WHITELIST_SHARERS', False),
        'admin_linked': bool(current_user.discord_user_id),
        'admin_user': {
            'username': current_user.discord_username,
            'id': current_user.discord_user_id,
            'avatar': current_user.discord_avatar_hash
        } if current_user.discord_user_id else None
    }


@bp.route('/settings/discord', methods=['GET'])
@login_required
@permission_required('manage_discord_settings')
def get_discord_settings():
    request_id = str(uuid4())
    return jsonify({'data': _serialize_discord_settings(), 'meta': {'request_id': request_id}})


@bp.route('/settings/discord', methods=['PATCH'])
@login_required
@permission_required('manage_discord_settings')
def update_discord_settings():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    enable_oauth = bool(payload.get('enable_oauth', False))
    enable_bot = bool(payload.get('enable_bot', False))
    require_membership = bool(payload.get('enable_membership_requirement', False))

    if (enable_bot or require_membership) and not enable_oauth:
        enable_oauth = True

    client_id = payload.get('client_id')
    client_secret = payload.get('client_secret')
    oauth_auth_url = payload.get('oauth_auth_url')
    guild_id = payload.get('guild_id')
    server_invite_url = payload.get('server_invite_url')
    bot_token = payload.get('bot_token')
    monitored_role_id = payload.get('monitored_role_id')
    thread_channel_id = payload.get('thread_channel_id')
    bot_log_channel_id = payload.get('bot_log_channel_id')
    whitelist_sharers = bool(payload.get('whitelist_sharers', False))

    if enable_oauth:
        existing_client_id = Setting.get('DISCORD_CLIENT_ID')
        if not (client_id or existing_client_id):
            return jsonify({
                'error': {'code': 'CLIENT_ID_REQUIRED', 'message': 'Discord client ID is required when OAuth is enabled.'},
                'meta': {'request_id': request_id}
            }), 400
        existing_secret = Setting.get('DISCORD_CLIENT_SECRET')
        if not (client_secret or existing_secret):
            return jsonify({
                'error': {'code': 'CLIENT_SECRET_REQUIRED', 'message': 'Discord client secret is required when OAuth is enabled.'},
                'meta': {'request_id': request_id}
            }), 400
        if not oauth_auth_url:
            oauth_auth_url = Setting.get('DISCORD_OAUTH_AUTH_URL')
    else:
        enable_bot = False
        require_membership = False

    if enable_bot or require_membership:
        final_guild_id = guild_id or Setting.get('DISCORD_GUILD_ID')
        if not final_guild_id:
            return jsonify({
                'error': {'code': 'GUILD_ID_REQUIRED', 'message': 'Discord guild ID is required when bot features or membership requirement are enabled.'},
                'meta': {'request_id': request_id}
            }), 400
        guild_id = final_guild_id
        if require_membership:
            final_invite = server_invite_url or Setting.get('DISCORD_SERVER_INVITE_URL')
            if not final_invite:
                return jsonify({
                    'error': {'code': 'INVITE_URL_REQUIRED', 'message': 'Server invite URL is required when membership requirement is enabled.'},
                    'meta': {'request_id': request_id}
                }), 400
            server_invite_url = final_invite

    if enable_bot:
        final_token = bot_token or Setting.get('DISCORD_BOT_TOKEN')
        if not final_token:
            return jsonify({
                'error': {'code': 'BOT_TOKEN_REQUIRED', 'message': 'Bot token is required when bot features are enabled.'},
                'meta': {'request_id': request_id}
            }), 400
        bot_token = final_token

    Setting.set('DISCORD_OAUTH_ENABLED', enable_oauth, SettingValueType.BOOLEAN)
    current_app.config['DISCORD_OAUTH_ENABLED'] = enable_oauth
    if hasattr(g, 'discord_oauth_enabled_for_invite'):
        g.discord_oauth_enabled_for_invite = enable_oauth

    if enable_oauth:
        if client_id:
            Setting.set('DISCORD_CLIENT_ID', client_id, SettingValueType.STRING)
        if client_secret:
            Setting.set('DISCORD_CLIENT_SECRET', client_secret, SettingValueType.SECRET)
        if oauth_auth_url:
            Setting.set('DISCORD_OAUTH_AUTH_URL', oauth_auth_url, SettingValueType.STRING)
        invite_redirect, admin_redirect = _compute_redirects()
        if invite_redirect:
            Setting.set('DISCORD_REDIRECT_URI_INVITE', invite_redirect, SettingValueType.STRING)
            Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', admin_redirect, SettingValueType.STRING)
        Setting.set('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', require_membership, SettingValueType.BOOLEAN)
        Setting.set('DISCORD_REQUIRE_GUILD_MEMBERSHIP', require_membership, SettingValueType.BOOLEAN)
        if enable_bot or require_membership:
            Setting.set('DISCORD_GUILD_ID', guild_id or '', SettingValueType.STRING)
            if require_membership:
                Setting.set('DISCORD_SERVER_INVITE_URL', server_invite_url or '', SettingValueType.STRING)
            elif not enable_bot:
                Setting.set('DISCORD_SERVER_INVITE_URL', '', SettingValueType.STRING)
        else:
            Setting.set('DISCORD_GUILD_ID', '', SettingValueType.STRING)
            Setting.set('DISCORD_SERVER_INVITE_URL', '', SettingValueType.STRING)
    else:
        for key, value_type in [
            ('DISCORD_CLIENT_ID', SettingValueType.STRING),
            ('DISCORD_CLIENT_SECRET', SettingValueType.SECRET),
            ('DISCORD_OAUTH_AUTH_URL', SettingValueType.STRING),
            ('DISCORD_REDIRECT_URI_INVITE', SettingValueType.STRING),
            ('DISCORD_REDIRECT_URI_ADMIN_LINK', SettingValueType.STRING),
            ('DISCORD_GUILD_ID', SettingValueType.STRING),
            ('DISCORD_SERVER_INVITE_URL', SettingValueType.STRING)
        ]:
            Setting.set(key, '', value_type)
        Setting.set('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', False, SettingValueType.BOOLEAN)
        Setting.set('DISCORD_REQUIRE_GUILD_MEMBERSHIP', False, SettingValueType.BOOLEAN)

    Setting.set('DISCORD_BOT_ENABLED', enable_bot, SettingValueType.BOOLEAN)
    if enable_bot:
        if bot_token:
            Setting.set('DISCORD_BOT_TOKEN', bot_token, SettingValueType.SECRET)
        Setting.set('DISCORD_MONITORED_ROLE_ID', monitored_role_id or '', SettingValueType.STRING)
        Setting.set('DISCORD_THREAD_CHANNEL_ID', thread_channel_id or '', SettingValueType.STRING)
        Setting.set('DISCORD_BOT_LOG_CHANNEL_ID', bot_log_channel_id or '', SettingValueType.STRING)
        if not require_membership and server_invite_url:
            Setting.set('DISCORD_SERVER_INVITE_URL', server_invite_url, SettingValueType.STRING)
        Setting.set('DISCORD_BOT_WHITELIST_SHARERS', whitelist_sharers, SettingValueType.BOOLEAN)
    else:
        Setting.set('DISCORD_BOT_TOKEN', '', SettingValueType.SECRET)
        Setting.set('DISCORD_MONITORED_ROLE_ID', '', SettingValueType.STRING)
        Setting.set('DISCORD_THREAD_CHANNEL_ID', '', SettingValueType.STRING)
        Setting.set('DISCORD_BOT_LOG_CHANNEL_ID', '', SettingValueType.STRING)
        Setting.set('DISCORD_BOT_WHITELIST_SHARERS', whitelist_sharers, SettingValueType.BOOLEAN)

    log_event(EventType.DISCORD_CONFIG_SAVE, "Discord settings updated via API.", admin_id=current_user.id)

    return jsonify({'data': _serialize_discord_settings(), 'meta': {'request_id': request_id}}), 200


@bp.route('/settings/discord/test', methods=['POST'])
@login_required
@permission_required('manage_discord_settings')
def test_discord_settings():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    test_type = (payload.get('type') or 'oauth').lower()

    if test_type == 'bot':
        if Setting.get('DISCORD_BOT_TOKEN'):
            return jsonify({'data': {'success': True, 'message': 'Bot token is configured.'}, 'meta': {'request_id': request_id}})
        return jsonify({'error': {'code': 'BOT_TOKEN_MISSING', 'message': 'Discord bot token has not been configured.'}, 'meta': {'request_id': request_id}}), 400

    if Setting.get('DISCORD_CLIENT_ID') and Setting.get('DISCORD_CLIENT_SECRET'):
        return jsonify({'data': {'success': True, 'message': 'Discord OAuth credentials are configured.'}, 'meta': {'request_id': request_id}})

    return jsonify({'error': {'code': 'OAUTH_NOT_CONFIGURED', 'message': 'Discord OAuth credentials are not fully configured.'}, 'meta': {'request_id': request_id}}), 400
