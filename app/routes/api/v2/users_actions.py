from __future__ import annotations

from uuid import uuid4

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import User, UserType
from app.extensions import db


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    uuid: str = Field(..., description="User UUID")


class ActionData(BaseModel):
    success: bool
    message: str


class MetaModel(BaseModel):
    request_id: str


class ActionResponse(BaseModel):
    data: ActionData
    meta: MetaModel


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: MetaModel


@api_v2.post(
    "/users/<uuid>/reset-password",
    tags=[users_tag],
    summary="Flag user to reset password",
    responses={200: ActionResponse, 400: ErrorResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def reset_user_password(path: UserPath, current_user):
    request_id = uuid4().hex
    user = User.query.filter_by(uuid=path.uuid).first()
    if not user:
        return (
            jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id}}),
            404,
        )

    # Only LOCAL or OWNER accounts can have local password
    if user.userType not in {UserType.LOCAL, UserType.OWNER}:
        return (
            jsonify(
                {
                    "error": {
                        "code": "UNSUPPORTED_USER_TYPE",
                        "message": "Password reset is only supported for local or owner accounts.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            400,
        )

    user.force_password_change = True
    db.session.commit()


    return (
        jsonify(
            {
                "data": {
                    "success": True,
                    "message": "Password reset flagged. User will be prompted to set a new password on next login.",
                },
                "meta": {"request_id": request_id},
            }
        ),
        200,
    )