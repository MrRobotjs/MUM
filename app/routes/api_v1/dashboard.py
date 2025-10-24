from uuid import uuid4
from datetime import datetime

from flask import jsonify
from flask_login import login_required

from app.routes.api_v1 import bp
from app.routes.api import get_fresh_server_status


def _serialize_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        try:
            return value.isoformat()
        except Exception:
            return value.strftime('%Y-%m-%dT%H:%M:%S')
    return value


def _normalize_server_status(raw_status: dict) -> dict:
    if not raw_status:
        return {
            'summary': {
                'total_servers': 0,
                'online': 0,
                'offline': 0
            },
            'servers': [],
            'grouped_by_service': []
        }

    if raw_status.get('multi_server'):
        servers = [
            {
                'id': server.get('server_id'),
                'service_type': server.get('service_type'),
                'name': server.get('name') or server.get('custom_name'),
                'nickname': server.get('custom_name'),
                'actual_server_name': server.get('actual_server_name'),
                'online': server.get('online'),
                'version': server.get('version'),
                'last_check_time': _serialize_datetime(server.get('last_check_time')),
                'error_message': server.get('error_message'),
                'url': server.get('url')
            }
            for server in raw_status.get('all_statuses', [])
        ]

        groups = []
        for service_type, payload in (raw_status.get('servers_by_service') or {}).items():
            groups.append({
                'service_type': service_type,
                'service_name': payload.get('service_name'),
                'online_count': payload.get('online_count', 0),
                'offline_count': payload.get('offline_count', 0),
                'total_count': payload.get('total_count', 0),
                'servers': [
                    {
                        'id': server.get('server_id'),
                        'name': server.get('name') or server.get('custom_name'),
                        'online': server.get('online'),
                        'version': server.get('version')
                    }
                    for server in payload.get('servers', [])
                ]
            })

        summary = {
            'total_servers': len(servers),
            'online': raw_status.get('online_count', 0),
            'offline': raw_status.get('offline_count', 0),
        }
    else:
        servers = [{
            'id': raw_status.get('server_id'),
            'service_type': raw_status.get('service_type'),
            'name': raw_status.get('name'),
            'nickname': raw_status.get('friendly_name'),
            'actual_server_name': raw_status.get('friendly_name'),
            'online': raw_status.get('online'),
            'version': raw_status.get('version'),
            'last_check_time': _serialize_datetime(raw_status.get('last_check_time')),
            'error_message': raw_status.get('error_message'),
            'url': raw_status.get('url')
        }]
        summary = {
            'total_servers': 1,
            'online': 1 if raw_status.get('online') else 0,
            'offline': 0 if raw_status.get('online') else 1,
        }
        groups = []

    return {
        'summary': summary,
        'servers': servers,
        'grouped_by_service': groups
    }


@bp.route('/server-status', methods=['GET'])
@login_required
def get_server_status():
    """
    JSON variant of the dashboard server status widget.
    Provides counts and per-server details for the React frontend.
    """
    raw_status = get_fresh_server_status()
    normalized = _normalize_server_status(raw_status)

    request_id = str(uuid4())

    response = {
        'data': normalized,
        'meta': {
            'request_id': request_id,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'deprecated': False
        }
    }
    return jsonify(response), 200
