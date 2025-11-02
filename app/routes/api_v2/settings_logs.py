from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import HistoryLog, EventType, User
# JWT permission checking handled by jwt_permission_required
from sqlalchemy import or_, func
from sqlalchemy.orm import aliased


settings_tag = Tag(name="Settings", description="Application settings")


class LogUser(BaseModel):
    id: int | None = None
    uuid: str | None = None
    username: str | None = None
    display_name: str | None = None


class LogItem(BaseModel):
    id: int
    timestamp: str | None
    event_type: str | None
    message: str | None
    details: dict | None
    owner: LogUser | None
    local_user: LogUser | None
    invite_id: int | None


class LogsQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    search_message: str | None = None
    event_type: str | None = None
    related_user: str | None = None


class LogsListResponse(BaseModel):
    data: list[LogItem]
    meta: dict


def _serialize_user(user: User | None):
    if not user:
        return None
    return {
        "id": user.id,
        "uuid": getattr(user, "uuid", None),
        "username": user.localUsername or getattr(user, "external_username", None),
        "display_name": getattr(user, "get_display_name", lambda: None)(),
    }


def _serialize_log(log: HistoryLog):
    return {
        "id": log.id,
        "timestamp": log.timestamp.isoformat() if getattr(log, "timestamp", None) else None,
        "event_type": (log.event_type.name if getattr(log, "event_type", None) else None),
        "message": getattr(log, "message", None),
        "details": getattr(log, "details", None),
        "owner": _serialize_user(getattr(log, "owner", None)),
        "local_user": _serialize_user(getattr(log, "affected_local_user", None)),
        "invite_id": getattr(log, "invite_id", None),
    }


@api_v2.get(
    "/settings/logs",
    tags=[settings_tag],
    summary="List history logs",
    responses={200: LogsListResponse},
)
@jwt_required_with_user()
@jwt_permission_required("view_logs")
def list_history_logs(query: LogsQuery, current_user):
    request_id = uuid4().hex
    owner_alias = aliased(User)
    local_alias = aliased(User)

    q = HistoryLog.query.outerjoin(owner_alias, HistoryLog.owner).outerjoin(local_alias, HistoryLog.affected_local_user)

    if query.search_message:
        term = f"%{query.search_message}%"
        q = q.filter(HistoryLog.message.ilike(term))

    if query.event_type:
        try:
            event_enum = EventType[query.event_type.strip().upper()]
            q = q.filter(HistoryLog.event_type == event_enum)
        except KeyError:
            return jsonify({
                "error": {"code": "INVALID_EVENT_TYPE", "message": f"Unknown event type: {query.event_type}"},
                "meta": {"request_id": request_id},
            }), 400

    if query.related_user:
        term = f"%{query.related_user}%"
        q = q.filter(
            or_(
                func.lower(owner_alias.localUsername).like(func.lower(term)),
                func.lower(owner_alias.external_username).like(func.lower(term)),
                func.lower(local_alias.localUsername).like(func.lower(term)),
                func.lower(local_alias.external_username).like(func.lower(term)),
            )
        )

    pagination = q.order_by(HistoryLog.timestamp.desc()).paginate(page=query.page, per_page=query.page_size, error_out=False)

    return jsonify(
        {
            "data": [_serialize_log(item) for item in pagination.items],
            "meta": {
                "request_id": request_id,
                "pagination": {
                    "page": pagination.page,
                    "page_size": pagination.per_page,
                    "total_items": pagination.total,
                    "total_pages": pagination.pages or 1,
                },
                "filters": {
                    "search_message": query.search_message,
                    "event_type": (query.event_type or ""),
                    "related_user": query.related_user,
                },
            },
        }
    ), 200

