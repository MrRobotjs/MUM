from __future__ import annotations

from datetime import datetime
from typing import Optional

from flask import jsonify, current_app, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field, ConfigDict

from app.extensions import db
from app.routes.api.v2 import api_v2
from flask_openapi3 import Tag

from app.models_media_services import MediaServer, ServiceType
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.models import Notification, NotificationType
from app.utils.timezone_utils import utcnow
from app.routes.api.v2.sync_status import get_sync_status, start_sync, update_sync_progress, end_sync


servers_tag = Tag(name="Servers", description="Media server management")


class ServerItem(BaseModel):
    id: int
    server_nickname: Optional[str] = None
    server_name: Optional[str] = None
    service_type: str
    url: Optional[str] = None
    public_url: Optional[str] = None
    jellyfin_owner_user_id: Optional[str] = None
    is_active: Optional[bool] = None
    overseerr_enabled: Optional[bool] = None
    overseerr_url: Optional[str] = None
    last_status: Optional[bool] = None
    last_sync_at: Optional[str] = None
    plugin_enabled: Optional[bool] = None
    effective_active: Optional[bool] = None
    websocket_refresh_interval: Optional[int] = None
    status: Optional[dict] = None


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
    jellyfin_owner_user_id: Optional[str] = None
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
    jellyfin_owner_user_id: Optional[str] = None
    is_active: Optional[bool] = None
    overseerr_enabled: Optional[bool] = None
    overseerr_url: Optional[str] = None
    overseerr_api_key: Optional[str] = None


def _to_item(
    server: MediaServer,
    enabled_types: Optional[set[ServiceType]] = None,
    include_status: bool = False,
) -> dict:
    config = getattr(server, "config", {}) or {}
    plugin_enabled = (
        server.service_type in enabled_types
        if enabled_types is not None
        else MediaServiceManager.is_plugin_enabled(server.service_type)
    )
    effective_active = bool(getattr(server, "is_active", False) and plugin_enabled)
    websocket_refresh_interval = None
    if server.service_type == ServiceType.PLEX:
        try:
            websocket_refresh_interval = int(config.get("websocket_refresh_interval", 30))
        except (TypeError, ValueError):
            websocket_refresh_interval = 30

    return {
        "id": server.id,
        "server_nickname": getattr(server, "server_nickname", None) or getattr(server, "name", None),
        "server_name": getattr(server, "server_name", None),
        "service_type": (server.service_type.value if hasattr(server.service_type, "value") else str(server.service_type)),
        "url": getattr(server, "url", None),
        "public_url": getattr(server, "public_url", None),
        "jellyfin_owner_user_id": config.get("jellyfin_owner_user_id"),
        "is_active": bool(getattr(server, "is_active", True)),
        "overseerr_enabled": bool(getattr(server, "overseerr_enabled", False)),
        "overseerr_url": getattr(server, "overseerr_url", None),
        "last_status": getattr(server, "last_status", None),
        "last_sync_at": getattr(server, "last_status_check", None).isoformat() + "Z"
        if getattr(server, "last_status_check", None)
        else None,
        "plugin_enabled": plugin_enabled,
        "effective_active": effective_active,
        "websocket_refresh_interval": websocket_refresh_interval,
    }


