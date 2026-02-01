from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from flask import jsonify, current_app
from app.utils.jwt_decorators import jwt_required_with_user
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func

from app.extensions import db
from app.models import User, UserPreferences, UserType, EventType
from app.routes.api.v2 import api_v2, account_tag
from app.utils.helpers import log_event


class AccountUserModel(BaseModel):
    uuid: str
    username: str | None = None
    email: str | None = None
    display_name: str | None = None
    user_type: str
    force_password_change: bool
    has_password: bool
    last_login_at: str | None = None
    is_owner: bool


class AccountTimezoneModel(BaseModel):
    preference: str | None = Field(default=None, description="'local' or 'utc'")
    local_timezone: str | None = None
    time_format: str | None = Field(default=None, description="'12' or '24'")


class AccountCapabilitiesModel(BaseModel):
    can_set_initial_credentials: bool
    can_change_password: bool


class AccountDataModel(BaseModel):
    user: AccountUserModel
    timezone: AccountTimezoneModel
    capabilities: AccountCapabilitiesModel


class MetaModel(BaseModel):
    request_id: str
    generated_at: str | None = None


class AccountResponse(BaseModel):
    data: AccountDataModel
    meta: MetaModel


class UpdateTimezoneBody(BaseModel):
    preference: str = Field(..., description="'local' or 'utc'")
    time_format: str = Field(..., description="'12' or '24'")
    local_timezone: str | None = Field(default=None)

    @field_validator("preference")
    @classmethod
    def validate_preference(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in {"local", "utc"}:
            raise ValueError("preference must be either 'local' or 'utc'.")
        return v

    @field_validator("time_format")
    @classmethod
    def validate_time_format(cls, v: str) -> str:
        v = (v or "").strip()
        if v not in {"12", "24"}:
            raise ValueError("time_format must be either '12' or '24'.")
        return v


class InitialCredentialsBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=80)
    password: str = Field(..., min_length=8)


