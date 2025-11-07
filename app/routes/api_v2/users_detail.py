from __future__ import annotations

from datetime import datetime
from typing import Optional, Dict, Any
from uuid import uuid4

from flask import jsonify, current_app
from flask_openapi3 import Tag
from pydantic import BaseModel, Field
from sqlalchemy import or_

from app.models import User, UserType
from app.models_media_services import MediaLibrary
from app.routes.api_v2 import api_v2
from app.services import user_service
from app.utils.jwt_decorators import jwt_required_with_user


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    uuid: str = Field(..., description="User UUID")


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: Dict[str, Any] | None = None


class UserDetailResponse(BaseModel):
    data: Dict[str, Any]
    meta: Dict[str, Any]


def _serialize_roles(user: User) -> dict:
    return {
        "admin_roles": [role.name for role in getattr(user, "admin_roles", [])],
        "user_roles": [role.name for role in getattr(user, "user_roles", [])],
    }


def _serialize_service_accounts(user: User) -> list[dict]:
    linked = []
    for child in getattr(user, "linked_children", []) or []:
        if child.userType == UserType.SERVICE:
            linked.append(
                {
                    "uuid": child.uuid,
                    "service_type": child.server.service_type.value if child.server else None,
                    "server_name": child.server.server_nickname if child.server else None,
                    "external_username": child.external_username,
                    "external_email": child.external_email,
                    "linked_at": child.created_at.isoformat() if child.created_at else None,
                }
            )
    return linked


def _serialize_history_entry(entry):
    return {
        "id": entry.id,
        "timestamp": entry.timestamp.isoformat() if entry.timestamp else None,
        "event_type": entry.event_type.value if entry.event_type else None,
        "message": entry.message,
        "details": entry.details or {},
    }


def _get_avatar_url(user: User) -> Optional[str]:
    if user.userType == UserType.OWNER:
        if user.plex_thumb:
            return user.plex_thumb
    if user.userType in {UserType.LOCAL, UserType.OWNER}:
        if user.discord_avatar_hash and user.discord_user_id:
            return f"https://cdn.discordapp.com/avatars/{user.discord_user_id}/{user.discord_avatar_hash}.png?size=256"
        if user.external_avatar_url:
            return user.external_avatar_url
    if user.userType == UserType.SERVICE:
        if user.external_avatar_url:
            return user.external_avatar_url
        service_thumb = None
        if user.service_settings:
            service_thumb = user.service_settings.get("thumb")
        if service_thumb and user.server:
            base_url = user.server.public_url or user.server.url
            if service_thumb.startswith("/"):
                return f"{base_url.rstrip('/')}{service_thumb}"
            return service_thumb
    return None


def _collect_service_context(user: User) -> dict:
    service_types: list[str] = []
    server_names: list[str] = []

    if user.userType == UserType.SERVICE:
        if user.server and user.server.service_type:
            service_types.append(user.server.service_type.value)
            server_names.append(user.server.server_nickname)
    else:
        for child in getattr(user, "linked_children", []) or []:
            if child.userType == UserType.SERVICE and child.server and child.server.service_type:
                service_types.append(child.server.service_type.value)
                server_names.append(child.server.server_nickname)

    unique_service_types: list[str] = []
    for service in service_types:
        if service not in unique_service_types:
            unique_service_types.append(service)

    unique_server_names: list[str] = []
    for server in server_names:
        if server not in unique_server_names:
            unique_server_names.append(server)

    return {
        "service_types": unique_service_types,
        "server_names": unique_server_names,
        "primary_service_type": unique_service_types[0] if unique_service_types else None,
        "primary_server_name": unique_server_names[0] if unique_server_names else None,
    }


def _serialize_linked_local_user(user: User) -> Optional[dict]:
    if user.userType != UserType.SERVICE or not user.linked_parent:
        return None

    parent = user.linked_parent
    display_name = None
    if hasattr(parent, "get_display_name"):
        try:
            display_name = parent.get_display_name()  # type: ignore[attr-defined]
        except Exception:
            display_name = parent.localUsername
    else:
        display_name = parent.localUsername

    return {
        "uuid": parent.uuid,
        "username": parent.localUsername,
        "display_name": display_name,
        "email": parent.email,
    }


