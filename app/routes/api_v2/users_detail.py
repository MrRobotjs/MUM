from __future__ import annotations

from datetime import datetime
from typing import Optional

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import User, UserType


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    uuid: str = Field(..., description="User UUID")


class ServiceUserItem(BaseModel):
    uuid: str
    server_id: Optional[int] = None
    server_name: Optional[str] = None
    service_type: Optional[str] = None
    external_user_id: Optional[str] = None
    external_username: Optional[str] = None
    is_active: bool


class UserDetail(BaseModel):
    id: int
    uuid: str
    user_type: str
    username: Optional[str] = None
    email: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: Optional[str] = None
    last_login_at: Optional[str] = None
    is_active: bool
    admin_roles: list[str] = []
    linked_service_count: int = 0
    linked_service_users: list[ServiceUserItem] = []


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


def _display_name(u: User) -> Optional[str]:
    if hasattr(u, "get_display_name"):
        try:
            return u.get_display_name()  # type: ignore[attr-defined]
        except Exception:
            pass
    return (
        u.localUsername
        or getattr(u, "external_username", None)
        or getattr(u, "discord_username", None)
        or u.email
        or getattr(u, "external_email", None)
    )


def _username(u: User) -> Optional[str]:
    return u.localUsername or getattr(u, "external_username", None) or getattr(u, "discord_username", None)


def _email(u: User) -> Optional[str]:
    return u.email or getattr(u, "discord_email", None) or getattr(u, "external_email", None)


def _service_item(su: User) -> dict:
    server = getattr(su, "server", None)
    service_type = None
    if server and getattr(server, "service_type", None) is not None:
        st = server.service_type
        service_type = st.value if hasattr(st, "value") else str(st)
    return {
        "uuid": su.uuid,
        "server_id": getattr(su, "server_id", None),
        "server_name": getattr(server, "server_nickname", None) or getattr(server, "server_name", None),
        "service_type": service_type,
        "external_user_id": getattr(su, "external_user_id", None),
        "external_username": getattr(su, "external_username", None),
        "is_active": bool(getattr(su, "is_active", True)),
    }


def _to_detail(u: User) -> dict:
    # linked service users
    linked = []
    if u.userType == UserType.LOCAL:
        try:
            linked = u.get_linked_users() or []
        except Exception:
            linked = []

    return {
        "id": u.id,
        "uuid": u.uuid,
        "user_type": (u.userType.value if hasattr(u.userType, "value") else str(u.userType)),
        "username": _username(u),
        "email": _email(u),
        "display_name": _display_name(u),
        "avatar_url": getattr(u, "external_avatar_url", None),
        "created_at": u.created_at.isoformat() + "Z" if getattr(u, "created_at", None) else None,
        "last_login_at": u.last_login_at.isoformat() + "Z" if getattr(u, "last_login_at", None) else None,
        "is_active": bool(getattr(u, "is_active", True)),
        "admin_roles": [r.name for r in getattr(u, "admin_roles", [])] if getattr(u, "admin_roles", None) else [],
        "linked_service_count": len(linked),
        "linked_service_users": [_service_item(su) for su in linked],
    }


@api_v2.get(
    "/users/<uuid>",
    tags=[users_tag],
    summary="Get user detail",
    responses={200: UserDetail, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_user(path: UserPath, current_user):
    user = User.query.filter_by(uuid=path.uuid).first()
    if not user:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}}), 404
    return jsonify(_to_detail(user)), 200