@api_v2.get(
    "/servers",
    tags=[servers_tag],
    summary="List servers",
    responses={200: ServerListResponse},
)
@jwt_required_with_user()
def list_servers(current_user):
    include_status = request.args.get("include_status", "false").lower() == "true"
    active_only_param = request.args.get("active_only")
    if active_only_param is None:
        active_only = False
    else:
        active_only = active_only_param.lower() != "false"
    service_type_param = request.args.get("service_type")

    enabled_types = set(MediaServiceManager.get_enabled_service_types())

    servers_query = MediaServer.query
    if active_only:
        if not enabled_types:
            return jsonify({"data": []}), 200
        servers_query = servers_query.filter(
            MediaServer.is_active.is_(True),
            MediaServer.service_type.in_(enabled_types),
        )

    if service_type_param:
        try:
            service_type_enum = ServiceType(service_type_param.lower())
            servers_query = servers_query.filter(MediaServer.service_type == service_type_enum)
        except ValueError:
            servers_query = servers_query.filter(False)

    servers = servers_query.all()
    items = []
    for server in servers:
        item = _to_item(server, enabled_types=enabled_types, include_status=include_status)
        if include_status:
            if item["effective_active"]:
                status = {}
                try:
                    service = MediaServiceFactory.create_service_from_db(server)
                    if service:
                        status = service.get_server_info() or {}
                except Exception as exc:
                    status = {"online": False, "error": str(exc)}
                item["status"] = status
            else:
                item["status"] = {
                    "online": False,
                    "error": "Plugin disabled"
                    if not item["plugin_enabled"]
                    else "Server inactive",
                }
        items.append(item)

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

    st_value = st.value if hasattr(st, "value") else str(st)
    config: dict = {}
    if st_value == ServiceType.JELLYFIN.value and body.jellyfin_owner_user_id:
        owner_id = body.jellyfin_owner_user_id.strip()
        if owner_id:
            config["jellyfin_owner_user_id"] = owner_id

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
        config=config,
        is_active=True if body.is_active is None else body.is_active,
    )

    db.session.add(server)
    db.session.commit()

    # Auto-enable the plugin when a server is added
    try:
        from app.models_plugins import Plugin, PluginStatus
        service_type_str = body.service_type if isinstance(body.service_type, str) else body.service_type.value
        plugin = Plugin.query.filter_by(plugin_id=service_type_str).first()
        if plugin:
            plugin.enabled_by_user = True
            if plugin.status != PluginStatus.ENABLED:
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

    try:
        from app.services.websocket_monitor_manager import get_websocket_monitor_manager

        ws_manager = get_websocket_monitor_manager(current_app._get_current_object())
        ws_manager.reconcile_server(server.id)
    except Exception as exc:
        current_app.logger.warning("Failed to reconcile websocket listeners for new server: %s", exc)

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
    include_status = request.args.get("include_status", "false").lower() == "true"
    enabled_types = set(MediaServiceManager.get_enabled_service_types())
    item = _to_item(server, enabled_types=enabled_types, include_status=include_status)
    if include_status:
        if item["effective_active"]:
            status = {}
            try:
                service = MediaServiceFactory.create_service_from_db(server)
                if service:
                    status = service.get_server_info() or {}
            except Exception as exc:
                status = {"online": False, "error": str(exc)}
            item["status"] = status
        else:
            item["status"] = {
                "online": False,
                "error": "Plugin disabled"
                if not item["plugin_enabled"]
                else "Server inactive",
            }
    return jsonify(item), 200


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
    jellyfin_owner_user_id = data.pop("jellyfin_owner_user_id", None)

    # Map and set fields if present
    for k, v in data.items():
        setattr(server, k, v)

    if jellyfin_owner_user_id is not None:
        config = dict(getattr(server, "config", {}) or {})
        owner_id = jellyfin_owner_user_id.strip()
        if owner_id:
            config["jellyfin_owner_user_id"] = owner_id
        else:
            config.pop("jellyfin_owner_user_id", None)
        server.config = config

    db.session.add(server)
    db.session.commit()
    try:
        from app.services.websocket_monitor_manager import get_websocket_monitor_manager

        ws_manager = get_websocket_monitor_manager(current_app._get_current_object())
        ws_manager.reconcile_server(server.id)
    except Exception as exc:
        current_app.logger.warning("Failed to reconcile websocket listeners for updated server: %s", exc)
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

    server_id = server.id
    service_type = server.service_type
    item = _to_item(server)
    try:
        from app.models import User, UserType, InviteServerFeature, invite_servers, Notification
        from app.models_media_services import MediaLibrary, MediaItem, MediaStreamHistory
        from app.models_overseerr import OverseerrUserLink

        MediaStreamHistory.query.filter_by(server_id=server_id).delete(synchronize_session=False)
        Notification.query.filter_by(server_id=server_id).delete(synchronize_session=False)
        InviteServerFeature.query.filter_by(server_id=server_id).delete(synchronize_session=False)
        db.session.execute(invite_servers.delete().where(invite_servers.c.server_id == server_id))
        OverseerrUserLink.query.filter_by(server_id=server_id).delete(synchronize_session=False)
        User.query.filter_by(userType=UserType.SERVICE, server_id=server_id).delete(synchronize_session=False)
        MediaItem.query.filter_by(server_id=server_id).delete(synchronize_session=False)
        MediaLibrary.query.filter_by(server_id=server_id).delete(synchronize_session=False)
    except Exception as exc:
        current_app.logger.warning("Failed to cleanup related server data before delete: %s", exc)

    db.session.delete(server)
    db.session.commit()
    try:
        from app.services.websocket_monitor_manager import get_websocket_monitor_manager

        ws_manager = get_websocket_monitor_manager(current_app._get_current_object())
        ws_manager.stop_for_server(service_type, server_id)
    except Exception as exc:
        current_app.logger.warning("Failed to stop websocket listeners for deleted server: %s", exc)
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
    responses={200: SimpleResult, 404: ErrorResponse, 409: ErrorResponse},
)
@jwt_required_with_user()
def sync_server_users(path: ServerPathOp, current_user):
    server = MediaServer.query.get(path.server_id)
    if not server:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Server not found"}}), 404

    current_status = get_sync_status()
    if current_status.get("is_syncing"):
        return (
            jsonify(
                {
                    "error": {
                        "code": "SYNC_IN_PROGRESS",
                        "message": (
                            f"User sync is already in progress (started by "
                            f"{current_status.get('started_by_username')} at {current_status.get('started_at')})"
                        ),
                    }
                }
            ),
            409,
        )

    requester = (
        getattr(current_user, "username", None)
        or getattr(current_user, "localUsername", None)
        or getattr(current_user, "email", None)
        or "unknown"
    )
    current_app.logger.info(
        "Single-server user sync requested by %s for server %s (%s) [server_id=%s]",
        requester,
        server.server_nickname,
        server.service_type.value if hasattr(server.service_type, "value") else str(server.service_type),
        path.server_id,
    )

    start_sync(1, current_user)
    try:
        update_sync_progress(1, 1, server.server_nickname)
        result = MediaServiceManager.sync_server_users(path.server_id)
    finally:
        end_sync()

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
