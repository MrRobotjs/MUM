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
    api_timeout_seconds: int


class AdvancedSettingsResponse(BaseModel):
    data: AdvancedSettingsData
    meta: dict


def _serialize_advanced_settings() -> dict:
    api_timeout_seconds = int(Setting.get('API_TIMEOUT_SECONDS', 3) or 3)
    return {
        "api_timeout_seconds": api_timeout_seconds,
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
    api_timeout_seconds: int = Field(..., ge=3, le=30, description="API request timeout in seconds (3-30)")


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
    Setting.set('API_TIMEOUT_SECONDS', int(body.api_timeout_seconds), SettingValueType.INTEGER, "API Request Timeout (seconds)")
    # Apply to app config if relevant
    current_app.config['API_TIMEOUT_SECONDS'] = int(body.api_timeout_seconds)

    log_event(EventType.SETTING_CHANGE, "Advanced settings updated via API.", admin_id=current_user.id)
    return jsonify({"data": _serialize_advanced_settings(), "meta": {"request_id": request_id}}), 200
