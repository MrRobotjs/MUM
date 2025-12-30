from __future__ import annotations

from uuid import uuid4
from flask import jsonify, request, current_app, g
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import log_event
# JWT permission checking handled by jwt_permission_required, log_event


settings_tag = Tag(name="Settings", description="Application settings")


def _compute_redirects():
    app_base = Setting.get('APP_BASE_URL') or current_app.config.get('APP_BASE_URL') or ''
    app_base = (app_base or '').rstrip('/')
    invite_path = '/api/v2/public/discord/callback'
    admin_path = '/api/v2/auth/discord/callback'
    if not app_base:
        return None, None
    return f"{app_base}{invite_path}", f"{app_base}{admin_path}"


class DiscordSettingsData(BaseModel):
    enable_oauth: bool
    client_id: str | None = None
    client_secret_set: bool
    oauth_auth_url: str | None = None
    redirect_uri_invite: str | None = None
    redirect_uri_admin: str | None = None
    default_require_discord_auth: bool
    default_require_discord_guild_membership: bool
    enable_membership_requirement: bool
    guild_id: str | None = None
    server_invite_url: str | None = None
    enable_bot: bool
    bot_token_set: bool
    monitored_role_id: str | None = None
    thread_channel_id: str | None = None
    bot_log_channel_id: str | None = None
    whitelist_sharers: bool
    admin_linked: bool
    admin_user: dict | None = None


class DiscordSettingsResponse(BaseModel):
    data: DiscordSettingsData
    meta: dict


def _serialize_discord_settings(current_user) -> dict:
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
        'default_require_discord_auth': Setting.get_bool('DISCORD_INVITE_REQUIRE_AUTH_DEFAULT', False),
        'default_require_discord_guild_membership': Setting.get_bool('DISCORD_INVITE_REQUIRE_GUILD_DEFAULT', False),
        'enable_membership_requirement': Setting.get_bool('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', False),
        'guild_id': Setting.get('DISCORD_GUILD_ID'),
        'server_invite_url': Setting.get('DISCORD_SERVER_INVITE_URL'),
        'enable_bot': Setting.get_bool('DISCORD_BOT_ENABLED', False),
        'bot_token_set': bool(stored_bot_token),
        'monitored_role_id': Setting.get('DISCORD_MONITORED_ROLE_ID'),
        'thread_channel_id': Setting.get('DISCORD_THREAD_CHANNEL_ID'),
        'bot_log_channel_id': Setting.get('DISCORD_BOT_LOG_CHANNEL_ID'),
        'whitelist_sharers': Setting.get_bool('DISCORD_BOT_WHITELIST_SHARERS', False),
        'admin_linked': bool(getattr(current_user, 'discord_user_id', None)),
        'admin_user': {
            'username': getattr(current_user, 'discord_username', None),
            'id': getattr(current_user, 'discord_user_id', None),
            'avatar': getattr(current_user, 'discord_avatar_hash', None)
        } if getattr(current_user, 'discord_user_id', None) else None
    }


