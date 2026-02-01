from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from flask import jsonify, request, current_app
from flask_login import login_required, current_user

from app.extensions import db
from app.models import User, UserPreferences, UserType
from app.routes.api_v1_deprecated import bp


def _serialize_account_payload():
    prefs = UserPreferences.get_timezone_preference(current_user.id)

    user_payload = {
        "uuid": current_user.uuid,
        "username": current_user.localUsername,
        "email": current_user.email or current_user.discord_email,
        "display_name": getattr(current_user, "get_display_name", lambda: None)(),
        "user_type": current_user.userType.value if hasattr(current_user.userType, "value") else str(current_user.userType),
        "force_password_change": bool(getattr(current_user, "force_password_change", False)),
        "has_password": bool(current_user.password_hash),
        "last_login_at": current_user.last_login_at.isoformat() if current_user.last_login_at else None,
        "is_owner": current_user.userType == UserType.OWNER,
    }

    return {
        "user": user_payload,
        "timezone": {
            "preference": prefs.get("preference"),
            "local_timezone": prefs.get("local_timezone"),
            "time_format": prefs.get("time_format"),
        },
        "capabilities": {
            "can_set_initial_credentials": not current_user.password_hash,
            "can_change_password": bool(current_user.password_hash),
        },
    }


@bp.route("/account", methods=["GET"])
@login_required
def get_account():
    request_id = str(uuid4())

    response = {
        "data": _serialize_account_payload(),
        "meta": {
            "request_id": request_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
        },
    }

    return jsonify(response), 200


@bp.route("/account/timezone", methods=["PUT"])
@login_required
def update_account_timezone():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    preference = (payload.get("preference") or "").strip().lower()
    time_format = (payload.get("time_format") or "").strip()
    local_timezone = (payload.get("local_timezone") or "").strip() or None

    if preference not in {"local", "utc"}:
        return (
            jsonify(
                {
                    "error": {
                        "code": "INVALID_PREFERENCE",
                        "message": "preference must be either 'local' or 'utc'.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            400,
        )

    if time_format not in {"12", "24"}:
        return (
            jsonify(
                {
                    "error": {
                        "code": "INVALID_TIME_FORMAT",
                        "message": "time_format must be either '12' or '24'.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            400,
        )

    if preference == "local" and not local_timezone:
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
            preference=preference,
            local_timezone=local_timezone,
            time_format=time_format,
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
        "data": _serialize_account_payload(),
        "meta": {"request_id": request_id},
    }
    return jsonify(response), 200


@bp.route("/account/initial-credentials", methods=["POST"])
@login_required
def set_initial_credentials():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""

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

    if not username:
        return (
            jsonify(
                {
                    "error": {
                        "code": "INVALID_USERNAME",
                        "message": "Username is required.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            400,
        )

    if len(username) < 3 or len(username) > 80:
        return (
            jsonify(
                {
                    "error": {
                        "code": "USERNAME_LENGTH_INVALID",
                        "message": "Username must be between 3 and 80 characters long.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            422,
        )

    existing_user = User.get_by_local_username(username)
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

    if not password or len(password) < 8:
        return (
            jsonify(
                {
                    "error": {
                        "code": "WEAK_PASSWORD",
                        "message": "Password must be at least 8 characters long.",
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            422,
        )

    current_user.localUsername = username
    current_user.set_password(password)
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


    response = {
        "data": _serialize_account_payload(),
        "meta": {"request_id": request_id},
    }
    return jsonify(response), 200