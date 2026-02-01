from __future__ import annotations

from uuid import uuid4
from datetime import timedelta
from flask import jsonify, request, current_app, g
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field, field_validator
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import Setting, SettingValueType
# JWT permission checking handled by jwt_permission_required, log_event


settings_tag = Tag(name="Settings", description="Application settings")


class GeneralSettingsData(BaseModel):
    app_name: str | None = None
    app_base_url: str | None = None
    app_local_url: str | None = None
    enable_navbar_stream_badge: bool
    session_monitoring_interval: int
    api_timeout_seconds: int
    jwt_cookie_secure: bool
    jwt_access_token_expires_minutes: int
    jwt_refresh_token_expires_days: int


class GeneralSettingsResponse(BaseModel):
    data: GeneralSettingsData
    meta: dict


def _get_jwt_access_minutes() -> int:
    stored = Setting.get("JWT_ACCESS_TOKEN_EXPIRES_MINUTES")
    if stored is not None:
        return int(stored)
    configured = current_app.config.get("JWT_ACCESS_TOKEN_EXPIRES")
    if isinstance(configured, timedelta):
        return max(1, int(configured.total_seconds() // 60))
    if isinstance(configured, (int, float)):
        return max(1, int(configured // 60))
    return 10


def _get_jwt_refresh_days() -> int:
    stored = Setting.get("JWT_REFRESH_TOKEN_EXPIRES_DAYS")
    if stored is not None:
        return int(stored)
    configured = current_app.config.get("JWT_REFRESH_TOKEN_EXPIRES")
    if isinstance(configured, timedelta):
        return max(1, int(configured.total_seconds() // 86400))
    if isinstance(configured, (int, float)):
        return max(1, int(configured // 86400))
    return 14


def _serialize_general_settings() -> dict:
    return {
        "app_name": Setting.get("APP_NAME") or current_app.config.get("APP_NAME"),
        "app_base_url": Setting.get("APP_BASE_URL") or current_app.config.get("APP_BASE_URL"),
        "app_local_url": Setting.get("APP_LOCAL_URL") or current_app.config.get("APP_LOCAL_URL"),
        "enable_navbar_stream_badge": Setting.get_bool("ENABLE_NAVBAR_STREAM_BADGE", False),
        "session_monitoring_interval": Setting.get("SESSION_MONITORING_INTERVAL_SECONDS", 30),
        "api_timeout_seconds": Setting.get("API_TIMEOUT_SECONDS", current_app.config.get("API_TIMEOUT_SECONDS", 3)),
        "jwt_cookie_secure": Setting.get_bool("JWT_COOKIE_SECURE", bool(current_app.config.get("JWT_COOKIE_SECURE", False))),
        "jwt_access_token_expires_minutes": _get_jwt_access_minutes(),
        "jwt_refresh_token_expires_days": _get_jwt_refresh_days(),
    }


@api_v2.get(
    "/settings/general",
    tags=[settings_tag],
    summary="Get general application settings",
    responses={200: GeneralSettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_general_settings(current_user):
    request_id = uuid4().hex
    return jsonify({"data": _serialize_general_settings(), "meta": {"request_id": request_id}})


class UpdateGeneralBody(BaseModel):
    app_name: str | None = None
    app_base_url: str | None = None
    app_local_url: str | None = None
    enable_navbar_stream_badge: bool = Field(default=False)
    session_monitoring_interval: int
    api_timeout_seconds: int
    jwt_cookie_secure: bool = Field(default=False, description="Use Secure cookie flag for refresh tokens (enable on HTTPS)")
    jwt_access_token_expires_minutes: int
    jwt_refresh_token_expires_days: int

    @field_validator("app_base_url")
    @classmethod
    def validate_base_url(cls, v: str | None):
        if v is None:
            return v
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("Application base URL must start with http:// or https://.")
        return v

    @field_validator("app_local_url")
    @classmethod
    def validate_local_url(cls, v: str | None):
        if not v:
            return v
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("Local application URL must start with http:// or https://.")
        return v

    @field_validator("jwt_access_token_expires_minutes")
    @classmethod
    def validate_access_minutes(cls, v: int):
        if v < 1 or v > 1440:
            raise ValueError("Access token expiration must be between 1 and 1440 minutes.")
        return v

    @field_validator("jwt_refresh_token_expires_days")
    @classmethod
    def validate_refresh_days(cls, v: int):
        if v < 1 or v > 365:
            raise ValueError("Refresh token expiration must be between 1 and 365 days.")
        return v


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.patch(
    "/settings/general",
    tags=[settings_tag],
    summary="Update general application settings",
    responses={200: GeneralSettingsResponse, 400: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def update_general_settings(body: UpdateGeneralBody, current_user):
    request_id = uuid4().hex

    app_name = (body.app_name or "").strip()
    app_base_url = (body.app_base_url or "").strip()
    app_local_url = (body.app_local_url or "").strip()
    enable_badge = bool(body.enable_navbar_stream_badge)
    session_interval = body.session_monitoring_interval
    api_timeout = body.api_timeout_seconds
    jwt_cookie_secure = bool(body.jwt_cookie_secure)
    access_minutes = int(body.jwt_access_token_expires_minutes)
    refresh_days = int(body.jwt_refresh_token_expires_days)

    if not app_base_url:
        return jsonify({"error": {"code": "BASE_URL_REQUIRED", "message": "Application base URL is required."}, "meta": {"request_id": request_id}}), 400

    try:
        if session_interval < 10 or session_interval > 300:
            raise ValueError
    except Exception:
        return jsonify({"error": {"code": "INVALID_MONITOR_INTERVAL", "message": "Session monitoring interval must be between 10 and 300 seconds."}, "meta": {"request_id": request_id}}), 400

    try:
        if api_timeout < 1 or api_timeout > 60:
            raise ValueError
    except Exception:
        return jsonify({"error": {"code": "INVALID_API_TIMEOUT", "message": "API timeout must be between 1 and 60 seconds."}, "meta": {"request_id": request_id}}), 400

    Setting.set("APP_NAME", app_name or current_app.config.get("APP_NAME"), SettingValueType.STRING, "Application Name")
    Setting.set("APP_BASE_URL", app_base_url.rstrip("/"), SettingValueType.STRING, "Application Base URL")
    Setting.set("APP_LOCAL_URL", app_local_url.rstrip("/") if app_local_url else "", SettingValueType.STRING, "Application Local URL")
    Setting.set("ENABLE_NAVBAR_STREAM_BADGE", enable_badge, SettingValueType.BOOLEAN, "Enable Nav Bar Stream Badge")
    Setting.set("SESSION_MONITORING_INTERVAL_SECONDS", session_interval, SettingValueType.INTEGER, "Session Monitoring Interval")
    Setting.set("API_TIMEOUT_SECONDS", api_timeout, SettingValueType.INTEGER, "API Request Timeout")
    Setting.set("JWT_COOKIE_SECURE", jwt_cookie_secure, SettingValueType.BOOLEAN, "JWT Refresh Cookie Secure Flag")
    Setting.set("JWT_ACCESS_TOKEN_EXPIRES_MINUTES", access_minutes, SettingValueType.INTEGER, "JWT Access Token Expiration (Minutes)")
    Setting.set("JWT_REFRESH_TOKEN_EXPIRES_DAYS", refresh_days, SettingValueType.INTEGER, "JWT Refresh Token Expiration (Days)")

    current_app.config["APP_NAME"] = app_name or current_app.config.get("APP_NAME")
    current_app.config["APP_BASE_URL"] = app_base_url.rstrip("/")
    current_app.config["APP_LOCAL_URL"] = app_local_url.rstrip("/") if app_local_url else None
    current_app.config["SESSION_MONITORING_INTERVAL_SECONDS"] = session_interval
    current_app.config["API_TIMEOUT_SECONDS"] = api_timeout
    current_app.config["JWT_COOKIE_SECURE"] = jwt_cookie_secure
    current_app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(minutes=access_minutes)
    current_app.config["JWT_REFRESH_TOKEN_EXPIRES"] = timedelta(days=refresh_days)
    if hasattr(g, "app_name"):
        g.app_name = current_app.config["APP_NAME"]
    if hasattr(g, "app_base_url"):
        g.app_base_url = current_app.config["APP_BASE_URL"]
    if hasattr(g, "app_local_url"):
        g.app_local_url = current_app.config["APP_LOCAL_URL"]


    return jsonify({"data": _serialize_general_settings(), "meta": {"request_id": request_id}}), 200