from __future__ import annotations

from uuid import uuid4
from datetime import datetime
from flask import jsonify, request, current_app, g
from flask_jwt_extended import set_access_cookies
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field, ConfigDict
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.utils.setup_helpers import get_completed_steps, is_setup_finished, mark_setup_complete
from app.models_media_services import ServiceType, MediaServer
from app.models import User, EventType, Setting, SettingValueType, Notification, NotificationType
from app.models_plugins import Plugin, PluginStatus
from app.extensions import db
from app.utils.helpers import log_event
from app.utils.timezone_utils import utcnow
from app.utils.jwt_helpers import make_access_token, make_refresh_token, set_refresh_cookie


setup_tag = Tag(name="Setup", description="Application setup helpers")


class SetupStatusData(BaseModel):
    account_complete: bool
    app_complete: bool
    plugins_complete: bool
    discord_complete: bool
    setup_complete: bool
    completed_steps: list[str]


class SetupStatusResponse(BaseModel):
    data: SetupStatusData
    meta: dict


class SetupAccountRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=120)
    password: str = Field(..., min_length=8)
    confirm_password: str = Field(..., min_length=8)


class SetupAccountResponse(BaseModel):
    data: dict | None = None
    meta: dict


class SetupAppResponse(BaseModel):
    data: dict
    meta: dict


class SetupAppErrorResponse(BaseModel):
    error: dict
    meta: dict


def _serialize_setup_status() -> dict:
    steps = get_completed_steps()
    return {
        'account_complete': 'account' in steps,
        'app_complete': 'app' in steps,
        'plugins_complete': 'plugins' in steps,
        'discord_complete': 'discord' in steps,
        'setup_complete': is_setup_finished(),
        'completed_steps': sorted(list(steps))
    }


@api_v2.get(
    "/setup/status",
    tags=[setup_tag],
    summary="Get setup status",
    responses={200: SetupStatusResponse},
)
@jwt_required_with_user(optional=True)
def setup_status(current_user=None):
    request_id = str(uuid4())
    return jsonify({'data': _serialize_setup_status(), 'meta': {'request_id': request_id}})


