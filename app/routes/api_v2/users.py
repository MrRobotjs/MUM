from __future__ import annotations

from datetime import datetime
from typing import Optional

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.extensions import db
from app.models import User, UserType
from app.models_media_services import MediaLibrary
from sqlalchemy import func, or_ as sa_or


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
    is_active: bool
    admin_roles: list[str] = []
    linked_service_count: int = 0
    # v1-compatible extras
    user_roles: list[dict] = []
    linked_local_user: Optional[dict] = None
    server_nickname: Optional[str] = None
    service_type: Optional[str] = None
    service_join_date: Optional[str] = None
    last_streamed_at: Optional[str] = None
    libraries: list[str] = []
    has_all_libraries: Optional[bool] = None


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


def _avatar_url(u: User) -> Optional[str]:
    if u.userType == UserType.OWNER:
        if getattr(u, "plex_thumb", None):
            return u.plex_thumb
    if u.userType in {UserType.LOCAL, UserType.OWNER}:
        if getattr(u, "discord_avatar_hash", None) and getattr(u, "discord_user_id", None):
            return f"https://cdn.discordapp.com/avatars/{u.discord_user_id}/{u.discord_avatar_hash}.png?size=256"
        if getattr(u, "external_avatar_url", None):
            return u.external_avatar_url
    if u.userType == UserType.SERVICE:
        if getattr(u, "external_avatar_url", None):
            return u.external_avatar_url
        service_thumb = None
        ss = getattr(u, "service_settings", None)
        if ss:
            service_thumb = ss.get("thumb")
        if service_thumb and getattr(u, "server", None):
            base_url = u.server.public_url or u.server.url
            if service_thumb.startswith('/'):
                return f"{base_url.rstrip('/')}{service_thumb}"
            return service_thumb
    return None


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
        "avatar_url": getattr(u, "external_avatar_url", None),
        "created_at": u.created_at.isoformat() + "Z" if getattr(u, "created_at", None) else None,
        "last_login_at": u.last_login_at.isoformat() + "Z" if getattr(u, "last_login_at", None) else None,
        "is_active": bool(getattr(u, "is_active", True)),
        "admin_roles": [r.name for r in getattr(u, "admin_roles", [])] if getattr(u, "admin_roles", None) else [],
        "linked_service_count": _linked_service_count(u),
    }


@api_v2.get(
    "/users",
    tags=[users_tag],
    summary="List users",
    responses={200: UsersListResponse},
)
@jwt_required_with_user()
def list_users(query: UsersQuery, current_user):
    q = User.query

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
            q = q.filter(User.server_id == int(query.server_id))
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
    else:  # created_desc
        q = q.order_by(User.created_at.desc())

    # Pagination
    page = query.page
    size = query.page_size
    total_items = q.count()
    total_pages = (total_items + size - 1) // size if size else 1
    items = q.offset((page - 1) * size).limit(size).all()

    # Build response items aligned with v1
    data = []
    for u in items:
        item = _to_item(u)
        item["external_email"] = getattr(u, "external_email", None)

        # user_roles enriched
        uroles = []
        for r in getattr(u, "user_roles", []) or []:
            uroles.append({
                "name": getattr(r, "name", None),
                "color": getattr(r, "color", None),
                "icon": getattr(r, "icon", None),
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
            item["service_join_date"] = u.service_join_date.isoformat() if getattr(u, "service_join_date", None) else None
            item["last_streamed_at"] = u.last_activity_at.isoformat() if getattr(u, "last_activity_at", None) else None

            libraries = []
            has_all_libraries = False
            allowed_ids = [str(v) for v in (getattr(u, "allowed_library_ids", []) or [])]
            if allowed_ids:
                libs = MediaLibrary.query.filter(
                    MediaLibrary.server_id == u.server_id,
                    sa_or(
                        MediaLibrary.external_id.in_(allowed_ids),
                        MediaLibrary.internal_id.in_(allowed_ids),
                    ),
                ).all()
                libraries = [lib.name for lib in libs]
            else:
                has_all_libraries = True
            item["libraries"] = libraries
            item["has_all_libraries"] = has_all_libraries

        # avatar url aligned with v1 helper
        item["avatar_url"] = _avatar_url(u)

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
