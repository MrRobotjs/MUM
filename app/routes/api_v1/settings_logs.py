from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required
from sqlalchemy import or_, func
from sqlalchemy.orm import aliased

from app.routes.api_v1 import bp
from app.models import HistoryLog, EventType, User
from app.utils.helpers import permission_required


def _serialize_user(user: User | None):
    if not user:
        return None
    return {
        'id': user.id,
        'uuid': getattr(user, 'uuid', None),
        'username': user.localUsername or user.external_username,
        'display_name': user.get_display_name() if hasattr(user, 'get_display_name') else None
    }


def _serialize_log(log: HistoryLog):
    return {
        'id': log.id,
        'timestamp': log.timestamp.isoformat() if log.timestamp else None,
        'event_type': log.event_type.name if log.event_type else None,
        'message': log.message,
        'details': log.details,
        'owner': _serialize_user(log.owner),
        'local_user': _serialize_user(log.affected_local_user),
        'invite_id': log.invite_id
    }


@bp.route('/settings/logs', methods=['GET'])
@login_required
@permission_required('view_logs')
def list_history_logs():
    request_id = str(uuid4())
    page = max(1, request.args.get('page', type=int) or 1)
    page_size = max(1, min(request.args.get('page_size', type=int) or 25, 100))
    search_message = (request.args.get('search_message') or '').strip()
    event_type_str = (request.args.get('event_type') or '').strip().upper()
    related_user = (request.args.get('related_user') or '').strip()

    owner_alias = aliased(User)
    local_alias = aliased(User)

    query = HistoryLog.query.outerjoin(owner_alias, HistoryLog.owner).outerjoin(local_alias, HistoryLog.affected_local_user)

    if search_message:
        term = f"%{search_message}%"
        query = query.filter(HistoryLog.message.ilike(term))

    if event_type_str:
        try:
            event_enum = EventType[event_type_str]
            query = query.filter(HistoryLog.event_type == event_enum)
        except KeyError:
            return jsonify({
                'error': {
                    'code': 'INVALID_EVENT_TYPE',
                    'message': f'Unknown event type: {event_type_str}'
                },
                'meta': {'request_id': request_id}
            }), 400

    if related_user:
        term = f"%{related_user}%"
        query = query.filter(
            or_(
                func.lower(owner_alias.localUsername).like(func.lower(term)),
                func.lower(owner_alias.external_username).like(func.lower(term)),
                func.lower(local_alias.localUsername).like(func.lower(term)),
                func.lower(local_alias.external_username).like(func.lower(term))
            )
        )

    pagination = query.order_by(HistoryLog.timestamp.desc()).paginate(page=page, per_page=page_size, error_out=False)

    return jsonify({
        'data': [_serialize_log(item) for item in pagination.items],
        'meta': {
            'request_id': request_id,
            'pagination': {
                'page': pagination.page,
                'page_size': pagination.per_page,
                'total_items': pagination.total,
                'total_pages': pagination.pages or 1
            },
            'filters': {
                'search_message': search_message,
                'event_type': event_type_str,
                'related_user': related_user
            }
        }
    }), 200

