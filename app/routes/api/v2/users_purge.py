from __future__ import annotations

from uuid import uuid4
from datetime import datetime
from typing import Optional, List

from flask import jsonify, request, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import User
# JWT permission checking handled by jwt_permission_required, log_event
from app.services import user_service


users_tag = Tag(name="Users", description="User management endpoints")


class EligibleQuery(BaseModel):
    inactive_days: int = Field(180, ge=0)
    exclude_sharers: bool = Field(True)
    exclude_whitelisted: bool = Field(True)
    ignore_creation_date: bool = Field(False)


class UserForPurge(BaseModel):
    uuid: str
    username: Optional[str] = None
    email: Optional[str] = None
    server_name: Optional[str] = None
    service_type: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: Optional[str] = None
    last_streamed_at: Optional[str] = None
    last_login_at: Optional[str] = None
    days_since_activity: Optional[int] = None
    is_sharer: bool = False
    is_whitelisted: bool = False


class Criteria(BaseModel):
    inactive_days: int
    exclude_sharers: bool
    exclude_whitelisted: bool
    ignore_creation_date: bool


class EligibleResponse(BaseModel):
    data: dict
    meta: dict


class ErrorDetail(BaseModel):
    message: str
    type: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.get(
    "/users/eligible-for-purge",
    tags=[users_tag],
    summary="Get users eligible for purge",
    responses={200: EligibleResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_eligible_for_purge(query: EligibleQuery, current_user):
    """Get users eligible for purge based on criteria."""
    request_id = uuid4().hex
    try:
        current_app.logger.info(
            "Getting users eligible for purge: inactive_days=%s, exclude_sharers=%s, "
            "exclude_whitelisted=%s, ignore_creation_date=%s",
            query.inactive_days,
            query.exclude_sharers,
            query.exclude_whitelisted,
            query.ignore_creation_date,
        )

        eligible_users = user_service.get_users_eligible_for_purge(
            inactive_days_threshold=query.inactive_days,
            exclude_sharers=query.exclude_sharers,
            exclude_whitelisted=query.exclude_whitelisted,
            ignore_creation_date_for_never_streamed=query.ignore_creation_date,
        )

        users_data: List[dict] = []
        for u in eligible_users:
            users_data.append(
                {
                    "uuid": u.get("uuid"),
                    "username": u.get("username"),
                    "email": u.get("email"),
                    "server_name": u.get("server_name"),
                    "service_type": u.get("service_type"),
                    "avatar_url": u.get("avatar_url"),
                    "created_at": u.get("created_at").isoformat() if u.get("created_at") else None,
                    "last_streamed_at": u.get("last_streamed_at").isoformat() if u.get("last_streamed_at") else None,
                    "last_login_at": u.get("last_login_at").isoformat() if u.get("last_login_at") else None,
                    "days_since_activity": u.get("days_since_activity"),
                    "is_sharer": u.get("is_sharer", False),
                    "is_whitelisted": u.get("is_whitelisted", False),
                }
            )

        return (
            jsonify(
                {
                    "data": {
                        "users": users_data,
                        "criteria": {
                            "inactive_days": query.inactive_days,
                            "exclude_sharers": query.exclude_sharers,
                            "exclude_whitelisted": query.exclude_whitelisted,
                            "ignore_creation_date": query.ignore_creation_date,
                        },
                    },
                    "meta": {"request_id": request_id, "deprecated": False},
                }
            ),
            200,
        )
    except Exception as exc:
        current_app.logger.error("Error getting eligible users for purge: %s", exc, exc_info=True)
        return (
            jsonify(
                {
                    "error": {"message": f"Failed to get eligible users: {str(exc)}", "type": "ServerError"},
                    "meta": {"request_id": request_id, "deprecated": False},
                }
            ),
            500,
        )


class PurgeCriteria(BaseModel):
    inactive_days: Optional[int] = None
    exclude_sharers: Optional[bool] = None
    exclude_whitelisted: Optional[bool] = None
    ignore_creation_date: Optional[bool] = False


class PurgeBody(BaseModel):
    user_uuids: List[str]
    criteria: Optional[PurgeCriteria] = None


class PurgeResultItem(BaseModel):
    user_uuid: str
    username: str
    success: bool
    message: str


class PurgeResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/users/purge",
    tags=[users_tag],
    summary="Purge selected users",
    responses={200: PurgeResponse, 400: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def purge_users(current_user):
    """Purge selected users."""
    request_id = uuid4().hex
    try:
        data = request.get_json(silent=True) or {}
        if not data:
            return (
                jsonify(
                    {
                        "error": {"message": "Request body is required", "type": "ValidationError"},
                        "meta": {"request_id": request_id, "deprecated": False},
                    }
                ),
                400,
            )

        user_uuids = data.get("user_uuids", [])
        if not user_uuids:
            return (
                jsonify(
                    {
                        "error": {
                            "message": "user_uuids is required and must not be empty",
                            "type": "ValidationError",
                        },
                        "meta": {"request_id": request_id, "deprecated": False},
                    }
                ),
                400,
            )

        criteria = data.get("criteria", {}) or {}
        inactive_days = criteria.get("inactive_days")
        exclude_sharers = criteria.get("exclude_sharers")
        exclude_whitelisted = criteria.get("exclude_whitelisted")
        ignore_creation_date = criteria.get("ignore_creation_date", False)

        current_app.logger.info(
            "Purging %s users with criteria: inactive_days=%s, exclude_sharers=%s, exclude_whitelisted=%s",
            len(user_uuids),
            inactive_days,
            exclude_sharers,
            exclude_whitelisted,
        )

        # Convert UUIDs to internal IDs for the service
        user_ids_to_purge: List[int] = []
        uuid_to_user_map: dict[int, dict] = {}
        from app.utils.helpers import get_user_by_uuid

        for user_uuid in user_uuids:
            user_obj, user_type = get_user_by_uuid(user_uuid)
            if user_obj:
                user_ids_to_purge.append(user_obj.id)
                uuid_to_user_map[user_obj.id] = {
                    "uuid": user_uuid,
                    "username": user_obj.external_username if user_type == "user_media_access" else user_obj.localUsername,
                    "user_type": user_type,
                }
            else:
                current_app.logger.warning("User not found for UUID: %s", user_uuid)

        if not user_ids_to_purge:
            return (
                jsonify(
                    {
                        "error": {
                            "message": "No valid users found for the provided UUIDs",
                            "type": "ValidationError",
                        },
                        "meta": {"request_id": request_id, "deprecated": False},
                    }
                ),
                400,
            )

        # Perform the purge
        results = user_service.purge_inactive_users(
            user_ids_to_purge=user_ids_to_purge,
            admin_id=current_user.id,
            inactive_days_threshold=inactive_days,
            exclude_sharers=exclude_sharers,
            exclude_whitelisted=exclude_whitelisted,
            ignore_creation_date_for_never_streamed=ignore_creation_date,
        )

        detailed_results: List[dict] = []
        for uid in user_ids_to_purge:
            info = uuid_to_user_map.get(uid, {})
            detailed_results.append(
                {
                    "user_uuid": info.get("uuid", "unknown"),
                    "username": info.get("username", "Unknown"),
                    "success": True,
                    "message": "User purged successfully",
                }
            )


        return (
            jsonify(
                {
                    "data": {
                        "deleted": results.get("deleted", 0),
                        "failed": results.get("errors", 0),
                        "results": detailed_results,
                        "message": results.get("message", "Purge completed"),
                    },
                    "meta": {"request_id": request_id, "deprecated": False},
                }
            ),
            200,
        )

    except Exception as exc:
        current_app.logger.error("Error purging users: %s", exc, exc_info=True)
        return (
            jsonify(
                {
                    "error": {"message": f"Failed to purge users: {str(exc)}", "type": "ServerError"},
                    "meta": {"request_id": request_id, "deprecated": False},
                }
            ),
            500,
        )