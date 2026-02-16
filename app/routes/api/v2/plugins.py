from __future__ import annotations

from uuid import uuid4
from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models_plugins import Plugin, PluginRepository
from app.services.plugin_manager import plugin_manager
from app.extensions import db
from app.utils.helpers import log_event
# JWT permission checking handled by jwt_permission_required, log_event
from app.models import EventType
from app.configuration.plugin_metadata import get_all_plugin_metadata


plugins_tag = Tag(name="Plugins", description="Plugin management")


class PluginItem(BaseModel):
    plugin_id: str
    name: str | None = None
    description: str | None = None
    type: str | None = None
    status: str | None = None
    enabled_by_user: bool | None = None
    author: str | None = None
    homepage: str | None = None
    repository: str | None = None
    license: str | None = None
    installed_at: str | None = None
    last_updated: str | None = None
    last_error: str | None = None
    servers_count: int | None = None
    supported_features: dict | list | None = None
    config_schema: dict | list | None = None
    default_config: dict | list | None = None
    available: dict | None = None


class PluginsListResponse(BaseModel):
    data: list[PluginItem]
    meta: dict


class PluginMetadataResponse(BaseModel):
    data: dict
    meta: dict


class PluginPath(BaseModel):
    plugin_id: str


def _serialize_plugin(plugin: Plugin):
    return {
        'plugin_id': plugin.plugin_id,
        'name': plugin.name,
        'description': plugin.description,
        'type': plugin.plugin_type.value if plugin.plugin_type else None,
        'status': plugin.status.value if plugin.status else None,
        'enabled_by_user': bool(getattr(plugin, "enabled_by_user", False)),
        'author': plugin.author,
        'homepage': plugin.homepage,
        'repository': plugin.repository,
        'license': plugin.license,
        'installed_at': plugin.installed_at.isoformat() if plugin.installed_at else None,
        'last_updated': plugin.last_updated.isoformat() if plugin.last_updated else None,
        'last_error': plugin.last_error,
        'servers_count': plugin.servers_count,
        'supported_features': plugin.supported_features,
        'config_schema': plugin.config_schema,
        'default_config': plugin.default_config
    }


def _plugin_action(plugin_id: str, action: str, current_user):
    request_id = str(uuid4())
    plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
    if not plugin:
        return jsonify({'error': {'code': 'NOT_FOUND', 'message': 'Plugin not found.'}, 'meta': {'request_id': request_id}}), 404

    if action == 'enable':
        success = plugin_manager.enable_plugin(plugin_id)
    elif action == 'disable':
        success = plugin_manager.disable_plugin(plugin_id)
    else:
        return jsonify({'error': {'code': 'INVALID_ACTION', 'message': 'Unsupported plugin action.'}, 'meta': {'request_id': request_id}}), 400

    if not success:
        return jsonify({'error': {'code': 'PLUGIN_ACTION_FAILED', 'message': plugin.last_error or 'Plugin action failed.'}, 'meta': {'request_id': request_id}}), 500

    db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Plugin '{plugin_id}' {action}d.", admin_id=current_user.id)
    return jsonify({'data': _serialize_plugin(plugin), 'meta': {'request_id': request_id}})


