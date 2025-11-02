from __future__ import annotations

from uuid import uuid4
from typing import Optional

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import User, UserType
# JWT permission checking handled by jwt_permission_required
from app.extensions import db


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    user_uuid: str = Field(..., description="User UUID")


class UserSettingsData(BaseModel):
    uuid: str
    notes: Optional[str] = None
    is_active: bool


class MetaModel(BaseModel):
    request_id: str
    deprecated: bool


class GetSettingsResponse(BaseModel):
    data: UserSettingsData
    meta: MetaModel


class UpdateSettingsBody(BaseModel):
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class UpdateSettingsData(BaseModel):
    success: bool
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class UpdateSettingsResponse(BaseModel):
    data: UpdateSettingsData
    meta: MetaModel


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: MetaModel


@api_v2.get(
    "/users/<user_uuid>/settings",
    tags=[users_tag],
    summary="Get user settings",
    responses={200: GetSettingsResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("edit_user")
def get_user_settings(path: UserPath, current_user):
    request_id = uuid4().hex
    user = User.query.filter_by(uuid=path.user_uuid).first()
    if not user:
        return (
            jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id, "deprecated": False}}),
            404,
        )

    data = {"uuid": user.uuid, "notes": user.notes, "is_active": bool(user.is_active)}
    return jsonify({"data": data, "meta": {"request_id": request_id, "deprecated": False}}), 200


@api_v2.patch(
    "/users/<user_uuid>/settings",
    tags=[users_tag],
    summary="Update user settings",
    responses={200: UpdateSettingsResponse, 400: ErrorResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("edit_user")
def update_user_settings(path: UserPath, body: UpdateSettingsBody, current_user):
    request_id = uuid4().hex
    user = User.query.filter_by(uuid=path.user_uuid).first()
    if not user:
        return (
            jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id, "deprecated": False}}),
            404,
        )

    if body.notes is not None:
        user.notes = body.notes
    if body.is_active is not None:
        if user.userType == UserType.OWNER and not body.is_active:
            return (
                jsonify({
                    "error": {
                        "code": "CANNOT_DEACTIVATE_OWNER",
                        "message": "Owner account cannot be deactivated.",
                    },
                    "meta": {"request_id": request_id, "deprecated": False},
                }),
                400,
            )
        user.is_active = bool(body.is_active)

    db.session.commit()

    return (
        jsonify({
            "data": {"success": True, "notes": user.notes, "is_active": user.is_active},
            "meta": {"request_id": request_id, "deprecated": False},
        }),
        200,
    )

