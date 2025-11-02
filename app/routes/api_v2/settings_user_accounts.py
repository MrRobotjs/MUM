from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import Setting, SettingValueType, EventType
# JWT permission checking handled by jwt_permission_required, log_event


settings_tag = Tag(name="Settings", description="Application settings")


class UserAccountSettingsData(BaseModel):
    allow_user_accounts: bool


class SettingsResponse(BaseModel):
    data: UserAccountSettingsData
    meta: dict


def _serialize_user_account_settings() -> dict:
    return {"allow_user_accounts": Setting.get_bool("ALLOW_USER_ACCOUNTS", False)}


@api_v2.get(
    "/settings/user-accounts",
    tags=[settings_tag],
    summary="Get user account settings",
    responses={200: SettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required("manage_users_general")
def get_user_account_settings(current_user):
    request_id = uuid4().hex
    return jsonify({"data": _serialize_user_account_settings(), "meta": {"request_id": request_id}})


class UpdateUserAccountBody(BaseModel):
    allow_user_accounts: bool


@api_v2.patch(
    "/settings/user-accounts",
    tags=[settings_tag],
    summary="Update user account settings",
    responses={200: SettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required("manage_users_general")
def update_user_account_settings(body: UpdateUserAccountBody, current_user):
    request_id = uuid4().hex
    allow_accounts = bool(body.allow_user_accounts)
    Setting.set("ALLOW_USER_ACCOUNTS", allow_accounts, SettingValueType.BOOLEAN, "Allow User Accounts")
    log_event(EventType.SETTING_CHANGE, "User account settings updated via API.", admin_id=current_user.id)
    return jsonify({"data": _serialize_user_account_settings(), "meta": {"request_id": request_id}}), 200
