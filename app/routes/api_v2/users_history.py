from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.extensions import db
from app.models import User, UserType, HistoryLog, EventType
from sqlalchemy import desc


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    uuid: str = Field(..., description="User UUID")


class HistoryQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    event_types: Optional[str] = Field(
        None, description="Comma-separated EventType names (e.g., ADMIN_LOGIN_SUCCESS,INVITE_CREATED)"
    )


class HistoryItem(BaseModel):
    id: int
    timestamp: Optional[str] = None
    event_type: Optional[str] = None
    message: Optional[str] = None
    details: dict = {}


class PaginationMeta(BaseModel):
    page: int
    page_size: int
    total_items: int
    total_pages: int


class MetaModel(BaseModel):
    request_id: str
    generated_at: str
    deprecated: bool
    pagination: PaginationMeta
    filters: dict


class HistoryListResponse(BaseModel):
    data: List[HistoryItem]
    meta: MetaModel


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: MetaModel | dict | None = None


def _serialize_history(log: HistoryLog) -> dict:
    return {
        "id": log.id,
        "timestamp": log.timestamp.isoformat() if getattr(log, "timestamp", None) else None,
        "event_type": log.event_type.value if getattr(log, "event_type", None) else None,
        "message": getattr(log, "message", None),
        "details": getattr(log, "details", None) or {},
    }


def _apply_user_filter(query, user: User):
    if user.userType == UserType.OWNER:
        return query.filter(HistoryLog.owner_id == user.id)
    if user.userType == UserType.LOCAL:
        return query.filter(HistoryLog.local_user_id == user.id)
    if user.userType == UserType.SERVICE and user.linked_parent:
        return query.filter(HistoryLog.local_user_id == user.linked_parent.id)
    return query.filter(False)


@api_v2.get(
    "/users/<uuid>/history",
    tags=[users_tag],
    summary="Get user history",
    responses={200: HistoryListResponse, 404: ErrorResponse},
)
@login_required
def get_user_history(path: UserPath, query: HistoryQuery):
    request_id = __import__("uuid").uuid4().hex
    user = User.query.filter_by(uuid=path.uuid).first()
    if not user:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id}}), 404

    # Build base query scoped to this user
    q = HistoryLog.query.order_by(desc(HistoryLog.timestamp))
    q = _apply_user_filter(q, user)

    # Filter event types
    selected_events = []
    if query.event_types:
        for token in query.event_types.split(","):
            key = token.strip().upper()
            if not key:
                continue
            try:
                selected_events.append(EventType[key])
            except KeyError:
                continue
    if selected_events:
        q = q.filter(HistoryLog.event_type.in_(selected_events))

    # Pagination
    page = query.page
    size = query.page_size
    total_items = q.count()
    total_pages = (total_items + size - 1) // size if size else 1
    items = q.offset((page - 1) * size).limit(size).all()

    data = [_serialize_history(log) for log in items]

    response = {
        "data": data,
        "meta": {
            "request_id": request_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "deprecated": False,
            "pagination": {
                "page": page,
                "page_size": size,
                "total_items": total_items,
                "total_pages": total_pages or 1,
            },
            "filters": {
                "event_types": [e.value for e in selected_events] if selected_events else [],
            },
        },
    }
    return jsonify(response), 200