@api_v2.post(
    "/setup/account",
    tags=[setup_tag],
    summary="Create the owner account",
    responses={200: SetupAccountResponse, 400: SetupAccountResponse, 409: SetupAccountResponse, 422: SetupAccountResponse},
)
@jwt_required_with_user(optional=True)
def setup_create_owner(body: SetupAccountRequest, current_user=None):
    request_id = str(uuid4())

    if User.get_owner():
        return jsonify({'error': {'code': 'SETUP_ALREADY_COMPLETED', 'message': 'Owner account already exists.'}, 'meta': {'request_id': request_id}}), 409

    username = (body.username or '').strip()
    password = body.password or ''
    confirm_password = body.confirm_password or ''

    if not username:
        return jsonify({'error': {'code': 'INVALID_USERNAME', 'message': 'Username is required.'}, 'meta': {'request_id': request_id}}), 400
    if password != confirm_password:
        return jsonify({'error': {'code': 'PASSWORD_MISMATCH', 'message': 'Passwords do not match.'}, 'meta': {'request_id': request_id}}), 422
    if len(password) < 8:
        return jsonify({'error': {'code': 'WEAK_PASSWORD', 'message': 'Password must be at least 8 characters long.'}, 'meta': {'request_id': request_id}}), 422

    try:
        owner = User.create_owner(username=username, password=password)
        db.session.add(owner)
        db.session.commit()
    except ValueError as exc:
        db.session.rollback()
        return jsonify({'error': {'code': 'SETUP_ALREADY_COMPLETED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 409
    except Exception as exc:
        current_app.logger.error(f"Failed to create owner: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({'error': {'code': 'SETUP_ACCOUNT_FAILED', 'message': 'Failed to create owner account.'}, 'meta': {'request_id': request_id}}), 500

    access_token = make_access_token(owner)
    refresh_token = make_refresh_token(owner)

    owner.last_login_at = datetime.utcnow()
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.warning(f"Failed to update last_login for owner: {exc}")
        db.session.rollback()

    log_event(EventType.ADMIN_LOGIN_SUCCESS, f"Owner '{owner.localUsername}' created via setup and logged in.", admin_id=owner.id)

    response_payload = {
        'data': {
            'access_token': access_token,
            'user': {
                'uuid': owner.uuid,
                'username': owner.localUsername,
                'user_type': owner.userType.value if hasattr(owner.userType, 'value') else str(owner.userType),
            },
        },
        'meta': {'request_id': request_id},
    }
    resp = jsonify(response_payload)
    try:
        set_access_cookies(resp, access_token)
    except Exception:
        pass
    set_refresh_cookie(resp, refresh_token)
    return resp, 200


@api_v2.post(
    "/setup/app",
    tags=[setup_tag],
    summary="Save initial application configuration",
    responses={200: SetupAppResponse, 400: SetupAppErrorResponse, 422: SetupAppErrorResponse},
)
@jwt_required_with_user(optional=True)
def setup_app_config(current_user=None):
    request_id = uuid4().hex

    payload = {}
    if request.form:
        payload = request.form
    else:
        payload = request.get_json(silent=True) or {}

    app_name = (payload.get('app_name') or current_app.config.get("APP_NAME") or "Multimedia User Manager").strip()
    app_base_url = (payload.get('app_base_url') or "").strip()
    app_local_url = (payload.get('app_local_url') or "").strip()

    if not app_base_url:
        return jsonify({'error': {'code': 'BASE_URL_REQUIRED', 'message': 'Application public URL is required.'}, 'meta': {'request_id': request_id}}), 400

    if not (app_base_url.lower().startswith("http://") or app_base_url.lower().startswith("https://")):
        return jsonify({'error': {'code': 'INVALID_BASE_URL', 'message': 'Public URL must start with http:// or https://.'}, 'meta': {'request_id': request_id}}), 422

    if app_local_url and not (app_local_url.lower().startswith("http://") or app_local_url.lower().startswith("https://")):
        return jsonify({'error': {'code': 'INVALID_LOCAL_URL', 'message': 'Local URL must start with http:// or https://.'}, 'meta': {'request_id': request_id}}), 422

    app_base_url = app_base_url.rstrip("/")
    app_local_url = app_local_url.rstrip("/") if app_local_url else ""

    Setting.set('APP_NAME', app_name, SettingValueType.STRING, "Application Name")
    Setting.set('APP_BASE_URL', app_base_url, SettingValueType.STRING, "Application Public URL")
    Setting.set('APP_LOCAL_URL', app_local_url, SettingValueType.STRING, "Application Local URL")

    current_app.config['APP_NAME'] = app_name
    current_app.config['APP_BASE_URL'] = app_base_url
    current_app.config['APP_LOCAL_URL'] = app_local_url or None

    if hasattr(g, 'app_name'):
        g.app_name = app_name
    if hasattr(g, 'app_base_url'):
        g.app_base_url = app_base_url
    if hasattr(g, 'app_local_url'):
        g.app_local_url = app_local_url or None

    if current_user is not None and hasattr(current_user, "id"):
        try:
            log_event(EventType.SETTING_CHANGE, f"Setup updated application settings (Public URL: {app_base_url}).", admin_id=current_user.id)
        except Exception:
            current_app.logger.warning("Failed to log setup app config event", exc_info=True)

    response_data = {
        'app_name': app_name,
        'app_base_url': app_base_url,
        'app_local_url': app_local_url or None,
        'completed_steps': sorted(list(get_completed_steps()))
    }
    return jsonify({'data': response_data, 'meta': {'request_id': request_id}}), 200


class PluginServersResponse(BaseModel):
    data: list[dict]
    meta: dict


class SetupCreateServerBody(BaseModel):
    model_config = ConfigDict(extra='ignore')
    server_nickname: str = Field(..., description="Unique nickname")
    url: str = Field(..., description="Base URL")
    server_name: str | None = None
    api_key: str | None = None
    username: str | None = None
    password: str | None = None
    public_url: str | None = None
    jellyfin_owner_user_id: str | None = None
    is_active: bool | None = True
    overseerr_enabled: bool | None = False
    overseerr_url: str | None = None
    overseerr_api_key: str | None = None
    websocket_refresh_interval: int | None = None


class SetupPluginPath(BaseModel):
    plugin_id: str


@api_v2.get(
    "/setup/plugins/<plugin_id>/servers",
    tags=[setup_tag],
    summary="List servers for a plugin (by service type)",
    responses={200: PluginServersResponse, 404: PluginServersResponse},
)
@jwt_required_with_user()
def setup_plugin_servers(plugin_id: str, current_user):
    request_id = str(uuid4())
    service_type = None
    if plugin_id.isdigit():
        server = MediaServer.query.get(int(plugin_id))
        if not server:
            return jsonify({'error': {'code': 'UNKNOWN_PLUGIN', 'message': 'Plugin not recognized.'}, 'meta': {'request_id': request_id}}), 404
        service_type = server.service_type
    else:
        try:
            service_type = ServiceType[plugin_id.upper()]
        except KeyError:
            try:
                service_type = ServiceType(plugin_id.lower())
            except Exception:
                return jsonify({'error': {'code': 'UNKNOWN_PLUGIN', 'message': 'Plugin not recognized.'}, 'meta': {'request_id': request_id}}), 404

    servers = MediaServer.query.filter_by(service_type=service_type).all()
    data = [
        {
            'id': server.id,
            'name': server.server_nickname,
            'url': server.url,
            'is_active': server.is_active
        }
        for server in servers
    ]
    return jsonify({'data': data, 'meta': {'request_id': request_id}})


@api_v2.post(
    "/setup/plugins/<plugin_id>/servers",
    tags=[setup_tag],
    summary="Create server during setup",
    responses={201: PluginServersResponse, 403: PluginServersResponse, 404: PluginServersResponse, 409: PluginServersResponse},
)
@jwt_required_with_user(optional=True)
def setup_create_plugin_server(path: SetupPluginPath, body: SetupCreateServerBody, current_user=None):
    request_id = str(uuid4())

    if is_setup_finished():
        return jsonify({'error': {'code': 'SETUP_COMPLETE', 'message': 'Setup already completed.'}, 'meta': {'request_id': request_id}}), 403

    try:
        service_type = ServiceType(path.plugin_id)
    except Exception:
        try:
            service_type = ServiceType(path.plugin_id.lower())
        except Exception:
            return jsonify({'error': {'code': 'UNKNOWN_PLUGIN', 'message': 'Plugin not recognized.'}, 'meta': {'request_id': request_id}}), 404

    existing = MediaServer.query.filter_by(server_nickname=body.server_nickname).first()
    if existing:
        return jsonify({'error': {'code': 'NICKNAME_EXISTS', 'message': 'Server nickname already exists'}, 'meta': {'request_id': request_id}}), 409

    config: dict = {}
    if service_type == ServiceType.JELLYFIN and body.jellyfin_owner_user_id:
        owner_id = body.jellyfin_owner_user_id.strip()
        if owner_id:
            config["jellyfin_owner_user_id"] = owner_id

    if service_type == ServiceType.PLEX and body.websocket_refresh_interval is not None:
        try:
            interval_value = int(body.websocket_refresh_interval)
            config["websocket_refresh_interval"] = interval_value
        except (TypeError, ValueError):
            pass

    server = MediaServer(
        server_nickname=body.server_nickname,
        server_name=body.server_name or body.server_nickname,
        service_type=service_type,
        url=body.url,
        api_key=body.api_key,
        username=body.username,
        password=body.password,
        public_url=body.public_url,
        overseerr_enabled=bool(body.overseerr_enabled),
        overseerr_url=body.overseerr_url,
        overseerr_api_key=body.overseerr_api_key,
        config=config,
        is_active=True if body.is_active is None else body.is_active,
    )

    db.session.add(server)
    db.session.commit()

    # Auto-enable the plugin when a server is added
    try:
        plugin = Plugin.query.filter_by(plugin_id=service_type.value).first()
        if plugin:
            plugin.enabled_by_user = True
            if plugin.status != PluginStatus.ENABLED:
                plugin.status = PluginStatus.ENABLED
            db.session.add(plugin)
            db.session.commit()
            current_app.logger.info(
                f"Auto-enabled plugin '{service_type.value}' after adding server '{server.server_nickname}'"
            )
    except Exception as exc:
        current_app.logger.warning(f"Failed to auto-enable plugin during setup: {exc}")

    # Create notification for new unsynced server
    try:
        notification = Notification(
            timestamp=utcnow(),
            notification_type=NotificationType.SERVER_NOT_SYNCED,
            title="New Server Not Synced",
            message=f"Server '{server.server_nickname}' has been added but has not been synced yet. Sync users and libraries to get started.",
            read=False,
            server_id=server.id,
            details={
                "server_nickname": server.server_nickname,
                "service_type": service_type.value,
            },
        )
        db.session.add(notification)
        db.session.commit()
        current_app.logger.info(f"Created SERVER_NOT_SYNCED notification for server '{server.server_nickname}'")
    except Exception as exc:
        current_app.logger.warning(f"Failed to create notification for new server during setup: {exc}")

    from app.routes.api.v2.servers import _to_item
    return jsonify(_to_item(server)), 201


class TestConnectionResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


@api_v2.post(
    "/setup/plugins/<plugin_id>/test-connection",
    tags=[setup_tag],
    summary="Test plugin connection",
    responses={200: TestConnectionResponse, 400: TestConnectionResponse, 500: TestConnectionResponse},
)
def setup_test_connection(path: SetupPluginPath):
    plugin_id = path.plugin_id
    request_id = str(uuid4())
    try:
        try:
            service_type = ServiceType(plugin_id)
        except Exception:
            return jsonify({'error': {'code': 'UNKNOWN_PLUGIN', 'message': f'Unknown plugin: {plugin_id}'} , 'meta': {'request_id': request_id}}), 400

        data = request.get_json(silent=True) or {}
        server_name = (data.get('name') or '').strip()
        server_url = (data.get('url') or '').strip()
        api_key = (data.get('api_key') or '').strip()
        username = (data.get('username') or '').strip()
        password = (data.get('password') or '').strip()
        public_url = (data.get('public_url') or '').strip()

        if not server_url:
            return jsonify({'error': {'code': 'VALIDATION_ERROR', 'message': 'Server URL is required.'}, 'meta': {'request_id': request_id}}), 400

        temp_server = MediaServer(
            server_nickname=server_name or 'Test Server',
            url=server_url,
            api_key=api_key,
            username=username,
            password=password,
            public_url=public_url,
            service_type=service_type,
        )

        from app.services.media_service_factory import MediaServiceFactory
        service = MediaServiceFactory.create_service_from_db(temp_server)
        if not service:
            return jsonify({'error': {'code': 'SERVICE_CREATION_FAILED', 'message': f'Could not create service for {plugin_id}'}, 'meta': {'request_id': request_id}}), 500

        success, message = service.test_connection()
        return jsonify({'data': {'success': bool(success), 'message': message}, 'meta': {'request_id': request_id}}), 200
    except Exception as exc:
        current_app.logger.exception("Setup test connection failed: %s", exc)
        return jsonify({'error': {'code': 'SETUP_TEST_FAILED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500


class SetupCompleteRequest(BaseModel):
    disable_discord: bool = Field(default=False, description="Whether to explicitly disable Discord OAuth")


class SetupCompleteResponse(BaseModel):
    data: dict | None = None
    meta: dict


@api_v2.post(
    "/setup/complete",
    tags=[setup_tag],
    summary="Mark setup as complete",
    responses={200: SetupCompleteResponse, 500: SetupCompleteResponse},
)
@jwt_required_with_user()
def setup_complete(body: SetupCompleteRequest, current_user):
    """Mark the initial setup as complete and optionally disable Discord."""
    request_id = str(uuid4())

    try:
        # If requested, explicitly disable Discord
        if body.disable_discord:
            Setting.set('DISCORD_OAUTH_ENABLED', 'false')
            current_app.logger.info(f"Discord OAuth disabled during setup completion by user {current_user.id}")

        # Mark setup as complete
        mark_setup_complete()

        log_event(
            EventType.ADMIN_LOGIN_SUCCESS,
            f"Initial setup completed by admin '{current_user.localUsername}'",
            admin_id=current_user.id
        )

        return jsonify({
            'data': {
                'setup_complete': True,
                'message': 'Setup completed successfully'
            },
            'meta': {'request_id': request_id}
        }), 200
    except Exception as exc:
        current_app.logger.exception("Failed to mark setup complete: %s", exc)
        db.session.rollback()
        return jsonify({
            'error': {
                'code': 'SETUP_COMPLETE_FAILED',
                'message': f'Failed to complete setup: {str(exc)}'
            },
            'meta': {'request_id': request_id}
        }), 500
