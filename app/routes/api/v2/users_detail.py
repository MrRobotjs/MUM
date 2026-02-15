from __future__ import annotations

from datetime import datetime
from typing import Optional, Dict, Any
from uuid import uuid4

from flask import jsonify, current_app
from flask_openapi3 import Tag
from pydantic import BaseModel, Field
from sqlalchemy import desc

from app.models import User, UserType
from app.models_media_services import MediaLibrary, MediaStreamHistory
from app.services.media_service_manager import MediaServiceManager
from app.routes.api.v2 import api_v2
from app.services import user_service
from app.utils.avatar_helpers import get_user_avatar_url
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


def _serialize_stream_history_entry(entry):
    """Serialize a MediaStreamHistory entry"""
    # Build poster URL for Plex or Jellyfin
    poster_url = None
    if entry.thumb_url and entry.server:
        service_type = entry.server.service_type.value
        if service_type == 'plex':
            # Plex thumb paths need to go through the image proxy
            poster_url = f"/api/v2/media/plex/images/proxy?path={entry.thumb_url.lstrip('/')}"
        elif service_type == 'jellyfin':
            # Jellyfin paths like /Items/{Id}/Images/Primary need to go through jellyfin proxy
            poster_url = f"/api/v2/media/jellyfin/images/proxy?path={entry.thumb_url.lstrip('/')}"
        elif service_type == 'audiobookshelf':
            if entry.thumb_url.startswith("/api/v2/media/audiobookshelf/images/proxy"):
                poster_url = entry.thumb_url
            else:
                poster_url = f"/api/v2/media/audiobookshelf/images/proxy?path={entry.thumb_url.lstrip('/')}"

    return {
        "id": entry.id,
        "timestamp": entry.started_at.isoformat() if entry.started_at else None,
        "event_type": "MEDIA_STREAM",
        "message": f"Watched {entry.media_title or 'Unknown'}",
        "details": {
            "media_title": entry.media_title,
            "media_type": entry.media_type,
            "platform": entry.platform,
            "player": entry.player,
            "library_name": entry.library_name,
            "grandparent_title": entry.grandparent_title,
            "parent_title": entry.parent_title,
            "duration_seconds": entry.duration_seconds,
            "view_offset_at_end_seconds": entry.view_offset_at_end_seconds,
            "poster_url": poster_url,
        },
    }


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
    avatar_url = get_user_avatar_url(user)
    linked_local_user = _serialize_linked_local_user(user)

    libraries: list[str] = []
    has_all_libraries = True
    allowed_library_ids = getattr(user, "allowed_library_ids", None)
    if user.userType == UserType.SERVICE:
        allowed_ids = [str(value) for value in (allowed_library_ids or [])]
        server_type = user.server.service_type.value if user.server and user.server.service_type else None
        jellyfin_enable_all_folders: Optional[bool] = None
        jellyfin_policy_enabled_ids: list[str] = []
        plex_all_libraries_enabled: Optional[bool] = None
        plex_shared_section_keys: list[str] = []
        plex_is_owner = False
        audiobookshelf_access_all_libraries: Optional[bool] = None

        if server_type == "jellyfin":
            raw_data = getattr(user, "user_raw_data", None)
            policy = None
            if isinstance(raw_data, dict):
                raw_policy = raw_data.get("policy")
                if isinstance(raw_policy, dict):
                    policy = raw_policy
                else:
                    raw_user = raw_data.get("user")
                    if isinstance(raw_user, dict):
                        user_policy = raw_user.get("Policy")
                        if isinstance(user_policy, dict):
                            policy = user_policy
            if isinstance(policy, dict):
                enable_all_folders_raw = policy.get("EnableAllFolders")
                jellyfin_enable_all_folders = (
                    bool(enable_all_folders_raw) if enable_all_folders_raw is not None else None
                )
                enabled_folders_raw = policy.get("EnabledFolders", [])
                jellyfin_policy_enabled_ids = [
                    str(folder_id)
                    for folder_id in (enabled_folders_raw if isinstance(enabled_folders_raw, list) else [])
                    if folder_id not in (None, "")
                ]
            if not allowed_ids and jellyfin_policy_enabled_ids:
                allowed_ids = jellyfin_policy_enabled_ids
        elif server_type == "plex":
            raw_data = getattr(user, "user_raw_data", None)
            if isinstance(raw_data, dict):
                plex_is_owner = bool(raw_data.get("is_media_server_owner"))
                share_details = raw_data.get("share_details")
                if isinstance(share_details, dict):
                    all_libraries_raw = share_details.get("allLibraries")
                    plex_all_libraries_enabled = (
                        bool(all_libraries_raw) if all_libraries_raw is not None else None
                    )
                    shared_keys_raw = share_details.get("sharedSectionKeys", [])
                    plex_shared_section_keys = [
                        str(section_id)
                        for section_id in (shared_keys_raw if isinstance(shared_keys_raw, list) else [])
                        if section_id not in (None, "")
                    ]
            if not allowed_ids and plex_shared_section_keys:
                allowed_ids = plex_shared_section_keys
        elif server_type == "audiobookshelf":
            raw_data = getattr(user, "user_raw_data", None)
            if isinstance(raw_data, dict):
                permissions = raw_data.get("permissions")
                if isinstance(permissions, dict):
                    access_all_raw = permissions.get("accessAllLibraries")
                    if isinstance(access_all_raw, bool):
                        audiobookshelf_access_all_libraries = access_all_raw

        if server_type == "jellyfin" and jellyfin_enable_all_folders is True:
            has_all_libraries = True
        elif server_type == "plex" and (plex_is_owner or plex_all_libraries_enabled is True):
            has_all_libraries = True
        elif server_type == "audiobookshelf" and audiobookshelf_access_all_libraries is True:
            has_all_libraries = True
        elif server_type == "jellyfin" and jellyfin_enable_all_folders is False and not allowed_ids and not jellyfin_policy_enabled_ids:
            has_all_libraries = False
        elif server_type == "plex" and plex_all_libraries_enabled is False and not allowed_ids and not plex_shared_section_keys:
            has_all_libraries = False
        elif server_type == "audiobookshelf" and audiobookshelf_access_all_libraries is False and not allowed_ids:
            has_all_libraries = False
        elif not allowed_ids:
            has_all_libraries = server_type not in {"kavita", "plex", "jellyfin", "audiobookshelf"}
        elif user.server_id:
            libs = MediaLibrary.query.filter(MediaLibrary.server_id == user.server_id).all()
            lib_map: dict[str, str] = {}
            all_ids: set[str] = set()
            kavita_internal_ids: set[str] = set()
            kavita_external_to_internal: dict[str, str] = {}
            all_names = sorted({lib.name for lib in libs if lib.name}, key=str.lower)

            for lib in libs:
                if lib.external_id:
                    lib_map[str(lib.external_id)] = lib.name
                if lib.internal_id:
                    lib_map[str(lib.internal_id)] = lib.name

                if server_type == "kavita":
                    if lib.internal_id:
                        kavita_internal_ids.add(str(lib.internal_id))
                    if lib.external_id:
                        kavita_external_to_internal[str(lib.external_id)] = str(lib.internal_id or lib.external_id)
                    if lib.internal_id:
                        all_ids.add(str(lib.internal_id))
                    elif lib.external_id:
                        all_ids.add(str(lib.external_id))
                else:
                    if lib.external_id:
                        all_ids.add(str(lib.external_id))
                    elif lib.internal_id:
                        all_ids.add(str(lib.internal_id))

            if server_type == "kavita":
                names: list[str] = []
                normalized_allowed_ids: set[str] = set()
                has_unknown = False
                for lib_id in allowed_ids:
                    if lib_id.startswith("kavita-name:"):
                        name = lib_id.split(":", 1)[1]
                        if name:
                            names.append(name)
                        has_unknown = True
                        continue
                    names.append(lib_map.get(lib_id, f"Unknown Lib {lib_id}"))
                    normalized_id = None
                    if lib_id in kavita_internal_ids:
                        normalized_id = lib_id
                    elif lib_id in kavita_external_to_internal:
                        normalized_id = kavita_external_to_internal[lib_id]
                    else:
                        has_unknown = True
                    if normalized_id:
                        normalized_allowed_ids.add(normalized_id)

                libraries = names
                has_all_libraries = False
            else:
                libraries = [lib_map.get(lib_id, f"Unknown Lib {lib_id}") for lib_id in allowed_ids]
                has_all_libraries = False
        if has_all_libraries and user.server_id and not libraries:
            libs = MediaLibrary.query.filter(MediaLibrary.server_id == user.server_id).all()
            libraries = sorted({lib.name for lib in libs if lib.name}, key=str.lower)

    stream_stats = {"global": {}, "players": []}
    try:
        stream_stats = user_service.get_user_stream_stats(user.uuid) or {"global": {}, "players": []}
    except Exception as exc:
        current_app.logger.warning(f"Failed to load stream stats for user {user.uuid}: {exc}", exc_info=True)

    global_stats = stream_stats.get("global", {}) if isinstance(stream_stats, dict) else {}
    total_plays = global_stats.get("all_time_plays", 0)
    total_duration_seconds = global_stats.get("all_time_duration_seconds", 0)

    history_entries = []
    try:
        # Query streaming history for this user
        current_app.logger.info(f"Loading stream history for user {user.uuid}, type={user.userType.value}")

        # Query MediaStreamHistory by user UUID
        effective_server_ids = {s.id for s in MediaServiceManager.get_effective_servers(active_only=True)}
        stream_query = MediaStreamHistory.query.filter(
            MediaStreamHistory.user_uuid == user.uuid,
            MediaStreamHistory.server_id.in_(effective_server_ids),
        )
        stream_results = stream_query.order_by(desc(MediaStreamHistory.started_at)).limit(10).all()

        current_app.logger.info(f"Found {len(stream_results)} stream history entries for user {user.uuid}")

        # Serialize streaming history
        history_entries = [_serialize_stream_history_entry(entry) for entry in stream_results]
        current_app.logger.debug(f"Serialized {len(history_entries)} stream history entries")

    except Exception as exc:
        current_app.logger.warning(f"Failed to load stream history for user {user.uuid}: {exc}", exc_info=True)
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
        "server_id": getattr(user, "server_id", None),
        "allowed_library_ids": [str(v) for v in (allowed_library_ids or [])],
        "has_all_libraries": has_all_libraries,
        "admin_roles_detail": [
            {
                "name": role.name,
                "color": getattr(role, "color", None),
                "icon": getattr(role, "icon", None),
                "badge_style": getattr(role, "badge_style", None),
                "description": getattr(role, "description", None),
            }
            for role in getattr(user, "admin_roles", [])
        ],
        "user_roles_detail": [
            {
                "name": role.name,
                "color": getattr(role, "color", None),
                "icon": getattr(role, "icon", None),
                "badge_style": getattr(role, "badge_style", None),
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
            "server_id": getattr(user, "server_id", None),
            "linked_local_user": linked_local_user,
            "libraries": libraries,
            "has_all_libraries": has_all_libraries,
            "allowed_library_ids": [str(v) for v in (allowed_library_ids or [])],
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
