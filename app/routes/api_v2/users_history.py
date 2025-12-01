from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.extensions import db
from app.models import User, UserType, HistoryLog, EventType
from app.models_media_services import MediaStreamHistory
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


def _serialize_stream_history(entry: MediaStreamHistory) -> dict:
    """Serialize a MediaStreamHistory entry"""
    # Build poster URL for Plex or Jellyfin
    poster_url = None
    if entry.thumb_url and entry.server:
        service_type = entry.server.service_type.value
        if service_type == 'plex':
            # Plex thumb paths need to go through the image proxy
            poster_url = f"/admin/api/v2/media/plex/images/proxy?path={entry.thumb_url.lstrip('/')}"
        elif service_type == 'jellyfin':
            # Jellyfin paths like /Items/{Id}/Images/Primary need to go through jellyfin proxy
            poster_url = f"/admin/api/v2/media/jellyfin/images/proxy?path={entry.thumb_url.lstrip('/')}"

    return {
        "id": entry.id,
        "timestamp": entry.started_at.isoformat() if entry.started_at else None,
        "event_type": "MEDIA_STREAM",
        "message": f"Watched {entry.media_title or 'Unknown'}",
        "details": {
            "media_title": entry.media_title,
            "media_type": entry.media_type,
            "platform": entry.platform,
            "player": entry.player,
            "library_name": entry.library_name,
            "grandparent_title": entry.grandparent_title,
            "parent_title": entry.parent_title,
            "duration_seconds": entry.duration_seconds,
            "view_offset_at_end_seconds": entry.view_offset_at_end_seconds,
            "stopped_at": entry.stopped_at.isoformat() if entry.stopped_at else None,
            "poster_url": poster_url,
        },
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
    summary="Get user streaming history",
    responses={200: HistoryListResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_user_history(path: UserPath, query: HistoryQuery, current_user):
    request_id = __import__("uuid").uuid4().hex
    user = User.query.filter_by(uuid=path.uuid).first()
    if not user:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id}}), 404

    # Query streaming history for this user
    q = MediaStreamHistory.query.filter(MediaStreamHistory.user_uuid == user.uuid).order_by(desc(MediaStreamHistory.started_at))

    # Pagination
    page = query.page
    size = query.page_size
    total_items = q.count()
    total_pages = (total_items + size - 1) // size if size else 1
    items = q.offset((page - 1) * size).limit(size).all()

    data = [_serialize_stream_history(entry) for entry in items]

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
            "filters": {},
        },
    }
    return jsonify(response), 200
