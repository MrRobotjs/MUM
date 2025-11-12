from __future__ import annotations

from uuid import uuid4
from typing import Optional

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import User, UserType, EventType
from app.utils.helpers import log_event
from app.extensions import db


users_tag = Tag(name="Users", description="User management endpoints")


class LocalUserPath(BaseModel):
    user_uuid: str = Field(..., description="Local user UUID")


class ServiceUserPath(LocalUserPath):
    service_uuid: str = Field(..., description="Service user UUID")


class ServiceAccountItem(BaseModel):
    uuid: str
    service_type: Optional[str] = None
    server_name: Optional[str] = None
    external_username: Optional[str] = None
    external_email: Optional[str] = None
    linked_at: Optional[str] = None


class ListResponse(BaseModel):
    data: list[ServiceAccountItem]
    meta: dict


class LinkBody(BaseModel):
    service_uuid: str


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict | None = None


class SuccessData(BaseModel):
    success: bool


class SuccessResponse(BaseModel):
    data: SuccessData
    meta: dict


def _serialize_service_account(account: User) -> dict:
    return {
        "uuid": account.uuid,
        "service_type": account.server.service_type.value if account.server else None,
        "server_name": account.server.server_nickname if account.server else None,
        "external_username": account.external_username,
        "external_email": account.external_email,
        "linked_at": account.created_at.isoformat() if account.created_at else None,
    }


def _get_local_user(uuid: str) -> User:
    from flask import abort

    user = User.query.filter_by(uuid=uuid).first()
    if not user:
        abort(404, description="User not found")
    if user.userType not in {UserType.LOCAL, UserType.OWNER}:
        abort(400, description="Service accounts can only be linked to local/admin users.")
    return user


@api_v2.get(
    "/users/<user_uuid>/service-accounts",
    tags=[users_tag],
    summary="List linked service accounts",
    responses={200: ListResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def list_service_accounts(path: LocalUserPath, current_user):
    request_id = uuid4().hex
    user = _get_local_user(path.user_uuid)
    accounts = getattr(user, "linked_children", []) or []
    data = [_serialize_service_account(a) for a in accounts if a.userType == UserType.SERVICE]
    return jsonify({"data": data, "meta": {"request_id": request_id, "deprecated": False}}), 200


@api_v2.post(
    "/users/<user_uuid>/service-accounts",
    tags=[users_tag],
    summary="Link a service account to local user",
    responses={200: ServiceAccountItem, 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def link_service_account(path: LocalUserPath, body: LinkBody, current_user):
    request_id = uuid4().hex
    user = _get_local_user(path.user_uuid)

    service_user = User.query.filter_by(uuid=body.service_uuid, userType=UserType.SERVICE).first()
    if not service_user:
        return (
            jsonify({"error": {"code": "SERVICE_USER_NOT_FOUND", "message": "Service account not found."}, "meta": {"request_id": request_id}}),
            404,
        )

    if service_user.linkedUserId:
        return (
            jsonify({"error": {"code": "SERVICE_USER_ALREADY_LINKED", "message": "Service account is already linked to another user."}, "meta": {"request_id": request_id}}),
            409,
        )

    service_user.linkedUserId = user.uuid
    db.session.commit()

    log_event(
        EventType.SETTING_CHANGE,
        f"Service account '{service_user.external_username}' linked to user '{user.localUsername}'.",
    )

    return jsonify(_serialize_service_account(service_user)), 200


@api_v2.delete(
    "/users/<user_uuid>/service-accounts/<service_uuid>",
    tags=[users_tag],
    summary="Unlink a service account from local user",
    responses={200: SuccessResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def unlink_service_account(path: ServiceUserPath, current_user):
    request_id = uuid4().hex
    user = _get_local_user(path.user_uuid)
    service_user = User.query.filter_by(uuid=path.service_uuid, userType=UserType.SERVICE).first()
    if not service_user or service_user.linkedUserId != user.uuid:
        return (
            jsonify({"error": {"code": "SERVICE_USER_NOT_LINKED", "message": "Service account is not linked to this user."}, "meta": {"request_id": request_id}}),
            404,
        )

    service_user.linkedUserId = None
    db.session.commit()

    log_event(
        EventType.SETTING_CHANGE,
        f"Service account '{service_user.external_username}' unlinked from user '{user.localUsername}'.",
    )

    return jsonify({"data": {"success": True}, "meta": {"request_id": request_id}}), 200


@api_v2.get(
    "/users/<user_uuid>/available-service-accounts",
    tags=[users_tag],
    summary="List available (unlinked) service accounts",
    responses={200: ListResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def list_available_service_accounts(path: LocalUserPath, current_user):
    request_id = uuid4().hex
    _ = _get_local_user(path.user_uuid)

    standalone_users = (
        User.query.filter_by(userType=UserType.SERVICE)
        .filter(User.linkedUserId.is_(None))
        .all()
    )

    data = []
    for su in standalone_users:
        data.append(
            {
                "uuid": su.uuid,
                "service_type": su.server.service_type.value if su.server else None,
                "server_name": su.server.server_nickname if su.server else None,
                "external_username": su.external_username,
                "external_email": su.external_email,
                "avatar_url": su.external_avatar_url,
            }
        )

    return jsonify({"data": data, "meta": {"request_id": request_id, "deprecated": False}}), 200
