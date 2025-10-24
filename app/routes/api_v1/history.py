from uuid import uuid4
from datetime import datetime

from flask import jsonify, request
from flask_login import login_required
from sqlalchemy import desc

from app.routes.api_v1 import bp
from app.models import HistoryLog, EventType


def _parse_iso_datetime(value: str):
    if not value:
        return None
    try:
        cleaned = value.replace('Z', '+00:00')
        return datetime.fromisoformat(cleaned)
    except ValueError:
        return None


@bp.route('/history/recent', methods=['GET'])
@login_required
def get_recent_history():
    """
    Returns recent HistoryLog entries for dashboard widgets or activity feeds.
    Supports filtering by event_type, invite, and time window.
    """
    request_id = str(uuid4())
    page = max(1, int(request.args.get('page', 1)))
    page_size = request.args.get('page_size', 25)
    try:
        page_size = int(page_size)
    except (TypeError, ValueError):
        page_size = 25
    page_size = max(1, min(page_size, 100))

    event_types_param = request.args.get('event_types')
    invite_id = request.args.get('invite_id', type=int)
    owner_id = request.args.get('owner_id', type=int)
    local_user_id = request.args.get('local_user_id', type=int)
    since = _parse_iso_datetime(request.args.get('since'))

    query = HistoryLog.query.order_by(desc(HistoryLog.timestamp))

    if event_types_param:
        requested = []
        for item in event_types_param.split(','):
            key = item.strip().upper()
            if not key:
                continue
            try:
                requested.append(EventType[key])
            except KeyError:
                continue
        if requested:
            query = query.filter(HistoryLog.event_type.in_(requested))

    if invite_id:
        query = query.filter(HistoryLog.invite_id == invite_id)

    if owner_id:
        query = query.filter(HistoryLog.owner_id == owner_id)

    if local_user_id:
        query = query.filter(HistoryLog.local_user_id == local_user_id)

    if since:
        query = query.filter(HistoryLog.timestamp >= since)

    pagination = query.paginate(page=page, per_page=page_size, error_out=False)
    logs = [
        {
            'id': log.id,
            'timestamp': log.timestamp.isoformat() if log.timestamp else None,
            'event_type': log.event_type.value if log.event_type else None,
            'message': log.message,
            'details': log.details or {},
            'owner_id': log.owner_id,
            'local_user_id': log.local_user_id,
            'invite_id': log.invite_id
        }
        for log in pagination.items
    ]

    response = {
        'data': logs,
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
                'event_types': event_types_param.split(',') if event_types_param else [],
                'invite_id': invite_id,
                'owner_id': owner_id,
                'local_user_id': local_user_id,
                'since': since.isoformat() if since else None
            }
        }
    }
    return jsonify(response), 200


@bp.route('/history', methods=['GET'])
@login_required
def search_history():
    """
    Advanced history search endpoint with comprehensive filtering.
    Supports searching by event type, user, date range, and text search.
    """
    request_id = str(uuid4())
    page = max(1, int(request.args.get('page', 1)))
    page_size = request.args.get('page_size', 25)
    try:
        page_size = int(page_size)
    except (TypeError, ValueError):
        page_size = 25
    page_size = max(1, min(page_size, 100))

    # Filter parameters
    event_types_param = request.args.get('event_types')
    search_text = request.args.get('search', '').strip()
    invite_id = request.args.get('invite_id', type=int)
    owner_id = request.args.get('owner_id', type=int)
    local_user_id = request.args.get('local_user_id', type=int)
    user_uuid = request.args.get('user_uuid')

    # Date range filters
    date_from = _parse_iso_datetime(request.args.get('date_from'))
    date_to = _parse_iso_datetime(request.args.get('date_to'))

    query = HistoryLog.query.order_by(desc(HistoryLog.timestamp))

    # Event type filter
    if event_types_param:
        requested = []
        for item in event_types_param.split(','):
            key = item.strip().upper()
            if not key:
                continue
            try:
                requested.append(EventType[key])
            except KeyError:
                continue
        if requested:
            query = query.filter(HistoryLog.event_type.in_(requested))

    # Text search in message
    if search_text:
        query = query.filter(HistoryLog.message.ilike(f'%{search_text}%'))

    # User filters
    if invite_id:
        query = query.filter(HistoryLog.invite_id == invite_id)

    if owner_id:
        query = query.filter(HistoryLog.owner_id == owner_id)

    if local_user_id:
        query = query.filter(HistoryLog.local_user_id == local_user_id)

    if user_uuid:
        # Find user by UUID and filter by their ID
        from app.models import User
        user = User.query.filter_by(uuid=user_uuid).first()
        if user:
            query = query.filter((HistoryLog.owner_id == user.id) | (HistoryLog.local_user_id == user.id))

    # Date range filters
    if date_from:
        query = query.filter(HistoryLog.timestamp >= date_from)

    if date_to:
        query = query.filter(HistoryLog.timestamp <= date_to)

    pagination = query.paginate(page=page, per_page=page_size, error_out=False)

    logs = [
        {
            'id': log.id,
            'timestamp': log.timestamp.isoformat() if log.timestamp else None,
            'event_type': log.event_type.value if log.event_type else None,
            'message': log.message,
            'details': log.details or {},
            'owner_id': log.owner_id,
            'local_user_id': log.local_user_id,
            'invite_id': log.invite_id,
            # Add related object info if available
            'owner_username': log.owner.get_display_name() if log.owner else None,
            'affected_user_username': log.affected_local_user.get_display_name() if log.affected_local_user else None,
            'invite_token': log.related_invite.token if log.related_invite else None
        }
        for log in pagination.items
    ]

    response = {
        'data': logs,
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
                'event_types': event_types_param.split(',') if event_types_param else [],
                'search_text': search_text or None,
                'invite_id': invite_id,
                'owner_id': owner_id,
                'local_user_id': local_user_id,
                'user_uuid': user_uuid,
                'date_from': date_from.isoformat() if date_from else None,
                'date_to': date_to.isoformat() if date_to else None
            }
        }
    }
    return jsonify(response), 200
