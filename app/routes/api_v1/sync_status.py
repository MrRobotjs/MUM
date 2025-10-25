"""API endpoints for tracking sync status across sessions"""
from uuid import uuid4
from datetime import datetime, timezone
from flask import jsonify
from flask_login import login_required, current_user

from app.routes.api_v1 import bp
from app.extensions import cache


SYNC_STATUS_KEY = 'user_sync_status'


def get_sync_status():
    """Get current sync status from cache"""
    return cache.get(SYNC_STATUS_KEY) or {
        'is_syncing': False,
        'started_at': None,
        'started_by': None,
        'started_by_username': None,
        'progress': {
            'current_server': 0,
            'total_servers': 0,
            'current_server_name': None
        }
    }


def set_sync_status(status_data):
    """Set sync status in cache"""
    cache.set(SYNC_STATUS_KEY, status_data, timeout=3600)


def start_sync(total_servers):
    """Mark sync as started"""
    status = {
        'is_syncing': True,
        'started_at': datetime.now(timezone.utc).isoformat(),
        'started_by': current_user.id if current_user and current_user.is_authenticated else None,
        'started_by_username': current_user.localUsername if current_user and current_user.is_authenticated else 'Unknown',
        'progress': {
            'current_server': 0,
            'total_servers': total_servers,
            'current_server_name': None
        }
    }
    set_sync_status(status)
    return status


def update_sync_progress(current_server, total_servers, server_name):
    """Update sync progress"""
    status = get_sync_status()
    status['progress'] = {
        'current_server': current_server,
        'total_servers': total_servers,
        'current_server_name': server_name
    }
    set_sync_status(status)


def end_sync():
    """Mark sync as completed"""
    status = {
        'is_syncing': False,
        'started_at': None,
        'started_by': None,
        'started_by_username': None,
        'progress': {
            'current_server': 0,
            'total_servers': 0,
            'current_server_name': None
        }
    }
    set_sync_status(status)


@bp.route('/sync-status', methods=['GET'])
@login_required
def get_sync_status_endpoint():
    """Get current sync status"""
    request_id = str(uuid4())
    status = get_sync_status()

    return jsonify({
        'data': status,
        'meta': {'request_id': request_id}
    })
