from __future__ import annotations

from uuid import uuid4
from typing import Optional, List

from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import User, UserType
from app.models_overseerr import OverseerrUserLink


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    uuid: str = Field(..., description="User UUID")


class OverseerrLinkItem(BaseModel):
    server_id: int
    server_name: Optional[str] = None
    overseerr_user_id: Optional[int] = None
    overseerr_username: Optional[str] = None
    overseerr_email: Optional[str] = None
    is_linked: bool
    last_sync_at: Optional[str] = None


class ListResponse(BaseModel):
    data: List[OverseerrLinkItem]
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict | None = None


def _serialize_overseerr_link(link: OverseerrUserLink) -> dict:
    return {
        "server_id": link.server_id,
        "server_name": link.server.server_nickname if getattr(link, "server", None) else None,
        "overseerr_user_id": link.overseerr_user_id,
        "overseerr_username": link.overseerr_username,
        "overseerr_email": link.overseerr_email,
        "is_linked": bool(getattr(link, "is_linked", False)),
        "last_sync_at": link.last_sync_at.isoformat() if getattr(link, "last_sync_at", None) else None,
    }


@api_v2.get(
    "/users/<uuid>/overseerr",
    tags=[users_tag],
    summary="Get Overseerr link info for a user",
    responses={200: ListResponse, 404: ErrorResponse},
)
@login_required
def get_user_overseerr(path: UserPath):
    request_id = uuid4().hex
    user = User.query.filter_by(uuid=path.uuid).first()
    if not user:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id}}), 404

    # For service accounts, use linked parent local user if present
    target_uuid = user.linkedUserId if user.userType == UserType.SERVICE else user.uuid
    local_user = User.query.filter_by(uuid=target_uuid).first()
    if not local_user:
        return jsonify({"data": [], "meta": {"request_id": request_id, "deprecated": False}}), 200

    links = OverseerrUserLink.query.filter_by(plex_user_id=local_user.plex_uuid).all()
    data = [_serialize_overseerr_link(l) for l in links]
    return jsonify({"data": data, "meta": {"request_id": request_id, "deprecated": False}}), 200
