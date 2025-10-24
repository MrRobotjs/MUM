
from uuid import uuid4
from datetime import datetime

from flask import jsonify, request
from flask_login import login_required
from sqlalchemy import desc

from app.routes.api_v1 import bp
from app.models import User, UserType, HistoryLog, EventType


def _serialize_history(log):
    return {
        'id': log.id,
        'timestamp': log.timestamp.isoformat() if log.timestamp else None,
        'event_type': log.event_type.value if log.event_type else None,
        'message': log.message,
        'details': log.details or {}
    }


def _apply_user_filter(query, user: User):
    if user.userType == UserType.OWNER:
        return query.filter(HistoryLog.owner_id == user.id)
    if user.userType == UserType.LOCAL:
        return query.filter(HistoryLog.local_user_id == user.id)
    if user.userType == UserType.SERVICE and user.linked_parent:
        return query.filter(HistoryLog.local_user_id == user.linked_parent.id)
    return query.filter(False)


@bp.route('/users/<string:user_uuid>/history', methods=['GET'])
@login_required
def get_user_history(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()

    page = max(1, request.args.get('page', type=int) or 1)
    page_size = request.args.get('page_size', type=int) or 25
    page_size = max(1, min(page_size, 100))

    event_types_param = request.args.get('event_types')
    event_filters = []
    if event_types_param:
        for token in event_types_param.split(','):
            key = token.strip().upper()
            if not key:
                continue
            try:
                event_filters.append(EventType[key])
            except KeyError:
                continue

    query = HistoryLog.query.order_by(desc(HistoryLog.timestamp))
    query = _apply_user_filter(query, user)

    if event_filters:
        query = query.filter(HistoryLog.event_type.in_(event_filters))

    pagination = query.paginate(page=page, per_page=page_size, error_out=False)

    response = {
        'data': [_serialize_history(log) for log in pagination.items],
        'meta': {
            'request_id': request_id,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'deprecated': False,
            'pagination': {
                'page': pagination.page,
                'page_size': pagination.per_page,
                'total_items': pagination.total,
                'total_pages': pagination.pages or 1
            },
            'filters': {
                'event_types': event_filters and [event.value for event in event_filters] or []
            }
        }
    }
    return jsonify(response), 200
