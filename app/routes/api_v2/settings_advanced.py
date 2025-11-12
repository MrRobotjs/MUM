from __future__ import annotations

from uuid import uuid4
from flask import jsonify, request, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import log_event


settings_tag = Tag(name="Settings", description="Application settings")


class AdvancedSettingsData(BaseModel):
    session_lifetime: int
    max_login_attempts: int


class AdvancedSettingsResponse(BaseModel):
    data: AdvancedSettingsData
    meta: dict


def _serialize_advanced_settings() -> dict:
    session_lifetime = int(Setting.get('SESSION_LIFETIME_SECONDS', 86400) or 86400)
    max_login_attempts = int(Setting.get('MAX_LOGIN_ATTEMPTS', 5) or 5)
    return {
        "session_lifetime": session_lifetime,
        "max_login_attempts": max_login_attempts,
    }


@api_v2.get(
    "/settings/advanced",
    tags=[settings_tag],
    summary="Get advanced settings",
    responses={200: AdvancedSettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_advanced_settings(current_user):
    request_id = uuid4().hex
    return jsonify({"data": _serialize_advanced_settings(), "meta": {"request_id": request_id}})


class UpdateAdvancedBody(BaseModel):
    session_lifetime: int = Field(..., ge=3600, le=2592000, description="3600-2592000 seconds")
    max_login_attempts: int = Field(..., ge=3, le=20)


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.patch(
    "/settings/advanced",
    tags=[settings_tag],
    summary="Update advanced settings",
    responses={200: AdvancedSettingsResponse, 400: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def update_advanced_settings(body: UpdateAdvancedBody, current_user):
    request_id = uuid4().hex
    # Persist settings
    Setting.set('SESSION_LIFETIME_SECONDS', int(body.session_lifetime), SettingValueType.INTEGER, "Session Lifetime (seconds)")
    Setting.set('MAX_LOGIN_ATTEMPTS', int(body.max_login_attempts), SettingValueType.INTEGER, "Max Login Attempts")
    # Apply to app config if relevant
    current_app.config['SESSION_LIFETIME_SECONDS'] = int(body.session_lifetime)
    current_app.config['MAX_LOGIN_ATTEMPTS'] = int(body.max_login_attempts)

    log_event(EventType.SETTING_CHANGE, "Advanced settings updated via API.", admin_id=current_user.id)
    return jsonify({"data": _serialize_advanced_settings(), "meta": {"request_id": request_id}}), 200
