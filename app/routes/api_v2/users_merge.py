from __future__ import annotations

from uuid import uuid4
from typing import Optional, List

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.extensions import db
from app.models import User, UserType, EventType
# JWT permission checking handled by jwt_permission_required, log_event
from app.utils.helpers import get_user_by_uuid
from app.services import user_service


users_tag = Tag(name="Users", description="User management endpoints")


class MergeBody(BaseModel):
    service_user_uuids: List[str] = Field(..., description="Service user UUIDs to merge/link")
    target_local_user_uuid: Optional[str] = Field(
        default=None, description="Existing local user UUID to link service users to"
    )
    new_local_username: Optional[str] = Field(
        default=None, description="If provided with new_local_password, creates a new local user and links"
    )
    new_local_password: Optional[str] = None


class MergeResultItem(BaseModel):
    user_uuid: str
    status: str
    message: Optional[str] = None


class MergeResponse(BaseModel):
    data: dict
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict | None = None


@api_v2.post(
    "/users/merge",
    tags=[users_tag],
    summary="Merge service users into a local account (link to existing or create new)",
    responses={200: MergeResponse, 400: ErrorResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("mass_edit_users")
def merge_users(body: MergeBody, current_user):
    request_id = uuid4().hex

    service_uuids = body.service_user_uuids or []
    if not isinstance(service_uuids, list) or not service_uuids:
        return (
            jsonify({
                "error": {"code": "INVALID_PAYLOAD", "message": "service_user_uuids must be a non-empty list."},
                "meta": {"request_id": request_id},
            }),
            400,
        )

    # Two modes: link to existing local user, or create a new one
    link_to_existing = bool(body.target_local_user_uuid)
    create_new = bool(body.new_local_username and body.new_local_password)

    if not link_to_existing and not create_new:
        return (
            jsonify({
                "error": {"code": "INVALID_PAYLOAD", "message": "Provide either target_local_user_uuid or new_local_username + new_local_password."},
                "meta": {"request_id": request_id},
            }),
            400,
        )

    # If creating a new local account, leverage user_service helper
    if create_new:
        try:
            processed, errors, local_user_id = user_service.merge_service_users_into_local_account(
                service_uuids,
                body.new_local_username.strip(),
                body.new_local_password,
                admin_id=getattr(current_user, "id", None),
            )

            created_local_uuid = None
            if local_user_id:
                local_user = User.query.get(local_user_id)
                created_local_uuid = getattr(local_user, "uuid", None)

            return (
                jsonify({
                    "data": {
                        "mode": "create_and_link",
                        "created_local_user_uuid": created_local_uuid,
                        "linked": processed,
                        "errors": errors,
                    },
                    "meta": {"request_id": request_id, "deprecated": False},
                }),
                200,
            )
        except Exception as exc:
            return (
                jsonify({
                    "error": {"code": "MERGE_FAILED", "message": str(exc)},
                    "meta": {"request_id": request_id},
                }),
                400,
            )

    # Else, link to an existing local user
    # Validate target local user
    target_obj, target_type = get_user_by_uuid(body.target_local_user_uuid)  # type: ignore[arg-type]
    if not target_obj or target_type not in {"user_app_access"}:
        return (
            jsonify({
                "error": {"code": "INVALID_TARGET", "message": "target_local_user_uuid must refer to an existing local/owner user."},
                "meta": {"request_id": request_id},
            }),
            404,
        )

    results: list[dict] = []
    linked = 0
    errors = 0

    for suuid in service_uuids:
        try:
            service_user, user_kind = get_user_by_uuid(suuid)
            if not service_user or user_kind != "user_media_access":
                errors += 1
                results.append({"user_uuid": suuid, "status": "error", "message": "Not a service user or not found"})
                continue

            if service_user.linkedUserId:
                errors += 1
                results.append({"user_uuid": suuid, "status": "skipped", "message": "Already linked"})
                continue

            service_user.linkedUserId = target_obj.uuid
            linked += 1
            results.append({"user_uuid": suuid, "status": "linked"})
        except Exception as exc:
            errors += 1
            results.append({"user_uuid": suuid, "status": "error", "message": str(exc)})

    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        return (
            jsonify({
                "error": {"code": "DB_COMMIT_FAILED", "message": f"Failed to commit merge: {exc}"},
                "meta": {"request_id": request_id},
            }),
            500,
        )

    log_event(
        EventType.SETTING_CHANGE,
        f"Linked {linked} service users to local user '{getattr(target_obj, 'localUsername', None)}'",
        admin_id=getattr(current_user, "id", None),
    )

    return (
        jsonify({
            "data": {
                "mode": "link_to_existing",
                "target_local_user_uuid": target_obj.uuid,
                "linked": linked,
                "errors": errors,
                "results": results,
            },
            "meta": {"request_id": request_id, "deprecated": False},
        }),
        200,
    )
