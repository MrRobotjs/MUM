from __future__ import annotations

from uuid import uuid4
from flask import jsonify, current_app
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import log_event


settings_tag = Tag(name="Settings", description="Application settings")


class DebugLoggingSettingsData(BaseModel):
    plex_http_log_enabled: bool
    plex_ws_log_enabled: bool
    jellyfin_ws_log_enabled: bool
    emby_ws_log_enabled: bool
    audiobookshelf_http_log_enabled: bool


class DebugLoggingSettingsResponse(BaseModel):
    data: DebugLoggingSettingsData
    meta: dict


def _serialize_debug_logging_settings() -> dict:
    return {
        "plex_http_log_enabled": Setting.get_bool("PLEX_HTTP_LOG_ENABLED", False),
        "plex_ws_log_enabled": Setting.get_bool("PLEX_WS_LOG_ENABLED", False),
        "jellyfin_ws_log_enabled": Setting.get_bool("JELLYFIN_WS_LOG_ENABLED", False),
        "emby_ws_log_enabled": Setting.get_bool("EMBY_WS_LOG_ENABLED", False),
        "audiobookshelf_http_log_enabled": Setting.get_bool("AUDIOBOOKSHELF_HTTP_LOG_ENABLED", False),
    }


@api_v2.get(
    "/settings/debug-logging",
    tags=[settings_tag],
    summary="Get debug logging settings",
    responses={200: DebugLoggingSettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required("administrator")
def get_debug_logging_settings(current_user):
    request_id = uuid4().hex
    return jsonify({"data": _serialize_debug_logging_settings(), "meta": {"request_id": request_id}})


class UpdateDebugLoggingBody(BaseModel):
    plex_http_log_enabled: bool
    plex_ws_log_enabled: bool
    jellyfin_ws_log_enabled: bool
    emby_ws_log_enabled: bool
    audiobookshelf_http_log_enabled: bool


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.patch(
    "/settings/debug-logging",
    tags=[settings_tag],
    summary="Update debug logging settings",
    responses={200: DebugLoggingSettingsResponse, 400: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("administrator")
def update_debug_logging_settings(body: UpdateDebugLoggingBody, current_user):
    request_id = uuid4().hex

    Setting.set(
        "PLEX_HTTP_LOG_ENABLED",
        bool(body.plex_http_log_enabled),
        SettingValueType.BOOLEAN,
        "Plex HTTP debug logging enabled",
    )
    Setting.set(
        "PLEX_WS_LOG_ENABLED",
        bool(body.plex_ws_log_enabled),
        SettingValueType.BOOLEAN,
        "Plex WebSocket debug logging enabled",
    )
    Setting.set(
        "JELLYFIN_WS_LOG_ENABLED",
        bool(body.jellyfin_ws_log_enabled),
        SettingValueType.BOOLEAN,
        "Jellyfin WebSocket debug logging enabled",
    )
    Setting.set(
        "EMBY_WS_LOG_ENABLED",
        bool(body.emby_ws_log_enabled),
        SettingValueType.BOOLEAN,
        "Emby WebSocket debug logging enabled",
    )
    Setting.set(
        "AUDIOBOOKSHELF_HTTP_LOG_ENABLED",
        bool(body.audiobookshelf_http_log_enabled),
        SettingValueType.BOOLEAN,
        "AudiobookShelf HTTP debug logging enabled",
    )

    current_app.config["PLEX_HTTP_LOG_ENABLED"] = bool(body.plex_http_log_enabled)
    current_app.config["PLEX_WS_LOG_ENABLED"] = bool(body.plex_ws_log_enabled)
    current_app.config["JELLYFIN_WS_LOG_ENABLED"] = bool(body.jellyfin_ws_log_enabled)
    current_app.config["EMBY_WS_LOG_ENABLED"] = bool(body.emby_ws_log_enabled)
    current_app.config["AUDIOBOOKSHELF_HTTP_LOG_ENABLED"] = bool(body.audiobookshelf_http_log_enabled)

    log_event(EventType.SETTING_CHANGE, "Debug logging settings updated via API.", admin_id=current_user.id)
    return jsonify({"data": _serialize_debug_logging_settings(), "meta": {"request_id": request_id}}), 200
