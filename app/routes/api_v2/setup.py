from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.routes.setup import get_completed_steps
from app.models_media_services import ServiceType, MediaServer
from app.routes.media_servers_modules.setup import test_connection_setup


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
        response = test_connection_setup(plugin_id)
        if isinstance(response, tuple):
            return response
        return response
    except Exception as exc:
        return jsonify({'error': {'code': 'SETUP_TEST_FAILED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500

