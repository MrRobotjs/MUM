from __future__ import annotations

from uuid import uuid4
from typing import Optional, Any

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import User, UserType
from app.utils.helpers import get_user_by_uuid


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    user_uuid: str = Field(..., description="User UUID")


class UserInfo(BaseModel):
    username: Optional[str] = None
    user_uuid: str
    user_type: Optional[str] = None
    external_user_id: Optional[str] = None
    external_user_alt_id: Optional[str] = None
    service_type: Optional[str] = None
    server_name: Optional[str] = None


class ServiceEntry(BaseModel):
    server_id: int
    server_name: Optional[str] = None
    service_type: Optional[str] = None
    raw_data: dict | None = None
    service_settings: dict | None = None


class DebugData(BaseModel):
    user_info: UserInfo
    service_data: list[ServiceEntry]
    has_data: bool


class DebugResponse(BaseModel):
    data: DebugData
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.get(
    "/users/<user_uuid>/debug",
    tags=[users_tag],
    summary="Get raw user data for debugging",
    responses={200: DebugResponse, 400: ErrorResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_user_debug_data(path: UserPath, current_user):
    """Get raw user data for debugging purposes - returns JSON"""
    request_id = uuid4().hex

    user_obj, user_type = get_user_by_uuid(path.user_uuid)
    if not user_obj:
        return (
            jsonify({"error": {"code": "USER_NOT_FOUND", "message": f"User not found: {path.user_uuid}"}, "meta": {"request_id": request_id}}),
            404,
        )

    actual_id = user_obj.id
    user = None
    if user_type == "user_app_access":
        user = User.query.filter_by(userType=UserType.LOCAL, id=actual_id).first()
    elif user_type == "user_media_access":
        user = User.query.filter_by(userType=UserType.SERVICE, id=actual_id).first()
        if user:
            setattr(user, "_is_standalone", True)
    else:
        return (
            jsonify({"error": {"code": "INVALID_USER_TYPE", "message": f"Invalid user type: {user_type}"}, "meta": {"request_id": request_id}}),
            400,
        )

    if not user:
        return (
            jsonify({"error": {"code": "USER_NOT_FOUND", "message": f"User with ID {actual_id} not found"}, "meta": {"request_id": request_id}}),
            404,
        )

    # Build user info
    user_info: dict[str, Any] = {
        "username": getattr(user, "get_display_name", lambda: None)(),
        "user_uuid": str(user.uuid),
        "user_type": user.userType.value if getattr(user, "userType", None) else None,
    }

    # Add external IDs if this is a standalone service user
    if getattr(user, "_is_standalone", False):
        if getattr(user, "external_user_id", None):
            user_info["external_user_id"] = user.external_user_id
        if getattr(user, "external_user_alt_id", None):
            user_info["external_user_alt_id"] = user.external_user_alt_id
        if getattr(user, "server", None):
            st = user.server.service_type
            user_info["service_type"] = st.value if hasattr(st, "value") else str(st)
            user_info["server_name"] = user.server.server_nickname

    # Get service data
    service_data: list[dict] = []
    if getattr(user, "_is_standalone", False):
        user_accesses = [user]
    else:
        user_accesses = User.query.filter_by(userType=UserType.SERVICE, linkedUserId=user.uuid).all()

    for access in user_accesses:
        if getattr(access, "user_raw_data", None) or getattr(access, "service_settings", None):
            service_entry = {
                "server_id": access.server.id if getattr(access, "server", None) else 0,
                "server_name": access.server.server_nickname if getattr(access, "server", None) else None,
                "service_type": (access.server.service_type.value if getattr(access, "server", None) and getattr(access.server, "service_type", None) else None),
                "raw_data": getattr(access, "user_raw_data", None),
                "service_settings": getattr(access, "service_settings", None),
            }
            service_data.append(service_entry)

    return (
        jsonify({
            "data": {
                "user_info": user_info,
                "service_data": service_data,
                "has_data": len(service_data) > 0,
            },
            "meta": {"request_id": request_id},
        }),
        200,
    )

