from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4
from typing import List, Optional

from flask import jsonify, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.extensions import db
from app.models import User, UserType, EventType, InviteUsage
from app.models_media_services import MediaLibrary, MediaServer
from app.services.media_service_factory import MediaServiceFactory
from app.utils.helpers import log_event
# JWT permission checking handled by jwt_permission_required, log_event


users_tag = Tag(name="Users", description="User management endpoints")


class BulkOperation(BaseModel):
    action: str
    value: Optional[bool] = None
    library_ids: Optional[List[str]] = None
    days: Optional[int] = None
    expires_at: Optional[str] = None


class BulkBody(BaseModel):
    user_uuids: List[str] = Field(..., description="List of user UUIDs")
    operations: List[BulkOperation] = Field(..., description="List of operations to apply in order")


class BulkSummary(BaseModel):
    updated: int
    deleted: int
    skipped: int
    errors: int


class BulkResultItem(BaseModel):
    user_uuid: str
    username: Optional[str] = None
    action: str
    status: str
    message: Optional[str] = None


class BulkResponse(BaseModel):
    data: dict
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict | None = None


def _status_entry(user: User, action: str, status: str, message: str | None = None):
    entry = {
        "user_uuid": user.uuid,
        "username": user.localUsername or getattr(user, "external_username", None),
        "action": action,
        "status": status,
    }
    if message:
        entry["message"] = message
    return entry


