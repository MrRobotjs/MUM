from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Optional, Any

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.extensions import db
from app.models import User, UserType
from app.models_media_services import MediaLibrary, MediaStreamHistory
from app.utils.avatar_helpers import get_user_avatar_url
from sqlalchemy import func, or_ as sa_or
from sqlalchemy.orm import joinedload


users_tag = Tag(name="Users", description="User management endpoints")


class UsersQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    search: Optional[str] = None
    user_type: Optional[str] = Field(None, description="owner|local|service")
    role: Optional[str] = Field(None, description="Admin role name filter")
    sort: str = Field(
        "created_desc",
        description="username_asc|username_desc|created_asc|created_desc",
    )
    # Extended filters to support UI controls
    server_id: Optional[int] = Field(None, description="Filter service users by server id")
    filter_type: Optional[str] = Field(None, description="has_discord|no_discord|home_user|shares_back (partial support)")
    search_email: Optional[str] = None
    search_username: Optional[str] = None
    search_notes: Optional[str] = None


class UserItem(BaseModel):
    id: int
    uuid: str
    username: Optional[str] = None
    email: Optional[str] = None
    external_email: Optional[str] = None
    user_type: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: Optional[str] = None
    last_login_at: Optional[str] = None
    last_platform: Optional[str] = None
    last_player: Optional[str] = None
    is_active: bool
    admin_roles: list[str] = []
    admin_roles_detail: list[dict] = []
    linked_service_count: int = 0
    notes: Optional[str] = None
    # v1-compatible extras
    user_roles: list[dict] = []
    linked_local_user: Optional[dict] = None
    server_nickname: Optional[str] = None
    service_type: Optional[str] = None
    service_join_date: Optional[str] = None
    last_streamed_at: Optional[str] = None
    last_known_ip: Optional[str] = None
    total_plays: int = 0
    total_duration: int = 0
    last_played: Optional[dict[str, Any]] = None
    libraries: list[str] = []
    has_all_libraries: Optional[bool] = None
    access_expires_at: Optional[str] = None


class PaginationMeta(BaseModel):
    page: int
    page_size: int
    total_items: int
    total_pages: int


class MetaModel(BaseModel):
    request_id: str
    generated_at: str
    pagination: PaginationMeta
    deprecated: bool
    filters: dict


class UsersListResponse(BaseModel):
    data: list[UserItem]
    meta: MetaModel


def _compute_display_name(u: User) -> Optional[str]:
    # Prefer a method if present
    if hasattr(u, "get_display_name"):
        try:
            return u.get_display_name()  # type: ignore[attr-defined]
        except Exception:
            pass
    return (
        u.localUsername
        or getattr(u, "external_username", None)
        or getattr(u, "discord_username", None)
        or u.email
        or getattr(u, "external_email", None)
    )


def _username(u: User) -> Optional[str]:
    return u.localUsername or getattr(u, "external_username", None) or getattr(u, "discord_username", None)


def _email(u: User) -> Optional[str]:
    return u.email or getattr(u, "discord_email", None) or getattr(u, "external_email", None)


