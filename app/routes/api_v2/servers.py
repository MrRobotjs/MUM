from __future__ import annotations

from datetime import datetime
from typing import Optional

from flask import jsonify, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field, ConfigDict

from app.extensions import db
from app.routes.api_v2 import api_v2
from flask_openapi3 import Tag

from app.models_media_services import MediaServer, ServiceType
from app.services.media_service_manager import MediaServiceManager
from app.models import Notification, NotificationType
from app.utils.timezone_utils import utcnow


servers_tag = Tag(name="Servers", description="Media server management")


class ServerItem(BaseModel):
    id: int
    server_nickname: Optional[str] = None
    server_name: Optional[str] = None
    service_type: str
    url: Optional[str] = None
    public_url: Optional[str] = None
    is_active: Optional[bool] = None
    overseerr_enabled: Optional[bool] = None
    overseerr_url: Optional[str] = None
    last_status: Optional[bool] = None
    last_sync_at: Optional[str] = None


class ServerListData(BaseModel):
    data: list[ServerItem]


class MetaModel(BaseModel):
    request_id: str
    generated_at: Optional[str] = None


class ServerListResponse(BaseModel):
    data: list[ServerItem]


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


class CreateServerBody(BaseModel):
    server_nickname: str = Field(..., description="Unique nickname")
    service_type: str = Field(..., description="Service type (plex, jellyfin, emby, kavita, audiobookshelf, komga, romm)")
    url: str = Field(..., description="Base URL")
    server_name: Optional[str] = None
    api_key: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    public_url: Optional[str] = None
    is_active: Optional[bool] = True
    overseerr_enabled: Optional[bool] = False
    overseerr_url: Optional[str] = None
    overseerr_api_key: Optional[str] = None


class UpdateServerBody(BaseModel):
    server_nickname: Optional[str] = None
    server_name: Optional[str] = None
    url: Optional[str] = None
    api_key: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    public_url: Optional[str] = None
    is_active: Optional[bool] = None
    overseerr_enabled: Optional[bool] = None
    overseerr_url: Optional[str] = None
    overseerr_api_key: Optional[str] = None


def _to_item(server: MediaServer) -> dict:
    return {
        "id": server.id,
        "server_nickname": getattr(server, "server_nickname", None) or getattr(server, "name", None),
        "server_name": getattr(server, "server_name", None),
        "service_type": (server.service_type.value if hasattr(server.service_type, "value") else str(server.service_type)),
        "url": getattr(server, "url", None),
        "public_url": getattr(server, "public_url", None),
        "is_active": bool(getattr(server, "is_active", True)),
        "overseerr_enabled": bool(getattr(server, "overseerr_enabled", False)),
        "overseerr_url": getattr(server, "overseerr_url", None),
        "last_status": getattr(server, "last_status", None),
        "last_sync_at": getattr(server, "last_status_check", None).isoformat() + "Z"
        if getattr(server, "last_status_check", None)
        else None,
    }


@api_v2.get(
    "/servers",
    tags=[servers_tag],
    summary="List servers",
    responses={200: ServerListResponse},
)
@jwt_required_with_user()
def list_servers(current_user):
    servers = MediaServer.query.all()
    items = [_to_item(s) for s in servers]
    return jsonify({"data": items}), 200


@api_v2.post(
    "/servers",
    tags=[servers_tag],
    summary="Create server",
    responses={201: ServerItem, 409: ErrorResponse, 422: ErrorResponse},
)
@jwt_required_with_user()
def create_server(body: CreateServerBody, current_user):
    # Uniqueness on server_nickname
    existing = MediaServer.query.filter_by(server_nickname=body.server_nickname).first()
    if existing:
        return (
            jsonify({"error": {"code": "NICKNAME_EXISTS", "message": "Server nickname already exists"}}),
            409,
        )

    try:
        st = ServiceType(body.service_type) if hasattr(ServiceType, "__call__") else body.service_type
    except Exception:
        st = body.service_type

    server = MediaServer(
        server_nickname=body.server_nickname,
        server_name=body.server_name or body.server_nickname,
        service_type=st,
        url=body.url,
        api_key=body.api_key,
        username=body.username,
        password=body.password,
        public_url=body.public_url,
        overseerr_enabled=bool(body.overseerr_enabled),
        overseerr_url=body.overseerr_url,
        overseerr_api_key=body.overseerr_api_key,
        is_active=True if body.is_active is None else body.is_active,
    )

    db.session.add(server)
    db.session.commit()

    # Auto-enable the plugin when a server is added
    try:
        from app.models_plugins import Plugin, PluginStatus
        service_type_str = body.service_type if isinstance(body.service_type, str) else body.service_type.value
        plugin = Plugin.query.filter_by(plugin_id=service_type_str).first()
        if plugin and plugin.status != PluginStatus.ENABLED:
            plugin.status = PluginStatus.ENABLED
            db.session.add(plugin)
            db.session.commit()
            current_app.logger.info(f"Auto-enabled plugin '{service_type_str}' after adding server '{server.server_nickname}'")
    except Exception as e:
        current_app.logger.warning(f"Failed to auto-enable plugin: {e}")
        # Don't fail the server creation if plugin enable fails

    # Create notification for new unsynced server
    try:
        notification = Notification(
            timestamp=utcnow(),
            notification_type=NotificationType.SERVER_NOT_SYNCED,
            title="New Server Not Synced",
            message=f"Server '{server.server_nickname}' has been added but has not been synced yet. Sync users and libraries to get started.",
            read=False,
            server_id=server.id,
            details={
                "server_nickname": server.server_nickname,
                "service_type": service_type_str
            }
        )
        db.session.add(notification)
        db.session.commit()
        current_app.logger.info(f"Created SERVER_NOT_SYNCED notification for server '{server.server_nickname}'")
    except Exception as e:
        current_app.logger.warning(f"Failed to create notification for new server: {e}")
        # Don't fail the server creation if notification creation fails

    return jsonify(_to_item(server)), 201