@api_v2.get(
    "/users/<uuid>",
    tags=[users_tag],
    summary="Get user detail",
    responses={200: UserDetailResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_user(path: UserPath, current_user):
    request_id = uuid4().hex
    user = User.query.filter_by(uuid=path.uuid).first()
    if not user:
        return (
            jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id, "deprecated": False}}),
            404,
        )

    service_context = _collect_service_context(user)
    avatar_url = _get_avatar_url(user)
    linked_local_user = _serialize_linked_local_user(user)

    libraries: list[str] = []
    has_all_libraries = True
    allowed_library_ids = getattr(user, "allowed_library_ids", None)
    if user.userType == UserType.SERVICE:
        has_all_libraries = not bool(allowed_library_ids)
        if allowed_library_ids and user.server_id:
            allowed_ids = [str(value) for value in allowed_library_ids]
            libs = MediaLibrary.query.filter(
                MediaLibrary.server_id == user.server_id,
                or_(MediaLibrary.external_id.in_(allowed_ids), MediaLibrary.internal_id.in_(allowed_ids)),
            ).all()
            libraries = [library.name for library in libs]

    stream_stats = {"global": {}, "players": []}
    try:
        stream_stats = user_service.get_user_stream_stats(user.uuid) or {"global": {}, "players": []}
    except Exception as exc:
        current_app.logger.warning(f"Failed to load stream stats for user {user.uuid}: {exc}", exc_info=True)

    global_stats = stream_stats.get("global", {}) if isinstance(stream_stats, dict) else {}
    total_plays = global_stats.get("all_time_plays", 0)
    total_duration_seconds = global_stats.get("all_time_duration_seconds", 0)

    history_entries = []
    if hasattr(user, "history_logs"):
        try:
            history_entries = [
                _serialize_history_entry(entry)
                for entry in user.history_logs.order_by(User.history_logs.property.mapper.class_.timestamp.desc()).limit(10)
            ]
        except Exception:
            history_entries = []

    data = {
        "uuid": user.uuid,
        "username": user.localUsername or user.external_username,
        "email": user.email or user.discord_email,
        "user_type": user.userType.value,
        "display_name": user.get_display_name() if hasattr(user, "get_display_name") else None,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
        "is_active": user.is_active,
        "notes": user.notes,
        "roles": _serialize_roles(user),
        "user_roles_detail": [
            {
                "name": role.name,
                "color": getattr(role, "color", None),
                "icon": getattr(role, "icon", None),
                "description": getattr(role, "description", None),
            }
            for role in getattr(user, "user_roles", [])
        ],
        "service_accounts": _serialize_service_accounts(user),
        "history": history_entries,
    }

    data.update(
        {
            "local_username": user.localUsername,
            "external_username": user.external_username,
            "external_email": user.external_email,
            "external_user_id": user.external_user_id,
            "external_user_alt_id": user.external_user_alt_id,
            "discord_username": user.discord_username,
            "discord_user_id": user.discord_user_id,
            "discord_email": user.discord_email,
            "discord_avatar_url": (
                f"https://cdn.discordapp.com/avatars/{user.discord_user_id}/{user.discord_avatar_hash}.png?size=256"
                if user.discord_avatar_hash and user.discord_user_id
                else None
            ),
            "avatar_url": avatar_url,
            "service_type": service_context.get("primary_service_type"),
            "service_types": service_context.get("service_types"),
            "server_nickname": service_context.get("primary_server_name"),
            "server_names": service_context.get("server_names"),
            "linked_local_user": linked_local_user,
            "libraries": libraries,
            "has_all_libraries": has_all_libraries,
            "last_activity_at": user.last_activity_at.isoformat() if user.last_activity_at else None,
            "service_join_date": user.service_join_date.isoformat() if user.service_join_date else None,
            "access_expires_at": user.access_expires_at.isoformat() if user.access_expires_at else None,
            "allow_downloads": bool(getattr(user, "allow_downloads", False)),
            "allow_4k_transcode": bool(getattr(user, "allow_4k_transcode", False)),
            "is_purge_whitelisted": bool(getattr(user, "is_purge_whitelisted", False)),
            "is_discord_bot_whitelisted": bool(getattr(user, "is_discord_bot_whitelisted", False)),
            "is_home_user": bool(getattr(user, "is_home_user", False)),
            "shares_back": bool(getattr(user, "shares_back", False)),
            "has_password": bool(user.password_hash),
            "used_invite": bool(user.used_invite_id),
            "force_password_change": bool(getattr(user, "force_password_change", False)),
            "stream_stats": stream_stats,
            "total_plays": total_plays,
            "total_duration_seconds": total_duration_seconds,
        }
    )

    response = {
        "data": data,
        "meta": {
            "request_id": request_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "deprecated": False,
        },
    }
    return jsonify(response), 200