@api_v2.get(
    "/settings/discord",
    tags=[settings_tag],
    summary="Get Discord settings",
    responses={200: DiscordSettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_discord_settings(current_user):
    request_id = uuid4().hex
    return jsonify({'data': _serialize_discord_settings(current_user), 'meta': {'request_id': request_id}})


class UpdateDiscordBody(BaseModel):
    enable_oauth: bool = False
    enable_bot: bool = False
    enable_membership_requirement: bool = False
    default_require_discord_auth: bool = False
    default_require_discord_guild_membership: bool = False
    client_id: str | None = None
    client_secret: str | None = None
    oauth_auth_url: str | None = None
    redirect_uri_invite: str | None = None
    redirect_uri_admin: str | None = None
    guild_id: str | None = None
    server_invite_url: str | None = None
    bot_token: str | None = None
    monitored_role_id: str | None = None
    thread_channel_id: str | None = None
    bot_log_channel_id: str | None = None
    whitelist_sharers: bool = False


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.patch(
    "/settings/discord",
    tags=[settings_tag],
    summary="Update Discord settings",
    responses={200: DiscordSettingsResponse, 400: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def update_discord_settings(body: UpdateDiscordBody, current_user):
    request_id = uuid4().hex

    enable_oauth = bool(body.enable_oauth)
    enable_bot = bool(body.enable_bot)
    require_membership = bool(body.enable_membership_requirement)
    default_require_auth = bool(body.default_require_discord_auth)
    default_require_guild = bool(body.default_require_discord_guild_membership)

    if default_require_guild and not default_require_auth:
        default_require_auth = True

    if (enable_bot or require_membership or default_require_auth or default_require_guild) and not enable_oauth:
        enable_oauth = True

    client_id = body.client_id
    client_secret = body.client_secret
    oauth_auth_url = body.oauth_auth_url
    redirect_uri_invite = body.redirect_uri_invite
    redirect_uri_admin = body.redirect_uri_admin
    fields_set = getattr(body, '__fields_set__', None) or getattr(body, 'model_fields_set', set())
    oauth_auth_url_provided = 'oauth_auth_url' in fields_set
    redirect_invite_provided = 'redirect_uri_invite' in fields_set
    redirect_admin_provided = 'redirect_uri_admin' in fields_set
    guild_id = body.guild_id
    server_invite_url = body.server_invite_url
    bot_token = body.bot_token
    monitored_role_id = body.monitored_role_id
    thread_channel_id = body.thread_channel_id
    bot_log_channel_id = body.bot_log_channel_id
    whitelist_sharers = bool(body.whitelist_sharers)

    if enable_oauth:
        existing_client_id = Setting.get('DISCORD_CLIENT_ID')
        if not (client_id or existing_client_id):
            return jsonify({'error': {'code': 'CLIENT_ID_REQUIRED', 'message': 'Discord client ID is required when OAuth is enabled.'}, 'meta': {'request_id': request_id}}), 400
        existing_secret = Setting.get('DISCORD_CLIENT_SECRET')
        if not (client_secret or existing_secret):
            return jsonify({'error': {'code': 'CLIENT_SECRET_REQUIRED', 'message': 'Discord client secret is required when OAuth is enabled.'}, 'meta': {'request_id': request_id}}), 400
    else:
        enable_bot = False
        require_membership = False
        default_require_auth = False
        default_require_guild = False

    require_guild_fields = enable_bot or require_membership or default_require_guild

    if require_guild_fields:
        final_guild_id = guild_id or Setting.get('DISCORD_GUILD_ID')
        if not final_guild_id:
            return jsonify({'error': {'code': 'GUILD_ID_REQUIRED', 'message': 'Discord guild ID is required when bot features or membership requirement are enabled.'}, 'meta': {'request_id': request_id}}), 400
        guild_id = final_guild_id
        if require_membership or default_require_guild:
            final_invite = server_invite_url or Setting.get('DISCORD_SERVER_INVITE_URL')
            if not final_invite:
                return jsonify({'error': {'code': 'SERVER_INVITE_REQUIRED', 'message': 'Discord server invite URL is required when membership requirement is enabled.'}, 'meta': {'request_id': request_id}}), 400
            server_invite_url = final_invite

    current_app.config['DISCORD_OAUTH_ENABLED'] = enable_oauth
    Setting.set('DISCORD_OAUTH_ENABLED', enable_oauth, SettingValueType.BOOLEAN)
    if hasattr(g, 'discord_oauth_enabled_for_invite'):
        g.discord_oauth_enabled_for_invite = enable_oauth

    if enable_oauth:
        if client_id:
            Setting.set('DISCORD_CLIENT_ID', client_id, SettingValueType.STRING)
        if client_secret:
            Setting.set('DISCORD_CLIENT_SECRET', client_secret, SettingValueType.SECRET)
        if oauth_auth_url_provided:
            Setting.set('DISCORD_OAUTH_AUTH_URL', oauth_auth_url or '', SettingValueType.STRING)
        invite_redirect, admin_redirect = _compute_redirects()
        if redirect_invite_provided:
            Setting.set('DISCORD_REDIRECT_URI_INVITE', redirect_uri_invite or '', SettingValueType.STRING)
        elif invite_redirect:
            Setting.set('DISCORD_REDIRECT_URI_INVITE', invite_redirect, SettingValueType.STRING)
        if redirect_admin_provided:
            Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', redirect_uri_admin or '', SettingValueType.STRING)
        elif admin_redirect:
            Setting.set('DISCORD_REDIRECT_URI_ADMIN_LINK', admin_redirect, SettingValueType.STRING)
        Setting.set('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', require_membership, SettingValueType.BOOLEAN)
        Setting.set('DISCORD_REQUIRE_GUILD_MEMBERSHIP', require_membership, SettingValueType.BOOLEAN)
    else:
        Setting.set('ENABLE_DISCORD_MEMBERSHIP_REQUIREMENT', False, SettingValueType.BOOLEAN)
        Setting.set('DISCORD_REQUIRE_GUILD_MEMBERSHIP', False, SettingValueType.BOOLEAN)

    if guild_id is not None:
        Setting.set('DISCORD_GUILD_ID', guild_id, SettingValueType.STRING)
    if server_invite_url is not None:
        Setting.set('DISCORD_SERVER_INVITE_URL', server_invite_url, SettingValueType.STRING)

    Setting.set('DISCORD_INVITE_REQUIRE_AUTH_DEFAULT', default_require_auth, SettingValueType.BOOLEAN)
    Setting.set('DISCORD_INVITE_REQUIRE_GUILD_DEFAULT', default_require_guild, SettingValueType.BOOLEAN)

    Setting.set('DISCORD_BOT_ENABLED', enable_bot, SettingValueType.BOOLEAN)
    if enable_bot:
        if bot_token:
            Setting.set('DISCORD_BOT_TOKEN', bot_token, SettingValueType.SECRET)
        Setting.set('DISCORD_MONITORED_ROLE_ID', monitored_role_id or '', SettingValueType.STRING)
        Setting.set('DISCORD_THREAD_CHANNEL_ID', thread_channel_id or '', SettingValueType.STRING)
        Setting.set('DISCORD_BOT_LOG_CHANNEL_ID', bot_log_channel_id or '', SettingValueType.STRING)
        if not require_membership and not default_require_guild and server_invite_url:
            Setting.set('DISCORD_SERVER_INVITE_URL', server_invite_url, SettingValueType.STRING)
        Setting.set('DISCORD_BOT_WHITELIST_SHARERS', whitelist_sharers, SettingValueType.BOOLEAN)
    else:
        Setting.set('DISCORD_BOT_TOKEN', '', SettingValueType.SECRET)
        Setting.set('DISCORD_MONITORED_ROLE_ID', '', SettingValueType.STRING)
        Setting.set('DISCORD_THREAD_CHANNEL_ID', '', SettingValueType.STRING)
        Setting.set('DISCORD_BOT_LOG_CHANNEL_ID', '', SettingValueType.STRING)
        Setting.set('DISCORD_BOT_WHITELIST_SHARERS', whitelist_sharers, SettingValueType.BOOLEAN)

    log_event(EventType.DISCORD_CONFIG_SAVE, "Discord settings updated via API.", admin_id=current_user.id)

    return jsonify({'data': _serialize_discord_settings(current_user), 'meta': {'request_id': request_id}}), 200


class TestDiscordBody(BaseModel):
    type: str = Field(default='oauth', description='oauth|bot')


class TestDiscordResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


@api_v2.post(
    "/settings/discord/test",
    tags=[settings_tag],
    summary="Test Discord settings",
    responses={200: TestDiscordResponse, 400: TestDiscordResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def test_discord_settings(current_user):
    request_id = uuid4().hex
    payload = request.get_json(silent=True) or {}
    test_type = (payload.get('type') or 'oauth').lower()

    if test_type == 'bot':
        if Setting.get('DISCORD_BOT_TOKEN'):
            return jsonify({'data': {'success': True, 'message': 'Bot token is configured.'}, 'meta': {'request_id': request_id}})
        return jsonify({'error': {'code': 'BOT_TOKEN_MISSING', 'message': 'Discord bot token has not been configured.'}, 'meta': {'request_id': request_id}}), 400

    if Setting.get('DISCORD_CLIENT_ID') and Setting.get('DISCORD_CLIENT_SECRET'):
        return jsonify({'data': {'success': True, 'message': 'Discord OAuth credentials are configured.'}, 'meta': {'request_id': request_id}})

    return jsonify({'error': {'code': 'OAUTH_NOT_CONFIGURED', 'message': 'Discord OAuth credentials are not fully configured.'}, 'meta': {'request_id': request_id}}), 400
