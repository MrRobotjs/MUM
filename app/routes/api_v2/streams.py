from __future__ import annotations

from uuid import uuid4
from datetime import datetime

from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.services.media_service_manager import MediaServiceManager


streams_tag = Tag(name="Streaming", description="Active streams preview")


class SessionServer(BaseModel):
    id: int | None = None
    name: str | None = None
    service_type: str | None = None


class SessionUser(BaseModel):
    uuid: str | None = None
    username: str | None = None
    email: str | None = None


class StreamPreviewItem(BaseModel):
    id: str | None = None
    rating_key: str | None = None
    title: str | None = None
    grandparent_title: str | None = None
    parent_title: str | None = None
    user: dict | None = None
    started_at: str | None = None
    progress_percent: float | int | None = None
    state: str | None = None
    server: SessionServer | dict | None = None
    raw: dict | None = None


class StreamsActiveData(BaseModel):
    count: int
    sessions: list[StreamPreviewItem]


class StreamsActiveResponse(BaseModel):
    data: StreamsActiveData
    meta: dict


def _serialize_session(session_dict: dict) -> dict:
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


@api_v2.get(
    "/streams/active",
    tags=[streams_tag],
    summary="Active stream preview for dashboard",
    responses={200: StreamsActiveResponse},
)
@login_required
def get_active_streams():
    request_id = str(uuid4())
    sessions = []
    try:
        raw_sessions = MediaServiceManager.get_all_active_sessions() or []
        for session in raw_sessions:
            if isinstance(session, dict):
                sessions.append(_serialize_session(session))
        count = len(sessions)
    except Exception as exc:
        sessions = []
        count = 0

    return jsonify({
        'data': {
            'count': count,
            'sessions': sessions[:5]
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
    }), 200

