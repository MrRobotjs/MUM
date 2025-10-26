from __future__ import annotations

from uuid import uuid4
from datetime import datetime

from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.routes.api import get_fresh_server_status


dashboard_tag = Tag(name="Dashboard", description="Dashboard widgets")


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
        return {'summary': {'total_servers': 0, 'online': 0, 'offline': 0}, 'servers': [], 'grouped_by_service': []}

    if raw_status.get('multi_server'):
        servers = [
            {
                'id': s.get('server_id'),
                'service_type': s.get('service_type'),
                'name': s.get('name') or s.get('custom_name'),
                'nickname': s.get('custom_name'),
                'actual_server_name': s.get('actual_server_name'),
                'online': s.get('online'),
                'version': s.get('version'),
                'last_check_time': _serialize_datetime(s.get('last_check_time')),
                'error_message': s.get('error_message'),
                'url': s.get('url')
            } for s in raw_status.get('all_statuses', [])
        ]
        groups = []
        for service_type, payload in (raw_status.get('servers_by_service') or {}).items():
            groups.append({
                'service_type': service_type,
                'service_name': payload.get('service_name'),
                'online_count': payload.get('online_count', 0),
                'offline_count': payload.get('offline_count', 0),
                'total_count': payload.get('total_count', 0),
                'servers': [{'id': s.get('server_id'), 'name': s.get('name') or s.get('custom_name'), 'online': s.get('online'), 'version': s.get('version')} for s in payload.get('servers', [])]
            })
        summary = {'total_servers': len(servers), 'online': raw_status.get('online_count', 0), 'offline': raw_status.get('offline_count', 0)}
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
        summary = {'total_servers': 1, 'online': 1 if raw_status.get('online') else 0, 'offline': 0 if raw_status.get('online') else 1}
        groups = []
    return {'summary': summary, 'servers': servers, 'grouped_by_service': groups}


class ServerStatusResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/server-status",
    tags=[dashboard_tag],
    summary="Dashboard server status",
    responses={200: ServerStatusResponse},
)
@login_required
def get_server_status():
    raw_status = get_fresh_server_status()
    normalized = _normalize_server_status(raw_status)
    request_id = str(uuid4())
    return jsonify({'data': normalized, 'meta': {'request_id': request_id, 'generated_at': datetime.utcnow().isoformat() + 'Z', 'deprecated': False}}), 200

