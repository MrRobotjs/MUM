from __future__ import annotations

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory


servers_tag = Tag(name="Servers", description="Media server management")


class ServerLibPath(BaseModel):
    server_id: int


class LibraryBrief(BaseModel):
    id: str | None = None
    external_id: str | None = None
    internal_id: str | None = None
    name: str | None = None
    type: str | None = Field(default=None, description="Library type")
    item_count: int | None = None


class ServerLibrariesResponse(BaseModel):
    success: bool
    libraries: list[LibraryBrief]
    service_type: str
    server_name: str
    source: str

class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


@api_v2.get(
    "/servers/<server_id>/libraries",
    tags=[servers_tag],
    summary="List libraries for a server (from DB)",
    responses={200: ServerLibrariesResponse, 404: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
def v2_get_server_libraries(path: ServerLibPath, current_user):
    from flask import current_app
    from app.models_media_services import MediaLibrary

    current_app.logger.info(f"API v2: get_server_libraries server_id={path.server_id}")
    server = MediaServiceManager.get_server_by_id(path.server_id)
    if not server:
        all_servers = MediaServiceManager.get_all_servers()
        available_ids = [s.id for s in all_servers]
        current_app.logger.error(
            f"API v2: Server {path.server_id} not found. Available server IDs: {available_ids}"
        )
        return (
            jsonify({
                "error": {
                    "code": "SERVER_NOT_FOUND",
                    "message": f"Server {path.server_id} not found",
                    "details": {"available_server_ids": available_ids},
                }
            }),
            404,
        )

    try:
        db_libraries = MediaLibrary.query.filter_by(server_id=path.server_id).all()
        libraries: list[dict] = []
        for lib in db_libraries:
            lib_data = {
                "id": lib.external_id,
                "external_id": lib.external_id,
                "name": lib.name,
                "type": getattr(lib, "library_type", None) or "unknown",
                "item_count": getattr(lib, "item_count", 0) or 0,
            }
            # Include internal_id for Kavita servers
            if server.service_type.value == "kavita" and getattr(lib, "internal_id", None):
                lib_data["internal_id"] = lib.internal_id
            libraries.append(lib_data)

        return (
            jsonify({
                "success": True,
                "libraries": libraries,
                "service_type": server.service_type.name.upper(),
                "server_name": server.server_nickname,
                "source": "database",
            }),
            200,
        )
    except Exception as e:
        current_app.logger.error(
            f"API v2: Error getting libraries from database for server {path.server_id}: {e}"
        )
        return jsonify({
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Failed to load server libraries",
                "details": {"error": str(e)},
            }
        }), 500


class ServerLibrariesRefreshResponse(ServerLibrariesResponse):
    pass


@api_v2.post(
    "/servers/<server_id>/libraries/refresh",
    tags=[servers_tag],
    summary="Refresh libraries for a server (live API)",
    responses={200: ServerLibrariesRefreshResponse, 404: ErrorResponse, 503: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
def v2_refresh_server_libraries(path: ServerLibPath, current_user):
    from flask import current_app
    from app.models_media_services import MediaLibrary

    server = MediaServiceManager.get_server_by_id(path.server_id)
    if not server:
        return jsonify({
            "error": {"code": "SERVER_NOT_FOUND", "message": "Server not found"}
        }), 404

    service = MediaServiceFactory.create_service_from_db(server)
    if not service:
        return jsonify({
            "error": {"code": "SERVICE_UNAVAILABLE", "message": "Service not available"}
        }), 503

    try:
        libraries = service.get_libraries() or []

        # Ensure both 'id' and 'external_id' keys
        for lib in libraries:
            if "external_id" in lib and "id" not in lib:
                lib["id"] = lib["external_id"]

        # Kavita: include internal_id from DB when available
        if server.service_type.value == "kavita":
            db_libraries = MediaLibrary.query.filter_by(server_id=path.server_id).all()
            db_lib_map = {lib.external_id: lib.internal_id for lib in db_libraries if getattr(lib, "internal_id", None)}
            for lib in libraries:
                external_id = lib.get("external_id") or lib.get("id")
                if external_id and external_id in db_lib_map:
                    lib["internal_id"] = db_lib_map[external_id]

        current_app.logger.info(
            f"API v2: Refreshed {len(libraries)} libraries for server {server.server_nickname}"
        )
        return (
            jsonify({
                "success": True,
                "libraries": libraries,
                "service_type": server.service_type.name.upper(),
                "server_name": server.server_nickname,
                "source": "live_api",
            }),
            200,
        )
    except Exception as e:
        current_app.logger.error(
            f"API v2: Error refreshing libraries from API for server {path.server_id}: {e}"
        )
        return jsonify({
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Failed to refresh server libraries",
                "details": {"error": str(e)},
            }
        }), 500