@api_v2.post(
    "/users/bulk",
    tags=[users_tag],
    summary="Perform bulk operations on users",
    responses={200: BulkResponse, 400: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def bulk_user_operations(body: BulkBody, current_user):
    request_id = uuid4().hex
    user_uuids = body.user_uuids
    operations = body.operations
    users = User.query.filter(User.uuid.in_(user_uuids)).all()
    if not users:
        return jsonify({"error": {"code": "USERS_NOT_FOUND", "message": "No matching users were found."}, "meta": {"request_id": request_id}}), 404

    results = []
    stats = {"updated": 0, "deleted": 0, "skipped": 0, "errors": 0}
    actions_executed = [op.action for op in operations]

    for user in users:
        deleted = False
        for operation in operations:
            if deleted:
                stats["skipped"] += 1
                results.append(_status_entry(user, operation.action or "unknown", "skipped", "User already deleted in this batch."))
                continue

            action = operation.action
            if not action:
                stats["errors"] += 1
                results.append(_status_entry(user, "unknown", "error", 'Operation missing "action".'))
                continue

            try:
                if action == "set_is_active":
                    value = bool(operation.value if operation.value is not None else True)
                    if user.userType == UserType.OWNER and not value:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "Owner account cannot be deactivated."))
                        continue
                    if user.is_active == value:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "No change required."))
                        continue
                    user.is_active = value
                    stats["updated"] += 1
                    results.append(_status_entry(user, action, "updated"))

                elif action == "update_libraries":
                    if user.userType != UserType.SERVICE:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "Libraries can only be set for service accounts."))
                        continue

                    # Support either explicit final list (library_ids) or deltas (libraries_to_add / libraries_to_remove)
                    library_ids = getattr(operation, "library_ids", None)
                    libs_to_add = getattr(operation, "libraries_to_add", None)
                    libs_to_remove = getattr(operation, "libraries_to_remove", None)
                    if library_ids is not None:
                        if not isinstance(library_ids, list):
                            raise ValueError("library_ids must be a list.")
                        user.allowed_library_ids = library_ids
                    else:
                        # Compute final set from deltas against current setting
                        current = set(user.allowed_library_ids or [])
                        if isinstance(libs_to_add, list):
                            for lid in libs_to_add:
                                current.add(lid)
                        if isinstance(libs_to_remove, list):
                            for lid in libs_to_remove:
                                try:
                                    current.remove(lid)
                                except KeyError:
                                    pass
                        user.allowed_library_ids = list(current)

                    if user.server_id:
                        server = MediaServer.query.get(user.server_id)
                        service = MediaServiceFactory.create_service_from_db(server) if server else None
                        if service and hasattr(service, "update_user_access") and user.external_user_id:
                            allowed_ids = user.allowed_library_ids or []
                            server_libraries = MediaLibrary.query.filter_by(server_id=user.server_id).all()
                            library_by_identifier = {}
                            for lib in server_libraries:
                                if lib.external_id:
                                    library_by_identifier[str(lib.external_id)] = lib
                                if lib.internal_id:
                                    library_by_identifier[str(lib.internal_id)] = lib

                            if allowed_ids:
                                api_library_ids = [
                                    library_by_identifier.get(str(lib_id), None).external_id
                                    if library_by_identifier.get(str(lib_id), None)
                                    else str(lib_id)
                                    for lib_id in allowed_ids
                                ]
                            else:
                                api_library_ids = [lib.external_id for lib in server_libraries if lib.external_id]
                            try:
                                service.update_user_access(user.external_user_id, api_library_ids)
                            except Exception as exc:
                                current_app.logger.error(
                                    f"Bulk update: Failed to sync libraries to {server.server_nickname if server else 'server'} "
                                    f"for user {user.uuid}: {exc}",
                                    exc_info=True,
                                )

                    stats["updated"] += 1
                    results.append(_status_entry(user, action, "updated"))

                elif action == "extend_access":
                    days = operation.days
                    if not isinstance(days, int) or days <= 0:
                        raise ValueError("days must be a positive integer.")
                    base = user.access_expires_at or datetime.utcnow()
                    user.access_expires_at = base + timedelta(days=days)
                    stats["updated"] += 1
                    results.append(_status_entry(user, action, "updated"))

                elif action == "set_expiration":
                    expires_at = operation.expires_at
                    if not expires_at:
                        raise ValueError("expires_at is required for set_expiration.")
                    try:
                        dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                    except Exception:
                        raise ValueError("expires_at must be ISO-8601 date string.")
                    user.access_expires_at = dt
                    stats["updated"] += 1
                    results.append(_status_entry(user, action, "updated"))

                elif action == "clear_expiration":
                    user.access_expires_at = None
                    stats["updated"] += 1
                    results.append(_status_entry(user, action, "updated"))

                elif action == "add_to_purge_whitelist":
                    if not user.is_purge_whitelisted:
                        user.is_purge_whitelisted = True
                        stats["updated"] += 1
                        results.append(_status_entry(user, action, "updated"))
                    else:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "User already purged whitelist."))

                elif action == "remove_from_purge_whitelist":
                    if user.is_purge_whitelisted:
                        user.is_purge_whitelisted = False
                        stats["updated"] += 1
                        results.append(_status_entry(user, action, "updated"))
                    else:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "User not in purge whitelist."))

                elif action == "add_to_bot_whitelist":
                    if not user.is_discord_bot_whitelisted:
                        user.is_discord_bot_whitelisted = True
                        stats["updated"] += 1
                        results.append(_status_entry(user, action, "updated"))
                    else:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "User already in bot whitelist."))

                elif action == "remove_from_bot_whitelist":
                    if user.is_discord_bot_whitelisted:
                        user.is_discord_bot_whitelisted = False
                        stats["updated"] += 1
                        results.append(_status_entry(user, action, "updated"))
                    else:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "User not in bot whitelist."))

                elif action == "allow_downloads":
                    value = bool(operation.value if operation.value is not None else True)
                    if user.userType != UserType.SERVICE:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "Downloads flag applies to service users only."))
                        continue
                    if user.allow_downloads == value:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "No change required."))
                        continue
                    user.allow_downloads = value
                    user.sync_downloads_role(value)
                    stats["updated"] += 1
                    results.append(_status_entry(user, action, "updated"))

                elif action == "unlink_local":
                    if user.userType != UserType.SERVICE:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "Only service users can be unlinked from local accounts."))
                        continue
                    if not user.linkedUserId:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "Service user is not linked to a local account."))
                        continue
                    user.linkedUserId = None
                    stats["updated"] += 1
                    results.append(_status_entry(user, action, "updated"))

                elif action == "delete_users":
                    if user.userType == UserType.OWNER:
                        stats["skipped"] += 1
                        results.append(_status_entry(user, action, "skipped", "Owner account cannot be deleted."))
                        continue

                    if user.userType == UserType.SERVICE and user.server_id and user.external_user_id:
                        server = MediaServer.query.get(user.server_id)
                        service = MediaServiceFactory.create_service_from_db(server) if server else None
                        if service and hasattr(service, "delete_user"):
                            try:
                                service.delete_user(str(user.external_user_id))
                            except Exception as exc:
                                current_app.logger.error(
                                    "Bulk delete: failed to delete external service user %s on server %s: %s",
                                    user.uuid,
                                    server.server_nickname if server else user.server_id,
                                    exc,
                                    exc_info=True,
                                )
                        else:
                            current_app.logger.warning(
                                "Bulk delete: service delete not available for user %s on server %s",
                                user.uuid,
                                server.server_nickname if server else user.server_id,
                            )

                    if user.userType == UserType.LOCAL:
                        for child in getattr(user, "linked_children", []) or []:
                            child.linkedUserId = None

                    # Preserve invite usage history while allowing user deletion.
                    # invite_usages.userId references users.uuid and must be nulled first.
                    InviteUsage.query.filter_by(userId=user.uuid).update(
                        {"userId": None},
                        synchronize_session=False,
                    )

                    db.session.delete(user)
                    deleted = True
                    stats["deleted"] += 1
                    results.append(_status_entry(user, action, "deleted"))

                else:
                    stats["skipped"] += 1
                    results.append(_status_entry(user, action, "skipped", "Unsupported action."))

            except Exception as exc:
                current_app.logger.error(f"Bulk user action '{action}' failed for {user.uuid}: {exc}", exc_info=True)
                stats["errors"] += 1
                results.append(_status_entry(user, action, "error", str(exc)))

    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to commit bulk user operations: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({"error": {"code": "BULK_UPDATE_FAILED", "message": "Database error while applying bulk operations."}, "meta": {"request_id": request_id}}), 500

    log_event(
        EventType.SETTING_CHANGE,
        f"Bulk user operations executed ({', '.join(actions_executed)}). Updated: {stats['updated']}, Deleted: {stats['deleted']}, Skipped: {stats['skipped']}, Errors: {stats['errors']}.",
        admin_id=getattr(current_user, "id", None),
    )

    return (
        jsonify({
            "data": {"summary": stats, "results": results},
            "meta": {"request_id": request_id, "deprecated": False},
        }),
        200,
    )