class ServerPath(BaseModel):
    server_id: int


@api_v2.get(
    "/servers/<server_id>",
    tags=[servers_tag],
    summary="Get server",
    responses={200: ServerItem, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_server(path: ServerPath, current_user):
    server = MediaServer.query.get(path.server_id)
    if not server:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Server not found"}}), 404
    return jsonify(_to_item(server)), 200


@api_v2.patch(
    "/servers/<server_id>",
    tags=[servers_tag],
    summary="Update server",
    responses={200: ServerItem, 404: ErrorResponse},
)
@jwt_required_with_user()
def update_server(path: ServerPath, body: UpdateServerBody, current_user):
    server = MediaServer.query.get(path.server_id)
    if not server:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Server not found"}}), 404

    data = body.model_dump(exclude_none=True)

    # Map and set fields if present
    for k, v in data.items():
        setattr(server, k, v)

    db.session.add(server)
    db.session.commit()
    return jsonify(_to_item(server)), 200


@api_v2.delete(
    "/servers/<server_id>",
    tags=[servers_tag],
    summary="Delete server",
    responses={200: ServerItem, 404: ErrorResponse},
)
@jwt_required_with_user()
def delete_server(path: ServerPath, current_user):
    server = MediaServer.query.get(path.server_id)
    if not server:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Server not found"}}), 404

    item = _to_item(server)
    db.session.delete(server)
    db.session.commit()
    return jsonify(item), 200


class SimpleResult(BaseModel):
    model_config = ConfigDict(extra='allow')
    success: bool
    message: Optional[str] = None


class ServerPathOp(BaseModel):
    server_id: int


@api_v2.post(
    "/servers/<server_id>/test",
    tags=[servers_tag],
    summary="Test server connection",
    responses={200: SimpleResult, 404: ErrorResponse},
)
@jwt_required_with_user()
def test_server_connection(path: ServerPathOp, current_user):
    server = MediaServer.query.get(path.server_id)
    if not server:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Server not found"}}), 404
    result = MediaServiceManager.test_server_connection(path.server_id)
    return jsonify(result), 200


@api_v2.post(
    "/servers/<server_id>/sync-libraries",
    tags=[servers_tag],
    summary="Sync server libraries",
    responses={200: SimpleResult, 404: ErrorResponse},
)
@jwt_required_with_user()
def sync_server_libraries(path: ServerPathOp, current_user):
    server = MediaServer.query.get(path.server_id)
    if not server:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Server not found"}}), 404
    result = MediaServiceManager.sync_server_libraries(path.server_id)

    # Mark SERVER_NOT_SYNCED notifications as read for this server
    try:
        Notification.query.filter_by(
            server_id=path.server_id,
            notification_type=NotificationType.SERVER_NOT_SYNCED,
            read=False
        ).update({"read": True})
        db.session.commit()
    except Exception as e:
        current_app.logger.warning(f"Failed to mark notifications as read: {e}")

    return jsonify(result), 200


@api_v2.post(
    "/servers/<server_id>/sync-users",
    tags=[servers_tag],
    summary="Sync server users",
    responses={200: SimpleResult, 404: ErrorResponse},
)
@jwt_required_with_user()
def sync_server_users(path: ServerPathOp, current_user):
    server = MediaServer.query.get(path.server_id)
    if not server:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Server not found"}}), 404
    result = MediaServiceManager.sync_server_users(path.server_id)

    # Mark SERVER_NOT_SYNCED notifications as read for this server
    try:
        Notification.query.filter_by(
            server_id=path.server_id,
            notification_type=NotificationType.SERVER_NOT_SYNCED,
            read=False
        ).update({"read": True})
        db.session.commit()
    except Exception as e:
        current_app.logger.warning(f"Failed to mark notifications as read: {e}")

    return jsonify(result), 200