@api_v2.get(
    "/plugins",
    tags=[plugins_tag],
    summary="List installed plugins",
    responses={200: PluginsListResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def list_plugins(current_user):
    request_id = str(uuid4())
    plugins = Plugin.query.order_by(Plugin.name.asc()).all()
    available_plugins = plugin_manager.get_available_plugins()
    available_lookup = {}
    for available in available_plugins:
        plugin_id_value = None
        if isinstance(available, Plugin):
            plugin_id_value = available.plugin_id
            available_lookup[plugin_id_value] = _serialize_plugin(available)
        elif isinstance(available, dict):
            plugin_id_value = available.get('plugin_id')
            if plugin_id_value:
                available_lookup[plugin_id_value] = available

    data = []
    for plugin in plugins:
        entry = _serialize_plugin(plugin)
        entry['available'] = available_lookup.get(plugin.plugin_id)
        data.append(entry)

    return jsonify({'data': data, 'meta': {'request_id': request_id}})


@api_v2.get(
    "/plugins/metadata",
    tags=[plugins_tag],
    summary="Get plugin metadata",
    responses={200: PluginMetadataResponse},
)
@jwt_required_with_user()
def get_plugin_metadata_endpoint(current_user):
    """Get metadata for all plugins including icons, features, and config schema."""
    request_id = str(uuid4())
    metadata = get_all_plugin_metadata()

    data = {}
    for plugin_id, meta in metadata.items():
        data[plugin_id] = {
            'plugin_id': meta.plugin_id,
            'name': meta.name,
            'description': meta.description,
            'author': meta.author,
            'icon_type': meta.icon_type,
            'icon_identifier': meta.icon_identifier,
            'color_theme': meta.color_theme,
            'features': meta.features,
            'requires_api_key': meta.requires_api_key,
            'supports_websocket': meta.supports_websocket,
            'config_schema': meta.config_schema,
            'invite_features': meta.invite_features,
            'supports_library_scoped_grants': meta.supports_library_scoped_grants,
        }

    return jsonify({'data': data, 'meta': {'request_id': request_id}})


@api_v2.post(
    "/plugins/<plugin_id>/enable",
    tags=[plugins_tag],
    summary="Enable a plugin",
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def enable_plugin(path: PluginPath, current_user):
    return _plugin_action(path.plugin_id, 'enable', current_user)


@api_v2.post(
    "/plugins/<plugin_id>/disable",
    tags=[plugins_tag],
    summary="Disable a plugin",
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def disable_plugin(path: PluginPath, current_user):
    return _plugin_action(path.plugin_id, 'disable', current_user)


class RepoItem(BaseModel):
    id: int
    name: str | None = None
    url: str | None = None
    description: str | None = None
    is_enabled: bool | None = None
    is_official: bool | None = None
    last_sync: str | None = None
    last_error: str | None = None


class ReposListResponse(BaseModel):
    data: list[RepoItem]
    meta: dict


@api_v2.get(
    "/plugin-repositories",
    tags=[plugins_tag],
    summary="List plugin repositories",
    responses={200: ReposListResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def list_plugin_repositories(current_user):
    request_id = str(uuid4())
    repos = PluginRepository.query.order_by(PluginRepository.name.asc()).all()
    data = [
        {
            'id': repo.id,
            'name': repo.name,
            'url': repo.url,
            'description': repo.description,
            'is_enabled': repo.is_enabled,
            'is_official': repo.is_official,
            'last_sync': repo.last_sync.isoformat() if repo.last_sync else None,
            'last_error': repo.last_error
        }
        for repo in repos
    ]
    return jsonify({'data': data, 'meta': {'request_id': request_id}})


class CreateRepoBody(BaseModel):
    name: str
    url: str
    description: str | None = None


class CreateRepoResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/plugin-repositories",
    tags=[plugins_tag],
    summary="Create a plugin repository",
    responses={201: CreateRepoResponse, 400: CreateRepoResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def create_plugin_repository(current_user):
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    name = (payload.get('name') or '').strip()
    url_value = (payload.get('url') or '').strip()
    description = payload.get('description')

    if not name or not url_value:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'Name and URL are required.'}, 'meta': {'request_id': request_id}}), 400

    repo = PluginRepository(name=name, url=url_value, description=description)
    db.session.add(repo)
    db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Plugin repository '{name}' added.", admin_id=current_user.id)
    return jsonify({'data': {'id': repo.id}, 'meta': {'request_id': request_id}}), 201


class DeleteRepoResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.delete(
    "/plugin-repositories/<int:repo_id>",
    tags=[plugins_tag],
    summary="Delete a plugin repository",
    responses={200: DeleteRepoResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def delete_plugin_repository(repo_id, current_user):
    request_id = str(uuid4())
    repo = PluginRepository.query.get_or_404(repo_id)
    db.session.delete(repo)
    db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Plugin repository '{repo.name}' removed.", admin_id=current_user.id)
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}})
