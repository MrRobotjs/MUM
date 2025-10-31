from uuid import uuid4

from flask import jsonify
from flask_login import login_required

from app.routes.api_v1 import bp
from app.utils.setup_helpers import get_completed_steps
from app.models_plugins import Plugin
from app.models_media_services import ServiceType, MediaServer
from app.routes.media_servers_modules_deprecated.setup_deprecated import test_connection_setup


def _serialize_setup_status():
    steps = get_completed_steps()
    return {
        'account_complete': 'account' in steps,
        'app_complete': 'app' in steps,
        'plugins_complete': 'plugins' in steps,
        'discord_complete': 'discord' in steps,
        'completed_steps': sorted(list(steps))
    }


@bp.route('/setup/status', methods=['GET'])
@login_required
def setup_status():
    request_id = str(uuid4())
    return jsonify({'data': _serialize_setup_status(), 'meta': {'request_id': request_id}})


@bp.route('/setup/plugins/<plugin_id>/servers', methods=['GET'])
@login_required
def setup_plugin_servers(plugin_id):
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


@bp.route('/setup/plugins/<plugin_id>/test-connection', methods=['POST'])
def setup_test_connection(plugin_id):
    request_id = str(uuid4())
    try:
        response = test_connection_setup(plugin_id)
        if isinstance(response, tuple):
            return response
        return response
    except Exception as exc:
        return jsonify({'error': {'code': 'SETUP_TEST_FAILED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500
