from __future__ import annotations

from uuid import uuid4
from datetime import datetime
from flask import jsonify, request, current_app
from flask_jwt_extended import set_access_cookies
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.utils.setup_helpers import get_completed_steps
from app.models_media_services import ServiceType, MediaServer
from app.models import User, EventType
from app.extensions import db
from app.utils.helpers import log_event
from app.utils.jwt_helpers import make_access_token, make_refresh_token, set_refresh_cookie


setup_tag = Tag(name="Setup", description="Application setup helpers")


class SetupStatusData(BaseModel):
    account_complete: bool
    app_complete: bool
    plugins_complete: bool
    discord_complete: bool
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


def _serialize_setup_status() -> dict:
    steps = get_completed_steps()
    return {
        'account_complete': 'account' in steps,
        'app_complete': 'app' in steps,
        'plugins_complete': 'plugins' in steps,
        'discord_complete': 'discord' in steps,
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


class PluginServersResponse(BaseModel):
    data: list[dict]
    meta: dict


@api_v2.get(
    "/setup/plugins/<plugin_id>/servers",
    tags=[setup_tag],
    summary="List servers for a plugin (by service type)",
    responses={200: PluginServersResponse, 404: PluginServersResponse},
)
@jwt_required_with_user()
def setup_plugin_servers(plugin_id: str, current_user):
    request_id = str(uuid4())
    try:
        service_type = ServiceType[plugin_id.upper()]
    except KeyError:
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


class TestConnectionResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


class SetupPluginPath(BaseModel):
    plugin_id: str


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
