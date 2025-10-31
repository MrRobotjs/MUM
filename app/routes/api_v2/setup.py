from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.utils.setup_helpers import get_completed_steps
from app.models_media_services import ServiceType, MediaServer
from flask import request, current_app


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
@login_required
def setup_status():
    request_id = str(uuid4())
    return jsonify({'data': _serialize_setup_status(), 'meta': {'request_id': request_id}})


class PluginServersResponse(BaseModel):
    data: list[dict]
    meta: dict


@api_v2.get(
    "/setup/plugins/<plugin_id>/servers",
    tags=[setup_tag],
    summary="List servers for a plugin (by service type)",
    responses={200: PluginServersResponse, 404: PluginServersResponse},
)
@login_required
def setup_plugin_servers(plugin_id: str):
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


@api_v2.post(
    "/setup/plugins/<plugin_id>/test-connection",
    tags=[setup_tag],
    summary="Test plugin connection",
    responses={200: TestConnectionResponse, 400: TestConnectionResponse, 500: TestConnectionResponse},
)
def setup_test_connection(plugin_id: str):
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
            localUsername=username,
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
