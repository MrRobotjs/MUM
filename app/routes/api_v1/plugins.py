from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required, current_user

from app.routes.api_v1 import bp
from app.models_plugins import Plugin, PluginRepository
from app.services.plugin_manager import plugin_manager
from app.extensions import db
from app.utils.helpers import permission_required, log_event
from app.models import EventType


def _serialize_plugin(plugin: Plugin):
    return {
        'plugin_id': plugin.plugin_id,
        'name': plugin.name,
        'description': plugin.description,
        'version': plugin.version,
        'type': plugin.plugin_type.value if plugin.plugin_type else None,
        'status': plugin.status.value if plugin.status else None,
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


def _plugin_action(plugin_id: str, action: str):
    request_id = str(uuid4())
    plugin = Plugin.query.filter_by(plugin_id=plugin_id).first_or_404()

    if action == 'enable':
        success = plugin_manager.enable_plugin(plugin_id)
    elif action == 'disable':
        success = plugin_manager.disable_plugin(plugin_id)
    elif action == 'install':
        success = plugin_manager.install_plugin(plugin_id)
    elif action == 'uninstall':
        success = plugin_manager.uninstall_plugin(plugin_id)
    else:
        return jsonify({'error': {'code': 'INVALID_ACTION', 'message': 'Unsupported plugin action.'}, 'meta': {'request_id': request_id}}), 400

    if not success:
        return jsonify({'error': {'code': 'PLUGIN_ACTION_FAILED', 'message': plugin.last_error or 'Plugin action failed.'}, 'meta': {'request_id': request_id}}), 500

    db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Plugin '{plugin_id}' {action}d.", admin_id=current_user.id)
    return jsonify({'data': _serialize_plugin(plugin), 'meta': {'request_id': request_id}})


@bp.route('/plugins', methods=['GET'])
@login_required
@permission_required('manage_plugins')
def list_plugins():
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


@bp.route('/plugins/<plugin_id>/enable', methods=['POST'])
@login_required
@permission_required('manage_plugins')
def enable_plugin(plugin_id):
    return _plugin_action(plugin_id, 'enable')


@bp.route('/plugins/<plugin_id>/disable', methods=['POST'])
@login_required
@permission_required('manage_plugins')
def disable_plugin(plugin_id):
    return _plugin_action(plugin_id, 'disable')


@bp.route('/plugins/<plugin_id>/install', methods=['POST'])
@login_required
@permission_required('manage_plugins')
def install_plugin(plugin_id):
    return _plugin_action(plugin_id, 'install')


@bp.route('/plugins/<plugin_id>/uninstall', methods=['POST'])
@login_required
@permission_required('manage_plugins')
def uninstall_plugin(plugin_id):
    return _plugin_action(plugin_id, 'uninstall')


@bp.route('/plugin-repositories', methods=['GET'])
@login_required
@permission_required('manage_plugins')
def list_plugin_repositories():
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


@bp.route('/plugin-repositories', methods=['POST'])
@login_required
@permission_required('manage_plugins')
def create_plugin_repository():
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


@bp.route('/plugin-repositories/<int:repo_id>', methods=['DELETE'])
@login_required
@permission_required('manage_plugins')
def delete_plugin_repository(repo_id):
    request_id = str(uuid4())
    repo = PluginRepository.query.get_or_404(repo_id)
    db.session.delete(repo)
    db.session.commit()
    log_event(EventType.SETTING_CHANGE, f"Plugin repository '{repo.name}' removed.", admin_id=current_user.id)
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}})
