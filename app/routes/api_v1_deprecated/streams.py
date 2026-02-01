from uuid import uuid4
from datetime import datetime

from flask import jsonify, current_app
from flask_login import login_required

from app.routes.api_v1_deprecated import bp
from app.services.media_service_manager import MediaServiceManager


def _serialize_session(session_dict):
    return {
        'id': session_dict.get('session_id') or session_dict.get('uuid'),
        'rating_key': session_dict.get('rating_key'),
        'title': session_dict.get('title') or session_dict.get('media_title'),
        'grandparent_title': session_dict.get('grandparent_title'),
        'parent_title': session_dict.get('parent_title'),
        'user': session_dict.get('user', {}),
        'started_at': session_dict.get('started_at'),
        'progress_percent': session_dict.get('progress_percent'),
        'state': session_dict.get('state'),
        'server': {
            'id': session_dict.get('server_id'),
            'name': session_dict.get('server_name'),
            'service_type': session_dict.get('service_type')
        },
        'raw': session_dict
    }


@bp.route('/streams/active', methods=['GET'])
@login_required
def get_active_streams():
    """
    Returns active stream count and session previews for dashboard widgets.
    """
    request_id = str(uuid4())
    sessions = []
    try:
        raw_sessions = MediaServiceManager.get_all_active_sessions() or []
        for session in raw_sessions:
            if isinstance(session, dict):
                sessions.append(_serialize_session(session))
        count = len(sessions)
    except Exception as exc:
        current_app.logger.error(f"/admin/api/v1/streams/active failed: {exc}", exc_info=True)
        sessions = []
        count = 0

    response = {
        'data': {
            'count': count,
            'sessions': sessions[:5]  # limit preview to first 5 sessions
        },
        'meta': {
            'request_id': request_id,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'deprecated': False,
            'pagination': {
                'page': 1,
                'page_size': len(sessions[:5]),
                'total_items': count,
                'total_pages': 1
            }
        }
    }
    return jsonify(response), 200
