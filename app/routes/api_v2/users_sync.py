from __future__ import annotations

from uuid import uuid4
from datetime import datetime
from typing import Optional, List

from flask import jsonify, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import User, UserType, EventType
from app.models_media_services import MediaServer
from app.services.media_service_manager import MediaServiceManager
# JWT permission checking handled by jwt_permission_required, log_event

# Reuse sync status helpers from v1 for now
from app.routes.api_v2.sync_status import get_sync_status, start_sync, update_sync_progress, end_sync


users_tag = Tag(name="Users", description="User management endpoints")


class SyncResult(BaseModel):
    server_id: int
    server_name: Optional[str] = None
    service_type: Optional[str] = None
    success: bool
    added: Optional[int] = None
    updated: Optional[int] = None
    removed: Optional[int] = None
    message: Optional[str] = None


class SyncAllResponse(BaseModel):
    data: dict
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict | None = None


@api_v2.post(
    "/users/sync-all",
    tags=[users_tag],
    summary="Sync users from all active servers",
    responses={200: SyncAllResponse, 409: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def sync_all_users(current_user):
    request_id = uuid4().hex

    # Check if sync is already in progress
    current_status = get_sync_status()
    if current_status.get("is_syncing"):
        return (
            jsonify(
                {
                    "error": {
                        "code": "SYNC_IN_PROGRESS",
                        "message": f"User sync is already in progress (started by {current_status.get('started_by_username')} at {current_status.get('started_at')})",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            409,
        )

    servers = MediaServer.query.filter_by(is_active=True).all()
    if not servers:
        return jsonify({"data": {"results": [], "message": "No active media servers found."}, "meta": {"request_id": request_id, "deprecated": False}}), 200

    # Mark sync as started
    start_sync(len(servers), current_user)

    results = []
    total_added = total_updated = total_removed = 0

    try:
        for idx, server in enumerate(servers, 1):
            update_sync_progress(idx, len(servers), server.server_nickname)
            try:
                current_app.logger.info(f"Syncing users for server: {server.server_nickname}")
                sync_result = MediaServiceManager.sync_server_users(server.id)
                success = bool(sync_result.get("success"))
                message = sync_result.get("message", "Sync completed." if success else "Sync failed.")
                added = sync_result.get("added", 0)
                updated = sync_result.get("updated", 0)
                removed = sync_result.get("removed", 0)

                total_added += added
                total_updated += updated
                total_removed += removed

                results.append(
                    {
                        "server_id": server.id,
                        "server_name": server.server_nickname,
                        "service_type": server.service_type.value if hasattr(server.service_type, "value") else str(server.service_type),
                        "success": success,
                        "added": added,
                        "updated": updated,
                        "removed": removed,
                        "message": message,
                    }
                )
            except Exception as exc:
                current_app.logger.error(
                    f"User sync failed for server {server.id} ({server.server_nickname}): {exc}",
                    exc_info=True,
                )
                results.append(
                    {
                        "server_id": server.id,
                        "server_name": server.server_nickname,
                        "service_type": server.service_type.value if hasattr(server.service_type, "value") else str(server.service_type),
                        "success": False,
                        "added": 0,
                        "updated": 0,
                        "removed": 0,
                        "message": str(exc),
                    }
                )
    finally:
        end_sync()

    log_event(
        EventType.SETTING_CHANGE,
        f"Manual sync triggered for all servers. Results: {total_added} added, {total_updated} updated, {total_removed} removed.",
        admin_id=getattr(current_user, "id", None),
    )

    return (
        jsonify(
            {
                "data": {
                    "results": results,
                    "summary": {
                        "total_servers": len(servers),
                        "successful": sum(1 for r in results if r["success"]),
                        "failed": sum(1 for r in results if not r["success"]),
                        "total_added": total_added,
                        "total_updated": total_updated,
                        "total_removed": total_removed,
                    },
                },
                "meta": {"request_id": request_id, "deprecated": False},
            }
        ),
        200,
    )


class UserPath(BaseModel):
    user_uuid: str = Field(..., description="User UUID")


class SyncUserResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/users/<user_uuid>/sync",
    tags=[users_tag],
    summary="Sync a single user's linked service accounts",
    responses={200: SyncUserResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def sync_user_accounts(path: UserPath, current_user):
    request_id = uuid4().hex
    user = User.query.filter_by(uuid=path.user_uuid).first()
    if not user:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id}}), 404

    server_ids = set()
    if user.userType == UserType.SERVICE:
        if user.server_id:
            server_ids.add(user.server_id)
    else:
        for child in getattr(user, "linked_children", []) or []:
            if child.server_id:
                server_ids.add(child.server_id)

    if not server_ids:
        return jsonify({"data": {"results": [], "message": "No associated media servers to sync."}, "meta": {"request_id": request_id, "deprecated": False}}), 200

    results = []
    for sid in server_ids:
        server = MediaServer.query.get(sid)
        if not server:
            results.append({"server_id": sid, "success": False, "message": "Server not found."})
            continue
        try:
            sync_result = MediaServiceManager.sync_server_users(server.id)
            success = bool(sync_result.get("success"))
            message = sync_result.get("message", "Sync completed." if success else "Sync failed.")
            results.append(
                {
                    "server_id": server.id,
                    "server_name": server.server_nickname,
                    "success": success,
                    "added": sync_result.get("added"),
                    "updated": sync_result.get("updated"),
                    "removed": sync_result.get("removed"),
                    "message": message,
                }
            )
        except Exception as exc:
            current_app.logger.error(f"User sync failed for server {sid}: {exc}", exc_info=True)
            results.append({"server_id": server.id if server else sid, "server_name": getattr(server, "server_nickname", None), "success": False, "message": str(exc)})

    log_event(
        EventType.SETTING_CHANGE,
        f"Manual sync triggered for user '{user.localUsername or getattr(user, 'external_username', None)}'.",
        admin_id=getattr(current_user, "id", None),
    )

    return jsonify({"data": {"results": results, "user": {"uuid": user.uuid, "username": user.localUsername or getattr(user, "external_username", None), "user_type": user.userType.value if hasattr(user.userType, "value") else str(user.userType), "service_account_count": len([c for c in getattr(user, 'linked_children', []) or [] if c.userType == UserType.SERVICE])}}, "meta": {"request_id": request_id, "deprecated": False}}), 200