def _isoformat(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.isoformat() + "Z"
    return dt.isoformat()


def _format_last_played_title(media_title: Optional[str], media_type: Optional[str], grandparent_title: Optional[str]) -> str:
    title = media_title or "Unknown Title"
    if media_type in {"episode", "track"} and grandparent_title:
        return f"{grandparent_title} - {title}"
    return title


def _linked_service_count(u: User) -> int:
    if u.userType == UserType.LOCAL:
        try:
            return len(u.get_linked_users())
        except Exception:
            return 0
    return 0


def _to_item(u: User) -> dict:
    return {
        "id": u.id,
        "uuid": u.uuid,
        "username": _username(u),
        "email": _email(u),
        "user_type": (u.userType.value if hasattr(u.userType, "value") else str(u.userType)),
        "display_name": _compute_display_name(u),
        "avatar_url": get_user_avatar_url(u),
        "created_at": u.created_at.isoformat() + "Z" if getattr(u, "created_at", None) else None,
        "last_login_at": u.last_login_at.isoformat() + "Z" if getattr(u, "last_login_at", None) else None,
        "is_active": bool(getattr(u, "is_active", True)),
        "admin_roles": [r.name for r in getattr(u, "admin_roles", [])] if getattr(u, "admin_roles", None) else [],
        "admin_roles_detail": [
            {
                "name": getattr(r, "name", None),
                "color": getattr(r, "color", None),
                "icon": getattr(r, "icon", None),
                "badge_style": getattr(r, "badge_style", None),
                "description": getattr(r, "description", None),
            }
            for r in getattr(u, "admin_roles", []) or []
        ],
        "linked_service_count": _linked_service_count(u),
        "notes": getattr(u, "notes", None),
        "access_expires_at": _isoformat(getattr(u, "access_expires_at", None)),
    }


@api_v2.get(
    "/users",
    tags=[users_tag],
    summary="List users",
    responses={200: UsersListResponse},
)
@jwt_required_with_user()
def list_users(query: UsersQuery, current_user):
    q = User.query.options(joinedload(User.server))
    from app.services.media_service_manager import MediaServiceManager
    effective_server_ids = {s.id for s in MediaServiceManager.get_effective_servers(active_only=True)}

    # Hide service users that belong to inactive/disabled servers
    if effective_server_ids is not None:
        if effective_server_ids:
            q = q.filter(sa_or(User.userType != UserType.SERVICE, User.server_id.in_(effective_server_ids)))
        else:
            q = q.filter(User.userType != UserType.SERVICE)

    # Filter by user type
    if query.user_type:
        try:
            ut = UserType(query.user_type)
            q = q.filter(User.userType == ut)
        except Exception:
            pass

    # Search (case-insensitive) aggregate term
    if query.search:
        term = f"%{query.search.strip()}%"
        q = q.filter(
            sa_or(
                func.lower(func.coalesce(User.localUsername, getattr(User, 'external_username', None))).like(func.lower(term)),
                func.lower(func.coalesce(User.email, User.discord_email, getattr(User, 'external_email', None))).like(func.lower(term)),
            )
        )

    # Specific search fields
    if query.search_username:
        term = f"%{query.search_username.strip()}%"
        q = q.filter(
            func.lower(func.coalesce(User.localUsername, getattr(User, 'external_username', None))).like(func.lower(term))
        )
    if query.search_email:
        term = f"%{query.search_email.strip()}%"
        q = q.filter(
            func.lower(func.coalesce(User.email, User.discord_email, getattr(User, 'external_email', None))).like(func.lower(term))
        )
    if query.search_notes:
        term = f"%{query.search_notes.strip()}%"
        if hasattr(User, 'notes'):
            q = q.filter(func.lower(User.notes).like(func.lower(term)))

    # Filter by role name (admin or user role)
    if query.role:
        try:
            from app.models import AdminRole, UserRole as MUserRole  # type: ignore
            q = q.filter(
                sa_or(
                    User.admin_roles.any(func.lower(AdminRole.name) == func.lower(query.role)),
                    User.user_roles.any(func.lower(MUserRole.name) == func.lower(query.role)),
                )
            )
        except Exception:
            # Fallback: try admin role only
            try:
                from app.models import AdminRole
                q = q.filter(User.admin_roles.any(func.lower(AdminRole.name) == func.lower(query.role)))
            except Exception:
                pass

    # Server filter (applies to service users only)
    if query.server_id:
        try:
            server_id_int = int(query.server_id)
            if effective_server_ids is not None and server_id_int not in effective_server_ids:
                q = q.filter(False)
            else:
                q = q.filter(User.server_id == server_id_int)
        except Exception:
            pass

    # Filter type hints
    if query.filter_type:
        ft = (query.filter_type or '').lower()
        try:
            if ft == 'has_discord':
                if hasattr(User, 'discord_user_id'):
                    q = q.filter(User.discord_user_id.isnot(None))
            elif ft == 'no_discord':
                if hasattr(User, 'discord_user_id'):
                    q = q.filter(User.discord_user_id.is_(None))
            elif ft == 'home_user':
                # Prefer boolean column when available; fallback to role membership
                if hasattr(User, 'is_home_user'):
                    q = q.filter(User.is_home_user.is_(True))
                else:
                    try:
                        from app.models import UserRole
                        q = q.filter(User.user_roles.any(func.lower(UserRole.name) == func.lower('Home User')))
                    except Exception:
                        pass
            elif ft == 'shares_back':
                if hasattr(User, 'shares_back'):
                    q = q.filter(User.shares_back.is_(True))
                else:
                    try:
                        from app.models import UserRole
                        q = q.filter(User.user_roles.any(func.lower(UserRole.name) == func.lower('Shares Back')))
                    except Exception:
                        pass
        except Exception:
            pass

    # Sorting
    sort = (query.sort or "created_desc").lower()
    if sort == "username_asc":
        q = q.order_by(func.lower(func.coalesce(User.localUsername, User.external_username)).asc())
    elif sort == "username_desc":
        q = q.order_by(func.lower(func.coalesce(User.localUsername, User.external_username)).desc())
    elif sort == "created_asc":
        q = q.order_by(User.created_at.asc())
    elif sort == "last_streamed_desc":
        # Sort by last_activity_at descending, nulls last
        q = q.order_by(User.last_activity_at.desc().nullslast())
    elif sort == "last_streamed_asc":
        # Sort by last_activity_at ascending, nulls last
        q = q.order_by(User.last_activity_at.asc().nullslast())
    else:  # created_desc
        q = q.order_by(User.created_at.desc())

    # Pagination
    page = query.page
    size = query.page_size
    total_items = q.count()
    total_pages = (total_items + size - 1) // size if size else 1
    items = q.offset((page - 1) * size).limit(size).all()

    user_uuids = [u.uuid for u in items]
    stream_stats: dict[str, dict[str, int]] = {}
    last_ips: dict[str, str] = {}
    last_played_map: dict[str, dict[str, Any]] = {}
    last_streamed_map: dict[str, str] = {}

    if user_uuids:
        stats_rows = db.session.query(
            MediaStreamHistory.user_uuid,
            func.count(MediaStreamHistory.id).label("total_plays"),
            func.coalesce(func.sum(MediaStreamHistory.duration_seconds), 0).label("total_duration"),
        ).filter(MediaStreamHistory.user_uuid.in_(user_uuids))
        if effective_server_ids is not None:
            stats_rows = stats_rows.filter(MediaStreamHistory.server_id.in_(effective_server_ids))
        stats_rows = stats_rows.group_by(MediaStreamHistory.user_uuid).all()

        for user_uuid, total_plays, total_duration in stats_rows:
            stream_stats[user_uuid] = {
                "total_plays": int(total_plays or 0),
                "total_duration": int(total_duration or 0),
            }

        last_ip_subq = db.session.query(
            MediaStreamHistory.user_uuid.label("user_uuid"),
            MediaStreamHistory.ip_address.label("ip_address"),
            func.row_number().over(
                partition_by=MediaStreamHistory.user_uuid,
                order_by=MediaStreamHistory.started_at.desc(),
            ).label("rn"),
        ).filter(
            MediaStreamHistory.user_uuid.in_(user_uuids),
            MediaStreamHistory.ip_address.isnot(None),
        )
        if effective_server_ids is not None:
            last_ip_subq = last_ip_subq.filter(MediaStreamHistory.server_id.in_(effective_server_ids))
        last_ip_subq = last_ip_subq.subquery()

        ip_rows = db.session.query(last_ip_subq.c.user_uuid, last_ip_subq.c.ip_address).filter(last_ip_subq.c.rn == 1).all()
        for user_uuid, ip_address in ip_rows:
            if ip_address:
                last_ips[user_uuid] = ip_address

        last_played_subq = db.session.query(
            MediaStreamHistory.user_uuid.label("user_uuid"),
            MediaStreamHistory.media_title.label("media_title"),
            MediaStreamHistory.media_type.label("media_type"),
            MediaStreamHistory.grandparent_title.label("grandparent_title"),
            MediaStreamHistory.parent_title.label("parent_title"),
            MediaStreamHistory.rating_key.label("rating_key"),
            MediaStreamHistory.started_at.label("started_at"),
            MediaStreamHistory.server_id.label("server_id"),
            MediaStreamHistory.thumb_url.label("thumb_url"),
            MediaStreamHistory.platform.label("platform"),
            MediaStreamHistory.player.label("player"),
            func.row_number().over(
                partition_by=MediaStreamHistory.user_uuid,
                order_by=MediaStreamHistory.started_at.desc(),
            ).label("rn"),
        ).filter(MediaStreamHistory.user_uuid.in_(user_uuids))
        if effective_server_ids is not None:
            last_played_subq = last_played_subq.filter(MediaStreamHistory.server_id.in_(effective_server_ids))
        last_played_subq = last_played_subq.subquery()

        last_played_rows = db.session.query(last_played_subq).filter(last_played_subq.c.rn == 1).all()
        for row in last_played_rows:
            display_title = _format_last_played_title(row.media_title, row.media_type, row.grandparent_title)
            last_played_map[row.user_uuid] = {
                "media_title": display_title,
                "original_media_title": row.media_title,
                "media_type": row.media_type,
                "grandparent_title": row.grandparent_title,
                "parent_title": row.parent_title,
                "rating_key": row.rating_key,
                "server_id": row.server_id,
                "thumb_url": row.thumb_url,
                "platform": row.platform,
                "player": row.player,
                "started_at": _isoformat(row.started_at),
            }
            if row.started_at:
                last_streamed_map[row.user_uuid] = _isoformat(row.started_at)

    local_uuids = [u.uuid for u in items if u.userType in {UserType.LOCAL, UserType.OWNER}]
    linked_service_users: list[User] = []
    if local_uuids:
        linked_service_users = User.query.options(joinedload(User.server)).filter(
            User.userType == UserType.SERVICE,
            User.linkedUserId.in_(local_uuids),
        )
        if effective_server_ids is not None:
            linked_service_users = linked_service_users.filter(User.server_id.in_(effective_server_ids))
        linked_service_users = linked_service_users.all()

    service_users_for_libraries: dict[str, User] = {
        u.uuid: u for u in items if u.userType == UserType.SERVICE
    }
    for svc in linked_service_users:
        service_users_for_libraries.setdefault(svc.uuid, svc)

    server_type_by_id: dict[int, str] = {}
    for svc in service_users_for_libraries.values():
        if getattr(svc, "server_id", None) and getattr(svc, "server", None) and getattr(svc.server, "service_type", None):
            server_type_by_id[svc.server_id] = svc.server.service_type.value

    service_server_ids = set(server_type_by_id.keys())
    libraries_by_server: dict[int, dict[str, str]] = defaultdict(dict)
    all_ids_by_server: dict[int, set[str]] = defaultdict(set)
    kavita_internal_ids_by_server: dict[int, set[str]] = defaultdict(set)
    kavita_external_to_internal_by_server: dict[int, dict[str, str]] = defaultdict(dict)

    if service_server_ids:
        libs = MediaLibrary.query.filter(MediaLibrary.server_id.in_(service_server_ids)).all()
        for lib in libs:
            server_id = lib.server_id
            if not server_id:
                continue
            if lib.external_id:
                libraries_by_server[server_id][str(lib.external_id)] = lib.name
            if lib.internal_id:
                libraries_by_server[server_id][str(lib.internal_id)] = lib.name

            server_type = server_type_by_id.get(server_id)
            if server_type == "kavita":
                if lib.internal_id:
                    kavita_internal_ids_by_server[server_id].add(str(lib.internal_id))
                if lib.external_id:
                    kavita_external_to_internal_by_server[server_id][str(lib.external_id)] = str(
                        lib.internal_id or lib.external_id
                    )
                if lib.internal_id:
                    all_ids_by_server[server_id].add(str(lib.internal_id))
                elif lib.external_id:
                    all_ids_by_server[server_id].add(str(lib.external_id))
            else:
                if lib.external_id:
                    all_ids_by_server[server_id].add(str(lib.external_id))
                elif lib.internal_id:
                    all_ids_by_server[server_id].add(str(lib.internal_id))

    def _get_all_library_names(server_id: Optional[int]) -> list[str]:
        if not server_id:
            return []
        names = {name for name in libraries_by_server.get(server_id, {}).values() if name}
        return sorted(names, key=str.lower)

    def _get_jellyfin_policy_context(service_user: User) -> tuple[Optional[bool], list[str]]:
        raw_data = getattr(service_user, "user_raw_data", None)
        if not isinstance(raw_data, dict):
            return None, []

        policy = raw_data.get("policy")
        if not isinstance(policy, dict):
            user_payload = raw_data.get("user")
            if isinstance(user_payload, dict):
                candidate_policy = user_payload.get("Policy")
                if isinstance(candidate_policy, dict):
                    policy = candidate_policy

        if not isinstance(policy, dict):
            return None, []

        enable_all_folders_raw = policy.get("EnableAllFolders")
        enable_all_folders: Optional[bool] = (
            bool(enable_all_folders_raw) if enable_all_folders_raw is not None else None
        )
        enabled_folders_raw = policy.get("EnabledFolders", [])
        enabled_folders = [
            str(folder_id)
            for folder_id in (enabled_folders_raw if isinstance(enabled_folders_raw, list) else [])
            if folder_id not in (None, "")
        ]
        return enable_all_folders, enabled_folders

    def _get_plex_share_context(service_user: User) -> tuple[Optional[bool], list[str], bool]:
        raw_data = getattr(service_user, "user_raw_data", None)
        if not isinstance(raw_data, dict):
            return None, [], False

        is_owner = bool(raw_data.get("is_media_server_owner"))
        share_details = raw_data.get("share_details")
        if not isinstance(share_details, dict):
            return None, [], is_owner

        all_libraries_raw = share_details.get("allLibraries")
        all_libraries_enabled: Optional[bool] = (
            bool(all_libraries_raw) if all_libraries_raw is not None else None
        )
        shared_keys_raw = share_details.get("sharedSectionKeys", [])
        shared_keys = [
            str(section_id)
            for section_id in (shared_keys_raw if isinstance(shared_keys_raw, list) else [])
            if section_id not in (None, "")
        ]
        return all_libraries_enabled, shared_keys, is_owner

    def _get_audiobookshelf_access_context(service_user: User) -> Optional[bool]:
        raw_data = getattr(service_user, "user_raw_data", None)
        if not isinstance(raw_data, dict):
            return None

        permissions = raw_data.get("permissions")
        if not isinstance(permissions, dict):
            return None

        access_all_libraries = permissions.get("accessAllLibraries")
        if isinstance(access_all_libraries, bool):
            return access_all_libraries
        return None

    def _resolve_libraries_for_service_user(service_user: User) -> tuple[list[str], bool]:
        allowed_ids = [str(v) for v in (getattr(service_user, "allowed_library_ids", []) or [])]
        server_id = getattr(service_user, "server_id", None)
        server_type = server_type_by_id.get(server_id, "")

        if server_type == "jellyfin":
            enable_all_folders, policy_enabled_ids = _get_jellyfin_policy_context(service_user)
            if enable_all_folders is True:
                return _get_all_library_names(server_id), True
            if enable_all_folders is False and not allowed_ids and not policy_enabled_ids:
                return [], False
            if not allowed_ids and policy_enabled_ids:
                allowed_ids = policy_enabled_ids
        elif server_type == "plex":
            all_libraries_enabled, shared_keys, is_owner = _get_plex_share_context(service_user)
            if is_owner or all_libraries_enabled is True:
                return _get_all_library_names(server_id), True
            if not allowed_ids and shared_keys:
                allowed_ids = shared_keys
        elif server_type == "audiobookshelf":
            access_all_libraries = _get_audiobookshelf_access_context(service_user)
            if access_all_libraries is True:
                return _get_all_library_names(server_id), True
            if access_all_libraries is False and not allowed_ids:
                return [], False

        if not allowed_ids:
            if server_type in {"kavita", "plex", "jellyfin", "audiobookshelf"}:
                return [], False
            return _get_all_library_names(server_id), True
        lib_map = libraries_by_server.get(server_id, {})

        if server_type == "kavita":
            names: list[str] = []
            normalized_allowed_ids: set[str] = set()
            has_unknown = False
            internal_ids = kavita_internal_ids_by_server.get(server_id, set())
            external_to_internal = kavita_external_to_internal_by_server.get(server_id, {})

            for lib_id in allowed_ids:
                if lib_id.startswith("kavita-name:"):
                    name = lib_id.split(":", 1)[1]
                    if name:
                        names.append(name)
                    has_unknown = True
                    continue
                names.append(lib_map.get(lib_id, f"Unknown Lib {lib_id}"))
                normalized_id = None
                if lib_id in internal_ids:
                    normalized_id = lib_id
                elif lib_id in external_to_internal:
                    normalized_id = external_to_internal[lib_id]
                else:
                    has_unknown = True
                if normalized_id:
                    normalized_allowed_ids.add(normalized_id)

            return names, False

        names = [lib_map.get(lib_id, f"Unknown Lib {lib_id}") for lib_id in allowed_ids]
        return names, False

    local_libraries_map: dict[str, set[str]] = defaultdict(set)
    local_has_all_libraries: dict[str, bool] = defaultdict(bool)
    local_service_join_map: dict[str, datetime] = {}
    for svc in linked_service_users:
        if not svc.linkedUserId:
            continue
        if getattr(svc, "service_join_date", None):
            existing = local_service_join_map.get(svc.linkedUserId)
            if existing is None or svc.service_join_date < existing:
                local_service_join_map[svc.linkedUserId] = svc.service_join_date
        libs, has_all = _resolve_libraries_for_service_user(svc)
        if has_all:
            local_has_all_libraries[svc.linkedUserId] = True
        else:
            local_libraries_map[svc.linkedUserId].update(libs)

    # Build response items aligned with v1
    data = []
    for u in items:
        item = _to_item(u)
        item["external_email"] = getattr(u, "external_email", None)
        item["total_plays"] = stream_stats.get(u.uuid, {}).get("total_plays", 0)
        item["total_duration"] = stream_stats.get(u.uuid, {}).get("total_duration", 0)
        item["last_known_ip"] = last_ips.get(u.uuid)
        last_played = last_played_map.get(u.uuid)
        item["last_played"] = last_played
        item["last_platform"] = last_played.get("platform") if last_played else None
        item["last_player"] = last_played.get("player") if last_played else None
        if last_streamed_map.get(u.uuid):
            item["last_streamed_at"] = last_streamed_map.get(u.uuid)

        # user_roles enriched
        uroles = []
        for r in getattr(u, "user_roles", []) or []:
            uroles.append({
                "name": getattr(r, "name", None),
                "color": getattr(r, "color", None),
                "icon": getattr(r, "icon", None),
                "badge_style": getattr(r, "badge_style", None),
                "description": getattr(r, "description", None),
            })
        item["user_roles"] = uroles

        # linked_local_user for service users
        if u.userType == UserType.SERVICE and getattr(u, "linkedUserId", None):
            linked_parent = User.query.filter_by(uuid=u.linkedUserId).first()
            if linked_parent:
                item["linked_local_user"] = {
                    "uuid": linked_parent.uuid,
                    "username": linked_parent.localUsername,
                    "display_name": getattr(linked_parent, "get_display_name", lambda: linked_parent.localUsername)(),
                }
            else:
                item["linked_local_user"] = None
        else:
            item["linked_local_user"] = None

        # server info and libraries for service users
        if u.userType == UserType.SERVICE and getattr(u, "server", None):
            item["server_nickname"] = u.server.server_nickname
            st = u.server.service_type
            item["service_type"] = st.value if hasattr(st, "value") else str(st)
            item["service_join_date"] = _isoformat(getattr(u, "service_join_date", None))
            if not item.get("last_streamed_at"):
                item["last_streamed_at"] = _isoformat(getattr(u, "last_activity_at", None))

            libraries, has_all_libraries = _resolve_libraries_for_service_user(u)
            item["libraries"] = libraries
            item["has_all_libraries"] = has_all_libraries
            if has_all_libraries and not item["libraries"] and getattr(u, "server_id", None):
                item["libraries"] = _get_all_library_names(u.server_id)
        elif u.userType in {UserType.LOCAL, UserType.OWNER}:
            earliest_join = local_service_join_map.get(u.uuid)
            if earliest_join:
                item["service_join_date"] = _isoformat(earliest_join)
            else:
                item["service_join_date"] = _isoformat(getattr(u, "created_at", None))

            if local_has_all_libraries.get(u.uuid):
                item["has_all_libraries"] = True
                item["libraries"] = ["All Libraries"]
            else:
                libs = sorted(local_libraries_map.get(u.uuid, set()), key=str.lower)
                item["libraries"] = libs
                item["has_all_libraries"] = False

        data.append(item)

    resp = {
        "data": data,
        "meta": {
            "request_id": __import__("uuid").uuid4().hex,
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "deprecated": False,
            "pagination": {
                "page": page,
                "page_size": size,
                "total_items": total_items,
                "total_pages": total_pages,
            },
            "filters": {
                "search": query.search,
                "user_type": query.user_type,
                "role": query.role,
            },
        },
    }
    return jsonify(resp), 200