class UpdateEmailBody(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        email = (v or "").strip()
        if not email:
            raise ValueError("Email is required.")
        if "@" not in email or email.startswith("@") or email.endswith("@"):
            raise ValueError("Email must be a valid address.")
        return email


class UserPreferencesResponse(BaseModel):
    preferences: dict | None
    sync_enabled: bool


class UpdateUserPreferencesBody(BaseModel):
    preferences: dict = Field(..., description="User preferences object")


class UpdateSyncPreferencesBody(BaseModel):
    sync_enabled: bool = Field(..., description="Enable or disable preference sync")


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: MetaModel


def _serialize_account_payload(user: User) -> dict:
    prefs = UserPreferences.get_timezone_preference(user.id)

    user_payload = {
        "uuid": user.uuid,
        "username": user.localUsername,
        "email": user.email or user.discord_email,
        "display_name": getattr(user, "get_display_name", lambda: None)(),
        "user_type": user.userType.value if hasattr(user.userType, "value") else str(user.userType),
        "force_password_change": bool(getattr(user, "force_password_change", False)),
        "has_password": bool(user.password_hash),
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
        "is_owner": user.userType == UserType.OWNER,
    }

    return {
        "user": user_payload,
        "timezone": {
            "preference": prefs.get("preference"),
            "local_timezone": prefs.get("local_timezone"),
            "time_format": prefs.get("time_format"),
        },
        "capabilities": {
            "can_set_initial_credentials": not user.password_hash,
            "can_change_password": bool(user.password_hash),
        },
    }


@api_v2.get(
    "/account",
    tags=[account_tag],
    summary="Get account",
    responses={200: AccountResponse},
)
@jwt_required_with_user()
def get_account(current_user):
    request_id = str(uuid4())

    response = {
        "data": _serialize_account_payload(current_user),
        "meta": {
            "request_id": request_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
        },
    }

    return jsonify(response), 200


@api_v2.put(
    "/account/timezone",
    tags=[account_tag],
    summary="Update account timezone",
    responses={200: AccountResponse, 400: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
def update_account_timezone(body: UpdateTimezoneBody, current_user):
    request_id = str(uuid4())

    # Additional business rule: local_timezone required when preference is 'local'
    if body.preference == "local" and not (body.local_timezone or "").strip():
        return (
            jsonify(
                {
                    "error": {
                        "code": "MISSING_TIMEZONE",
                        "message": "local_timezone is required when preference is 'local'.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            400,
        )

    try:
        UserPreferences.set_timezone_preference(
            owner_id=current_user.id,
            preference=body.preference,
            local_timezone=(body.local_timezone or "").strip() or None,
            time_format=body.time_format,
        )
    except Exception as exc:  # pragma: no cover - defensive logging
        current_app.logger.exception("Failed to update timezone preferences: %s", exc)
        db.session.rollback()
        return (
            jsonify(
                {
                    "error": {
                        "code": "TIMEZONE_UPDATE_FAILED",
                        "message": "Unable to update timezone preferences.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            500,
        )

    response = {
        "data": _serialize_account_payload(current_user),
        "meta": {"request_id": request_id},
    }
    return jsonify(response), 200


@api_v2.post(
    "/account/initial-credentials",
    tags=[account_tag],
    summary="Set initial credentials",
    responses={200: AccountResponse, 400: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
def set_initial_credentials(body: InitialCredentialsBody, current_user):
    request_id = str(uuid4())

    if current_user.password_hash:
        return (
            jsonify(
                {
                    "error": {
                        "code": "CREDENTIALS_ALREADY_SET",
                        "message": "Local credentials have already been configured for this account.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            409,
        )

    # Ensure username is unique
    existing_user = User.get_by_local_username(body.username)
    if existing_user and existing_user.id != current_user.id:
        return (
            jsonify(
                {
                    "error": {
                        "code": "USERNAME_TAKEN",
                        "message": "That username is already in use. Choose a different one.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            409,
        )

    current_user.localUsername = body.username
    current_user.set_password(body.password)
    if hasattr(current_user, "force_password_change"):
        current_user.force_password_change = False

    try:
        db.session.commit()
    except Exception as exc:  # pragma: no cover - defensive logging
        current_app.logger.exception("Failed to set initial credentials: %s", exc)
        db.session.rollback()
        return (
            jsonify(
                {
                    "error": {
                        "code": "CREDENTIAL_UPDATE_FAILED",
                        "message": "Unable to save credentials.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            500,
        )

    log_event(
        EventType.ADMIN_PASSWORD_CHANGE,
        f"Initial local credentials configured for '{current_user.localUsername}'.",
        admin_id=current_user.id,
    )

    response = {
        "data": _serialize_account_payload(current_user),
        "meta": {"request_id": request_id},
    }
    return jsonify(response), 200


@api_v2.patch(
    "/account/email",
    tags=[account_tag],
    summary="Update account email",
    responses={200: AccountResponse, 400: ErrorResponse, 409: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
def update_account_email(body: UpdateEmailBody, current_user):
    request_id = str(uuid4())
    email = body.email.strip()

    existing_user = User.query.filter(
        User.userType.in_([UserType.OWNER, UserType.LOCAL]),
        func.lower(User.email) == email.lower(),
        User.id != current_user.id,
    ).first()
    if existing_user:
        return (
            jsonify(
                {
                    "error": {
                        "code": "EMAIL_IN_USE",
                        "message": "That email address is already in use.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            409,
        )

    current_user.email = email

    try:
        db.session.commit()
    except Exception as exc:  # pragma: no cover - defensive logging
        current_app.logger.exception("Failed to update account email: %s", exc)
        db.session.rollback()
        return (
            jsonify(
                {
                    "error": {
                        "code": "EMAIL_UPDATE_FAILED",
                        "message": "Unable to update account email.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            500,
        )

    log_event(
        EventType.SETTING_CHANGE,
        f"Account email updated for '{current_user.localUsername}'.",
        admin_id=current_user.id,
    )

    response = {
        "data": _serialize_account_payload(current_user),
        "meta": {"request_id": request_id},
    }
    return jsonify(response), 200


@api_v2.get(
    "/account/preferences",
    tags=[account_tag],
    summary="Get user preferences",
    responses={200: UserPreferencesResponse},
)
@jwt_required_with_user()
def get_user_preferences(current_user):
    """Get the current user's preferences and sync status"""
    return jsonify({
        "preferences": current_user.user_preferences or {},
        "sync_enabled": current_user.sync_preferences
    }), 200


@api_v2.patch(
    "/account/preferences",
    tags=[account_tag],
    summary="Update user preferences",
    responses={200: UserPreferencesResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
def update_user_preferences(body: UpdateUserPreferencesBody, current_user):
    """Update the current user's preferences"""
    request_id = str(uuid4())

    try:
        # Update user preferences
        current_user.user_preferences = body.preferences
        db.session.commit()

        return jsonify({
            "preferences": current_user.user_preferences,
            "sync_enabled": current_user.sync_preferences
        }), 200

    except Exception as exc:
        current_app.logger.exception("Failed to update user preferences: %s", exc)
        db.session.rollback()
        return (
            jsonify(
                {
                    "error": {
                        "code": "PREFERENCES_UPDATE_FAILED",
                        "message": "Unable to update user preferences.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            500,
        )


@api_v2.patch(
    "/account/preferences/sync",
    tags=[account_tag],
    summary="Toggle preference sync",
    responses={200: UserPreferencesResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
def update_sync_preferences(body: UpdateSyncPreferencesBody, current_user):
    """Enable or disable syncing preferences to the database"""
    request_id = str(uuid4())

    try:
        current_user.sync_preferences = body.sync_enabled

        # When enabling sync, preserve current preferences from DB
        # When disabling sync, keep preferences in DB (user can still access from localStorage)
        db.session.commit()

        return jsonify({
            "preferences": current_user.user_preferences or {},
            "sync_enabled": current_user.sync_preferences
        }), 200

    except Exception as exc:
        current_app.logger.exception("Failed to update sync preferences: %s", exc)
        db.session.rollback()
        return (
            jsonify(
                {
                    "error": {
                        "code": "SYNC_UPDATE_FAILED",
                        "message": "Unable to update preference sync setting.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            500,
        )
