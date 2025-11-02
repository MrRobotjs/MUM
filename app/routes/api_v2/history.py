from __future__ import annotations

from uuid import uuid4
from datetime import datetime
from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import HistoryLog, EventType
from sqlalchemy import desc


history_tag = Tag(name="History", description="Activity history")


def _parse_iso_datetime(value: str | None):
    if not value:
        return None
    try:
        cleaned = value.replace('Z', '+00:00')
        return datetime.fromisoformat(cleaned)
    except ValueError:
        return None


class RecentHistoryQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    event_types: str | None = None
    invite_id: int | None = None
    owner_id: int | None = None
    local_user_id: int | None = None
    since: str | None = None


class HistoryListResponse(BaseModel):
    data: list[dict]
    meta: dict


@api_v2.get(
    "/history/recent",
    tags=[history_tag],
    summary="Recent history logs",
    responses={200: HistoryListResponse},
)
@jwt_required_with_user()
def get_recent_history(query: RecentHistoryQuery, current_user):
    request_id = str(uuid4())
    page = query.page
    page_size = query.page_size
    since = _parse_iso_datetime(query.since)

    q = HistoryLog.query.order_by(desc(HistoryLog.timestamp))
    if query.event_types:
        requested = []
        for item in query.event_types.split(','):
            key = item.strip().upper()
            if not key:
                continue
            try:
                requested.append(EventType[key])
            except KeyError:
                continue
        if requested:
            q = q.filter(HistoryLog.event_type.in_(requested))
    if query.invite_id:
        q = q.filter(HistoryLog.invite_id == query.invite_id)
    if query.owner_id:
        q = q.filter(HistoryLog.owner_id == query.owner_id)
    if query.local_user_id:
        q = q.filter(HistoryLog.local_user_id == query.local_user_id)
    if since:
        q = q.filter(HistoryLog.timestamp >= since)

    pagination = q.paginate(page=page, per_page=page_size, error_out=False)
    logs = [{
        'id': log.id,
        'timestamp': log.timestamp.isoformat() if log.timestamp else None,
        'event_type': log.event_type.value if log.event_type else None,
        'message': log.message,
        'details': log.details or {},
        'owner_id': log.owner_id,
        'local_user_id': log.local_user_id,
        'invite_id': log.invite_id
    } for log in pagination.items]

    return jsonify({'data': logs, 'meta': {'request_id': request_id, 'generated_at': datetime.utcnow().isoformat() + 'Z', 'deprecated': False, 'pagination': {'page': pagination.page, 'page_size': pagination.per_page, 'total_items': pagination.total, 'total_pages': pagination.pages or 1}, 'filters': {'event_types': query.event_types.split(',') if query.event_types else [], 'invite_id': query.invite_id, 'owner_id': query.owner_id, 'local_user_id': query.local_user_id, 'since': since.isoformat() if since else None}}}), 200


class HistorySearchQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    event_types: str | None = None
    search: str | None = None
    invite_id: int | None = None
    owner_id: int | None = None
    local_user_id: int | None = None
    user_uuid: str | None = None
    date_from: str | None = None
    date_to: str | None = None


@api_v2.get(
    "/history",
    tags=[history_tag],
    summary="Search history logs",
    responses={200: HistoryListResponse},
)
@jwt_required_with_user()
def search_history(query: HistorySearchQuery, current_user):
    request_id = str(uuid4())
    page = query.page
    page_size = query.page_size
    date_from = _parse_iso_datetime(query.date_from)
    date_to = _parse_iso_datetime(query.date_to)

    q = HistoryLog.query.order_by(desc(HistoryLog.timestamp))
    if query.event_types:
        requested = []
        for item in query.event_types.split(','):
            key = item.strip().upper()
            if not key:
                continue
            try:
                requested.append(EventType[key])
            except KeyError:
                continue
        if requested:
            q = q.filter(HistoryLog.event_type.in_(requested))
    if query.search:
        q = q.filter(HistoryLog.message.ilike(f'%{query.search}%'))
    if query.invite_id:
        q = q.filter(HistoryLog.invite_id == query.invite_id)
    if query.owner_id:
        q = q.filter(HistoryLog.owner_id == query.owner_id)
    if query.local_user_id:
        q = q.filter(HistoryLog.local_user_id == query.local_user_id)
    if query.user_uuid:
        from app.models import User
        user = User.query.filter_by(uuid=query.user_uuid).first()
        if user:
            q = q.filter((HistoryLog.owner_id == user.id) | (HistoryLog.local_user_id == user.id))
    if date_from:
        q = q.filter(HistoryLog.timestamp >= date_from)
    if date_to:
        q = q.filter(HistoryLog.timestamp <= date_to)

    pagination = q.paginate(page=page, per_page=page_size, error_out=False)
    logs = [{
        'id': log.id,
        'timestamp': log.timestamp.isoformat() if log.timestamp else None,
        'event_type': log.event_type.value if log.event_type else None,
        'message': log.message,
        'details': log.details or {},
        'owner_id': log.owner_id,
        'local_user_id': log.local_user_id,
        'invite_id': log.invite_id,
        'owner_username': log.owner.get_display_name() if log.owner else None,
        'affected_user_username': log.affected_local_user.get_display_name() if log.affected_local_user else None,
        'invite_token': log.related_invite.token if log.related_invite else None
    } for log in pagination.items]

    return jsonify({'data': logs, 'meta': {'request_id': request_id, 'generated_at': datetime.utcnow().isoformat() + 'Z', 'deprecated': False, 'pagination': {'page': pagination.page, 'page_size': pagination.per_page, 'total_items': pagination.total, 'total_pages': pagination.pages or 1}, 'filters': {'event_types': query.event_types.split(',') if query.event_types else [], 'search_text': query.search or None, 'invite_id': query.invite_id, 'owner_id': query.owner_id, 'local_user_id': query.local_user_id, 'user_uuid': query.user_uuid, 'date_from': date_from.isoformat() if date_from else None, 'date_to': date_to.isoformat() if date_to else None}}}), 200

