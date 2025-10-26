from __future__ import annotations

from uuid import uuid4
from flask import jsonify, request, current_app
from flask_login import login_required, current_user
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import permission_required, log_event


settings_tag = Tag(name="Settings", description="Application settings")


class AdvancedSettingsData(BaseModel):
    csrf_token_timeout_minutes: int


class AdvancedSettingsResponse(BaseModel):
    data: AdvancedSettingsData
    meta: dict


def _serialize_advanced_settings() -> dict:
    raw_timeout = Setting.get('WTF_CSRF_TIME_LIMIT')
    if raw_timeout is None:
        timeout_minutes = 0
    else:
        timeout_minutes = int(raw_timeout) // 60 if raw_timeout else 0
    return {"csrf_token_timeout_minutes": timeout_minutes}


@api_v2.get(
    "/settings/advanced",
    tags=[settings_tag],
    summary="Get advanced settings",
    responses={200: AdvancedSettingsResponse},
)
@login_required
@permission_required("manage_advanced_settings")
def get_advanced_settings():
    request_id = uuid4().hex
    return jsonify({"data": _serialize_advanced_settings(), "meta": {"request_id": request_id}})


class UpdateAdvancedBody(BaseModel):
    csrf_token_timeout_minutes: int = Field(..., ge=0, le=1440)


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
@login_required
@permission_required("manage_advanced_settings")
def update_advanced_settings(body: UpdateAdvancedBody):
    request_id = uuid4().hex
    timeout_minutes = body.csrf_token_timeout_minutes

    # Extra guard even though Field enforces range
    if timeout_minutes < 0 or timeout_minutes > 1440:
        return jsonify({
            "error": {"code": "INVALID_CSRF_TIMEOUT", "message": "CSRF token timeout must be between 0 and 1440 minutes."},
            "meta": {"request_id": request_id}
        }), 400

    if timeout_minutes == 0:
        Setting.set('WTF_CSRF_TIME_LIMIT', None, SettingValueType.STRING, "CSRF Token Timeout")
        current_app.config['WTF_CSRF_TIME_LIMIT'] = None
    else:
        timeout_seconds = timeout_minutes * 60
        Setting.set('WTF_CSRF_TIME_LIMIT', timeout_seconds, SettingValueType.INTEGER, "CSRF Token Timeout")
        current_app.config['WTF_CSRF_TIME_LIMIT'] = timeout_seconds

    log_event(EventType.SETTING_CHANGE, "Advanced settings updated via API.", admin_id=current_user.id)

    return jsonify({"data": _serialize_advanced_settings(), "meta": {"request_id": request_id}}), 200

