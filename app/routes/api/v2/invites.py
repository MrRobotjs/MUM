from __future__ import annotations

from datetime import datetime
from typing import Optional

from flask import jsonify, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field, field_validator
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.extensions import db
from app.models import Invite, InviteUsage, InviteServerFeature, Setting
from app.models_media_services import MediaServer, MediaLibrary
from app.configuration.plugin_metadata import supports_library_scoped_grants
from app.services.media_service_manager import MediaServiceManager
from sqlalchemy import or_ as sa_or


invites_tag = Tag(name="Invites", description="Invitation management")
LIBRARY_TOKEN_SEPARATOR = "::"


def _is_scoped_library_token(token: str) -> bool:
    raw_token = str(token or "")
    separator_index = raw_token.find(LIBRARY_TOKEN_SEPARATOR)
    if separator_index <= 0:
        return False
    server_part = raw_token[:separator_index]
    library_part = raw_token[separator_index + len(LIBRARY_TOKEN_SEPARATOR):]
    return bool(server_part.isdigit() and library_part)


def _normalize_service_type(service_type) -> str:
    return str(getattr(service_type, "value", service_type) or "").lower()


def _supports_scoped_library_access(service_type) -> bool:
    return supports_library_scoped_grants(_normalize_service_type(service_type))


class InvitesQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    status: Optional[str] = Field(None, description="active|inactive|expired|maxed|usable|paused")
    search: Optional[str] = Field(None, description="Search token or custom_path")
    server_id: Optional[int] = Field(None, description="Filter by linked server")


class ServerRef(BaseModel):
    id: int
    server_nickname: Optional[str] = None
    service_type: Optional[str] = None
    is_active: Optional[bool] = None
    plugin_enabled: Optional[bool] = None
    effective_active: Optional[bool] = None


class ServerFeature(BaseModel):
    server_id: int
    allow_downloads: Optional[bool] = None
    invite_to_plex_home: Optional[bool] = None
    allow_live_tv: Optional[bool] = None
    allow_4k_transcode: Optional[bool] = None
    server_nickname: Optional[str] = None
    service_type: Optional[str] = None
    is_override: Optional[bool] = None


class InviteItem(BaseModel):
    id: int
    token: str
    custom_path: Optional[str] = None
    expires_at: Optional[str] = None
    max_uses: Optional[int] = None
    current_uses: int
    is_active: bool
    is_expired: bool
    has_reached_max_uses: bool
    is_usable: bool
    is_effectively_usable: Optional[bool] = None
    is_paused: Optional[bool] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    servers: list[ServerRef] = []
    disabled_servers: list[ServerRef] = []
    effective_server_count: Optional[int] = None
    disabled_server_count: Optional[int] = None
    # extras to align with v1 list
    grant_library_ids: list[str] | None = None
    allow_downloads: bool | None = None
    require_discord_auth: bool | None = None
    require_discord_guild_membership: bool | None = None
    server_features: list[ServerFeature] = []


class PaginationMeta(BaseModel):
    page: int
    page_size: int
    total_items: int
    total_pages: int


class MetaModel(BaseModel):
    request_id: str
    generated_at: str
    pagination: Optional[PaginationMeta] = None


class InvitesListResponse(BaseModel):
    data: list[InviteItem]
    meta: MetaModel


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: MetaModel | None = None


class ServerFeatureInput(BaseModel):
    server_id: int
    allow_downloads: Optional[bool] = None
    invite_to_plex_home: Optional[bool] = None
    allow_live_tv: Optional[bool] = None
    allow_4k_transcode: Optional[bool] = None


class CreateInviteBody(BaseModel):
    custom_path: Optional[str] = None
    expires_at: Optional[str] = Field(None, description="ISO8601 datetime")
    max_uses: Optional[int] = None
    grant_library_ids: list[str] = []
    allow_downloads: Optional[bool] = False
    is_active: Optional[bool] = True
    server_ids: Optional[list[int]] = Field(None, description="Servers to associate with this invite")
    invite_to_plex_home: Optional[bool] = False
    allow_live_tv: Optional[bool] = False
    allow_4k_transcode: Optional[bool] = True
    membership_duration_days: Optional[int] = Field(None, description="Duration in days for granted access")
    grant_purge_whitelist: Optional[bool] = False
    grant_bot_whitelist: Optional[bool] = False  # Ignored (WIP)
    require_discord_auth: Optional[bool] = None
    require_discord_guild_membership: Optional[bool] = None
    server_features: list[ServerFeatureInput] = Field(default_factory=list)

    @field_validator("custom_path")
    @classmethod
    def validate_custom_path(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return v
        v = v.strip()
        return v or None

    @field_validator("grant_library_ids")
    @classmethod
    def validate_grant_library_ids(cls, values: list[str]) -> list[str]:
        invalid = [token for token in values if not _is_scoped_library_token(token)]
        if invalid:
            raise ValueError("grant_library_ids entries must use '<server_id>::<library_id>' format")
        return values


def _server_ref(s: MediaServer) -> dict:
    plugin_enabled = MediaServiceManager.is_plugin_enabled(s.service_type)
    is_active = bool(getattr(s, "is_active", False))
    effective_active = bool(is_active and plugin_enabled)
    return {
        "id": s.id,
        "server_nickname": getattr(s, "server_nickname", None) or getattr(s, "name", None),
        "service_type": s.service_type.value if hasattr(s.service_type, "value") else str(s.service_type),
        "is_active": is_active,
        "plugin_enabled": plugin_enabled,
        "effective_active": effective_active,
    }


def _build_invite_server_state(invite: Invite) -> tuple[list[dict], list[dict], int]:
    servers_payload: list[dict] = []
    disabled_servers: list[dict] = []
    effective_count = 0
    for server in invite.servers or []:
        payload = _server_ref(server)
        servers_payload.append(payload)
        if payload.get("effective_active"):
            effective_count += 1
        else:
            disabled_servers.append(payload)
    return servers_payload, disabled_servers, effective_count


def _resolve_server_features(invite: Invite) -> list[dict]:
    """Return resolved server feature flags per server, falling back to invite-level defaults."""
    features_map = {sf.server_id: sf for sf in getattr(invite, "server_features", []) or []}
    resolved = []
    for server in invite.servers or []:
        override = features_map.get(server.id)
        allow_downloads = override.allow_downloads if override and override.allow_downloads is not None else bool(getattr(invite, "allow_downloads", False))
        invite_to_plex_home = override.invite_to_plex_home if override and override.invite_to_plex_home is not None else bool(getattr(invite, "invite_to_plex_home", False))
        allow_live_tv = override.allow_live_tv if override and override.allow_live_tv is not None else bool(getattr(invite, "allow_live_tv", False))
        allow_4k_transcode = override.allow_4k_transcode if override and override.allow_4k_transcode is not None else bool(getattr(invite, "allow_4k_transcode", True))
        resolved.append(
            {
                "server_id": server.id,
                "server_nickname": getattr(server, "server_nickname", None) or getattr(server, "name", None),
                "service_type": server.service_type.value if hasattr(server.service_type, "value") else str(server.service_type),
                "allow_downloads": allow_downloads,
                "invite_to_plex_home": invite_to_plex_home,
                "allow_live_tv": allow_live_tv,
                "allow_4k_transcode": allow_4k_transcode,
                "is_override": bool(
                    override
                    and (
                        (override.allow_downloads is not None and override.allow_downloads != bool(getattr(invite, "allow_downloads", False)))
                        or (override.invite_to_plex_home is not None and override.invite_to_plex_home != bool(getattr(invite, "invite_to_plex_home", False)))
                        or (override.allow_live_tv is not None and override.allow_live_tv != bool(getattr(invite, "allow_live_tv", False)))
                        or (override.allow_4k_transcode is not None and override.allow_4k_transcode != bool(getattr(invite, "allow_4k_transcode", True)))
                    )
                ),
            }
        )
    return resolved


def _sync_server_features(invite: Invite, features_payload: list[ServerFeatureInput] | list[dict] | None):
    """
    Ensure invite.server_features aligns with selected servers.
    - If features_payload is None: keep existing per-server values, add defaults for new servers, prune removed ones.
    - If provided: update values for matching servers (fallback to defaults when not set), prune removed ones.
    """
    payload_provided = features_payload is not None
    payload_map = {}
    if payload_provided:
        for item in features_payload or []:
            raw = item.model_dump(exclude_none=False) if hasattr(item, "model_dump") else dict(item)
            server_id = raw.get("server_id")
            if server_id is None:
                continue
            payload_map[server_id] = raw

    desired_ids = {s.id for s in invite.servers or []}
    existing_map = {sf.server_id: sf for sf in getattr(invite, "server_features", []) or []}

    # Remove rows for servers that are no longer attached
    for server_id, sf in list(existing_map.items()):
        if server_id not in desired_ids:
            invite.server_features.remove(sf)
            db.session.delete(sf)

    defaults = {
        "allow_downloads": bool(getattr(invite, "allow_downloads", False)),
        "invite_to_plex_home": bool(getattr(invite, "invite_to_plex_home", False)),
        "allow_live_tv": bool(getattr(invite, "allow_live_tv", False)),
        "allow_4k_transcode": bool(getattr(invite, "allow_4k_transcode", True)),
    }

    for server in invite.servers or []:
        existing = existing_map.get(server.id)
        payload = payload_map.get(server.id) if payload_provided else None

        if not payload_provided and existing:
            # Keep current values when no payload was sent
            continue

        def _value(field: str):
            if payload_provided and payload is not None and payload.get(field) is not None:
                return payload[field]
            if existing and getattr(existing, field) is not None:
                return getattr(existing, field)
            return defaults[field]

        values = {
            "allow_downloads": _value("allow_downloads"),
            "invite_to_plex_home": _value("invite_to_plex_home"),
            "allow_live_tv": _value("allow_live_tv"),
            "allow_4k_transcode": _value("allow_4k_transcode"),
        }

        if existing:
            existing.allow_downloads = values["allow_downloads"]
            existing.invite_to_plex_home = values["invite_to_plex_home"]
            existing.allow_live_tv = values["allow_live_tv"]
            existing.allow_4k_transcode = values["allow_4k_transcode"]
        else:
            invite.server_features.append(
                InviteServerFeature(server_id=server.id, **values)
            )


def _split_scoped_library_token(token: str) -> tuple[Optional[int], str]:
    raw_token = str(token or "")
    if LIBRARY_TOKEN_SEPARATOR not in raw_token:
        return None, ""

    server_part, library_part = raw_token.split(LIBRARY_TOKEN_SEPARATOR, 1)
    if not server_part.isdigit() or not library_part:
        return None, ""
    return int(server_part), library_part


def _validate_scoped_library_tokens_supported(
    tokens: list[str] | None,
    request_id: Optional[str] = None,
):
    scoped_tokens = [str(token) for token in (tokens or []) if token is not None]
    if not scoped_tokens:
        return None

    server_ids: set[int] = set()
    for token in scoped_tokens:
        server_id, _ = _split_scoped_library_token(token)
        if server_id is not None:
            server_ids.add(server_id)

    if not server_ids:
        return None

    servers = MediaServer.query.filter(MediaServer.id.in_(server_ids)).all()
    servers_by_id = {server.id: server for server in servers}
    invalid_tokens: list[str] = []
    unsupported_servers: dict[int, MediaServer] = {}

    for token in scoped_tokens:
        server_id, _ = _split_scoped_library_token(token)
        if server_id is None:
            continue
        server = servers_by_id.get(server_id)
        if server and not _supports_scoped_library_access(server.service_type):
            invalid_tokens.append(token)
            unsupported_servers[server.id] = server

    if not invalid_tokens:
        return None

    rid = request_id or __import__("uuid").uuid4().hex
    server_labels = sorted(
        {
            f"{_normalize_service_type(server.service_type).upper()}:{server.server_nickname}"
            for server in unsupported_servers.values()
        }
    )
    return (
        jsonify(
            {
                "error": {
                    "code": "UNSUPPORTED_LIBRARY_SCOPE",
                    "message": (
                        "Library-scoped grants are not supported for one or more selected servers. "
                        "Remove grant_library_ids entries for those servers."
                    ),
                    "details": {
                        "unsupported_servers": server_labels,
                        "invalid_tokens": invalid_tokens,
                    },
                },
                "meta": {"request_id": rid},
            }
        ),
        422,
    )


def _library_identifier_for_server(server: MediaServer, library: MediaLibrary) -> str | None:
    service_type = server.service_type.value if hasattr(server.service_type, "value") else str(server.service_type)
    if service_type == "kavita":
        return str(library.internal_id or library.external_id) if (library.internal_id or library.external_id) else None
    return str(library.external_id or library.internal_id) if (library.external_id or library.internal_id) else None


def _invite_item(i: Invite) -> dict:
    # Map granted libraries to names/servers for display
    library_tokens = [str(value) for value in (i.grant_library_ids or []) if value is not None]
    library_tokens_set = set(library_tokens)
    libs_payload = []
    grants_all_libraries = False

    if i.servers:
        servers_by_id = {server.id: server for server in i.servers}
        server_ids = list(servers_by_id.keys())
        resolved_library_ids_by_server: dict[int, set[str]] = {server_id: set() for server_id in server_ids}

        for token in library_tokens_set:
            scoped_server_id, raw_library_id = _split_scoped_library_token(token)
            if raw_library_id and scoped_server_id in resolved_library_ids_by_server:
                resolved_library_ids_by_server[scoped_server_id].add(raw_library_id)

        if library_tokens_set:
            seen_payload_keys: set[tuple[int, int]] = set()
            for server_id, resolved_ids in resolved_library_ids_by_server.items():
                if not resolved_ids:
                    continue
                libs = (
                    MediaLibrary.query.filter(MediaLibrary.server_id == server_id)
                    .filter(
                        db.or_(
                            MediaLibrary.external_id.in_(resolved_ids),
                            MediaLibrary.internal_id.in_(resolved_ids),
                        )
                    )
                    .all()
                )
                for lib in libs:
                    payload_key = (server_id, lib.id)
                    if payload_key in seen_payload_keys:
                        continue
                    seen_payload_keys.add(payload_key)
                    libs_payload.append(
                        {
                            "id": lib.external_id,
                            "name": lib.name,
                            "server_name": lib.server.server_nickname if lib.server else None,
                            "service_type": lib.server.service_type.value if lib.server else None,
                        }
                    )

            all_servers_fully_covered = True
            for server_id, server in servers_by_id.items():
                server_libraries = MediaLibrary.query.filter(MediaLibrary.server_id == server_id).all()
                if not server_libraries:
                    continue
                required_ids = {
                    required_id
                    for required_id in (
                        _library_identifier_for_server(server, library)
                        for library in server_libraries
                    )
                    if required_id
                }
                if not required_ids:
                    continue
                if not required_ids.issubset(resolved_library_ids_by_server.get(server_id, set())):
                    all_servers_fully_covered = False
                    break
            grants_all_libraries = all_servers_fully_covered
        else:
            total_libs = MediaLibrary.query.filter(MediaLibrary.server_id.in_(server_ids)).count()
            grants_all_libraries = total_libs > 0

    servers_payload, disabled_servers, effective_server_count = _build_invite_server_state(i)
    is_effectively_usable = bool(i.is_usable) and (not servers_payload or effective_server_count > 0)
    is_paused = bool(servers_payload) and bool(i.is_active) and not bool(i.is_expired) and not bool(i.has_reached_max_uses) and effective_server_count == 0

    return {
        "id": i.id,
        "token": i.token,
        "custom_path": i.custom_path,
        "expires_at": i.expires_at.isoformat() + "Z" if i.expires_at else None,
        "max_uses": i.max_uses,
        "current_uses": i.current_uses or 0,
        "is_active": bool(i.is_active),
        "is_expired": bool(i.is_expired),
        "has_reached_max_uses": bool(i.has_reached_max_uses),
        "is_usable": bool(i.is_usable),
        "is_effectively_usable": is_effectively_usable,
        "is_paused": is_paused,
        "created_at": i.created_at.isoformat() + "Z" if i.created_at else None,
        "updated_at": i.updated_at.isoformat() + "Z" if i.updated_at else None,
        "servers": servers_payload,
        "disabled_servers": disabled_servers,
        "effective_server_count": effective_server_count,
        "disabled_server_count": len(disabled_servers),
        "grant_library_ids": i.grant_library_ids or [],
        "libraries": libs_payload,
        "grants_all_libraries": grants_all_libraries,
        "allow_downloads": bool(getattr(i, "allow_downloads", False)),
        "require_discord_auth": bool(getattr(i, "require_discord_auth", False)),
        "require_discord_guild_membership": bool(getattr(i, "require_discord_guild_membership", False)),
        "invite_to_plex_home": bool(getattr(i, "invite_to_plex_home", False)),
        "allow_live_tv": bool(getattr(i, "allow_live_tv", False)),
        "allow_4k_transcode": bool(getattr(i, "allow_4k_transcode", True)),
        "membership_duration_days": getattr(i, "membership_duration_days", None),
        "grant_purge_whitelist": bool(getattr(i, "grant_purge_whitelist", False)),
        "grant_bot_whitelist": bool(getattr(i, "grant_bot_whitelist", False)),
        "server_features": _resolve_server_features(i),
    }


@api_v2.get(
    "/invites",
    tags=[invites_tag],
    summary="List invites",
    responses={200: InvitesListResponse},
)
@jwt_required_with_user()
def list_invites(query: InvitesQuery, current_user):
    q = Invite.query

    # Server filter
    if query.server_id:
        q = q.join(Invite.servers).filter(MediaServer.id == query.server_id)

    # Search
    if query.search:
        term = f"%{query.search.strip()}%"
        q = q.filter(sa_or(Invite.token.ilike(term), Invite.custom_path.ilike(term)))

    # Status filter
    status = (query.status or "").lower().strip()
    if status == "active":
        q = q.filter(Invite.is_active.is_(True))
    elif status == "inactive":
        q = q.filter(Invite.is_active.is_(False))
    elif status == "expired":
        # No direct filter; compute via expires_at < now
        from app.utils.timezone_utils import utcnow
        q = q.filter(Invite.expires_at.isnot(None)).filter(Invite.expires_at < utcnow())
    elif status == "maxed":
        q = q.filter(Invite.max_uses.isnot(None)).filter(Invite.current_uses >= Invite.max_uses)
    elif status in {"usable", "paused"}:
        from app.utils.timezone_utils import utcnow
        q = q.filter(Invite.is_active.is_(True)).filter(
            db.or_(Invite.expires_at.is_(None), Invite.expires_at > utcnow())
        ).filter(db.or_(Invite.max_uses.is_(None), Invite.current_uses < Invite.max_uses))

    q = q.order_by(Invite.created_at.desc())

    # Pagination
    page = query.page
    size = query.page_size
    if status in {"usable", "paused"}:
        items = q.all()
        data = [_invite_item(i) for i in items]
        if status == "usable":
            data = [item for item in data if item.get("is_effectively_usable", item.get("is_usable"))]
        else:
            data = [item for item in data if item.get("is_paused")]
        total_items = len(data)
        total_pages = (total_items + size - 1) // size if size else 1
        data = data[(page - 1) * size: (page - 1) * size + size]
    else:
        total_items = q.count()
        total_pages = (total_items + size - 1) // size if size else 1
        items = q.offset((page - 1) * size).limit(size).all()
        data = [_invite_item(i) for i in items]
    return (
        jsonify(
            {
                "data": data,
                "meta": {
                    "request_id": __import__("uuid").uuid4().hex,
                    "generated_at": datetime.utcnow().isoformat() + "Z",
                    "pagination": {
                        "page": page,
                        "page_size": size,
                        "total_items": total_items,
                        "total_pages": total_pages,
                    },
                },
            }
        ),
        200,
    )


@api_v2.post(
    "/invites",
    tags=[invites_tag],
    summary="Create invite",
    responses={201: InviteItem, 409: ErrorResponse, 422: ErrorResponse},
)
@jwt_required_with_user()
def create_invite(body: CreateInviteBody, current_user):
    request_id = __import__("uuid").uuid4().hex
    # Unique custom_path if provided
    if body.custom_path:
        exists = Invite.query.filter_by(custom_path=body.custom_path).first()
        if exists:
            return (
                jsonify(
                    {
                        "error": {"code": "CUSTOM_PATH_EXISTS", "message": "custom_path already exists"},
                        "meta": {"request_id": request_id},
                    }
                ),
                409,
            )

    unsupported_scope_error = _validate_scoped_library_tokens_supported(
        body.grant_library_ids,
        request_id=request_id,
    )
    if unsupported_scope_error:
        return unsupported_scope_error

    require_discord_auth = body.require_discord_auth
    require_discord_guild = body.require_discord_guild_membership
    if require_discord_auth is None:
        require_discord_auth = Setting.get_bool('DISCORD_INVITE_REQUIRE_AUTH_DEFAULT', False)
    if require_discord_guild is None:
        require_discord_guild = Setting.get_bool('DISCORD_INVITE_REQUIRE_GUILD_DEFAULT', False)
    if require_discord_guild and not require_discord_auth:
        require_discord_auth = True

    invite = Invite(
        custom_path=body.custom_path,
        expires_at=datetime.fromisoformat(body.expires_at.replace("Z", "+00:00")) if body.expires_at else None,
        max_uses=body.max_uses,
        grant_library_ids=body.grant_library_ids or [],
        allow_downloads=bool(body.allow_downloads),
        is_active=True if body.is_active is None else body.is_active,
        invite_to_plex_home=bool(body.invite_to_plex_home),
        allow_live_tv=bool(body.allow_live_tv),
        allow_4k_transcode=bool(body.allow_4k_transcode) if body.allow_4k_transcode is not None else True,
        membership_duration_days=body.membership_duration_days,
        grant_purge_whitelist=bool(body.grant_purge_whitelist),
        grant_bot_whitelist=bool(body.grant_bot_whitelist),
        require_discord_auth=require_discord_auth,
        require_discord_guild_membership=require_discord_guild,
        created_by_owner_id=getattr(current_user, "id", None),
    )

    # Associate servers if provided
    if body.server_ids:
        servers = MediaServer.query.filter(MediaServer.id.in_(body.server_ids)).all()
        invite.servers = servers

    # Apply per-server feature overrides (defaults to invite-level when not provided)
    _sync_server_features(invite, body.server_features)

    db.session.add(invite)
    db.session.commit()

    return jsonify(_invite_item(invite)), 201


class InvitePath(BaseModel):
    invite_id: int


@api_v2.get(
    "/invites/<invite_id>",
    tags=[invites_tag],
    summary="Get invite",
    responses={200: InviteItem, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_invite(path: InvitePath, current_user):
    inv = Invite.query.get(path.invite_id)
    if not inv:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Invite not found"}}), 404
    return jsonify(_invite_item(inv)), 200


class UpdateInviteBody(BaseModel):
    custom_path: Optional[str] = None
    expires_at: Optional[str] = None
    max_uses: Optional[int] = None
    grant_library_ids: Optional[list[str]] = None
    allow_downloads: Optional[bool] = None
    is_active: Optional[bool] = None
    invite_to_plex_home: Optional[bool] = None
    allow_live_tv: Optional[bool] = None
    allow_4k_transcode: Optional[bool] = None
    require_discord_auth: Optional[bool] = None
    require_discord_guild_membership: Optional[bool] = None
    membership_duration_days: Optional[int] = None
    grant_purge_whitelist: Optional[bool] = None
    grant_bot_whitelist: Optional[bool] = None
    server_ids: Optional[list[int]] = None
    server_features: Optional[list[ServerFeatureInput]] = None

    @field_validator("grant_library_ids")
    @classmethod
    def validate_grant_library_ids(cls, values: Optional[list[str]]) -> Optional[list[str]]:
        if values is None:
            return values
        invalid = [token for token in values if not _is_scoped_library_token(token)]
        if invalid:
            raise ValueError("grant_library_ids entries must use '<server_id>::<library_id>' format")
        return values


@api_v2.patch(
    "/invites/<invite_id>",
    tags=[invites_tag],
    summary="Update invite",
    responses={200: InviteItem, 404: ErrorResponse},
)
@jwt_required_with_user()
def update_invite(path: InvitePath, body: UpdateInviteBody, current_user):
    inv = Invite.query.get(path.invite_id)
    request_id = __import__("uuid").uuid4().hex
    if not inv:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Invite not found"}, "meta": {"request_id": request_id}}), 404

    data = body.model_dump(exclude_none=True)
    if "custom_path" in data:
        inv.custom_path = data["custom_path"]
    if "expires_at" in data:
        inv.expires_at = (
            datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00")) if data.get("expires_at") else None
        )
    if "max_uses" in data:
        inv.max_uses = data["max_uses"]
    if "grant_library_ids" in data:
        unsupported_scope_error = _validate_scoped_library_tokens_supported(
            data["grant_library_ids"],
            request_id=request_id,
        )
        if unsupported_scope_error:
            return unsupported_scope_error
        inv.grant_library_ids = data["grant_library_ids"]
    if "allow_downloads" in data:
        inv.allow_downloads = bool(data["allow_downloads"])
    if "is_active" in data:
        inv.is_active = bool(data["is_active"])
    if "invite_to_plex_home" in data:
        inv.invite_to_plex_home = bool(data["invite_to_plex_home"])
    if "allow_live_tv" in data:
        inv.allow_live_tv = bool(data["allow_live_tv"])
    if "allow_4k_transcode" in data:
        inv.allow_4k_transcode = bool(data["allow_4k_transcode"])
    if "require_discord_auth" in data:
        inv.require_discord_auth = bool(data["require_discord_auth"])
    if "require_discord_guild_membership" in data:
        inv.require_discord_guild_membership = bool(data["require_discord_guild_membership"])
    if getattr(inv, "require_discord_guild_membership", False) and not getattr(inv, "require_discord_auth", False):
        inv.require_discord_auth = True
    if "membership_duration_days" in data:
        inv.membership_duration_days = data["membership_duration_days"]
    if "grant_purge_whitelist" in data:
        inv.grant_purge_whitelist = bool(data["grant_purge_whitelist"])
    if "grant_bot_whitelist" in data:
        inv.grant_bot_whitelist = bool(data["grant_bot_whitelist"])
    if "server_ids" in data:
        servers = MediaServer.query.filter(MediaServer.id.in_(data["server_ids"])).all()
        inv.servers = servers

    _sync_server_features(inv, body.server_features if "server_features" in data or body.server_features is not None else None)

    db.session.commit()
    return jsonify(_invite_item(inv)), 200


@api_v2.delete(
    "/invites/<invite_id>",
    tags=[invites_tag],
    summary="Delete invite",
    responses={200: InviteItem, 404: ErrorResponse},
)
@jwt_required_with_user()
def delete_invite(path: InvitePath, current_user):
    inv = Invite.query.get(path.invite_id)
    if not inv:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Invite not found"}}), 404
    item = _invite_item(inv)
    db.session.delete(inv)
    db.session.commit()
    return jsonify(item), 200


class InviteUsagesQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(10, ge=1, le=100)


class InviteUsageItem(BaseModel):
    id: int
    invite_id: int
    used_at: Optional[str] = None
    ip_address: Optional[str] = None
    plex_username: Optional[str] = None
    plex_email: Optional[str] = None
    discord_username: Optional[str] = None
    discord_user_id: Optional[str] = None
    accepted_invite: bool
    status_message: Optional[str] = None
    user_uuid: Optional[str] = None
    plex_auth_successful: bool
    discord_auth_successful: bool


class InviteUsageSummary(BaseModel):
    total: int
    accepted: int
    pending: int
    plex_auth_successful: int
    discord_auth_successful: int
    last_used_at: Optional[str] = None


class InviteUsagesData(BaseModel):
    items: list[InviteUsageItem]
    summary: InviteUsageSummary


class InviteUsagesResponse(BaseModel):
    data: InviteUsagesData
    meta: MetaModel


def _serialize_invite_usage(usage: InviteUsage) -> dict:
    return {
        "id": usage.id,
        "invite_id": usage.invite_id,
        "used_at": usage.used_at.isoformat() + "Z" if usage.used_at else None,
        "ip_address": usage.ip_address,
        "plex_username": usage.plex_username,
        "plex_email": usage.plex_email,
        "discord_username": usage.discord_username,
        "discord_user_id": usage.discord_user_id,
        "accepted_invite": bool(usage.accepted_invite),
        "status_message": usage.status_message,
        "user_uuid": usage.userId,
        "plex_auth_successful": bool(usage.plex_auth_successful),
        "discord_auth_successful": bool(usage.discord_auth_successful),
    }


def _invite_usage_summary(invite_id: int) -> dict:
    base_query = InviteUsage.query.filter(InviteUsage.invite_id == invite_id)
    total = base_query.count()
    accepted = base_query.filter(InviteUsage.accepted_invite.is_(True)).count()
    plex_success = base_query.filter(InviteUsage.plex_auth_successful.is_(True)).count()
    discord_success = base_query.filter(InviteUsage.discord_auth_successful.is_(True)).count()
    last_usage = base_query.order_by(InviteUsage.used_at.desc()).first()
    return {
        "total": total,
        "accepted": accepted,
        "pending": max(total - accepted, 0),
        "plex_auth_successful": plex_success,
        "discord_auth_successful": discord_success,
        "last_used_at": last_usage.used_at.isoformat() + "Z" if last_usage and last_usage.used_at else None,
    }


@api_v2.get(
    "/invites/<invite_id>/usages",
    tags=[invites_tag],
    summary="List invite usage history",
    responses={200: InviteUsagesResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_invite_usages(path: InvitePath, query: InviteUsagesQuery, current_user):
    request_id = __import__("uuid").uuid4().hex
    inv = Invite.query.get(path.invite_id)
    if not inv:
        return (
            jsonify(
                {
                    "error": {"code": "NOT_FOUND", "message": "Invite not found"},
                    "meta": {"request_id": request_id},
                }
            ),
            404,
        )

    usages_query = (
        InviteUsage.query.filter(InviteUsage.invite_id == inv.id)
        .order_by(InviteUsage.used_at.desc())
    )
    pagination = usages_query.paginate(page=query.page, per_page=query.page_size, error_out=False)
    total_pages = pagination.pages or 1

    return (
        jsonify(
            {
                "data": {
                    "items": [_serialize_invite_usage(usage) for usage in pagination.items],
                    "summary": _invite_usage_summary(inv.id),
                },
                "meta": {
                    "request_id": request_id,
                    "generated_at": datetime.utcnow().isoformat() + "Z",
                    "pagination": {
                        "page": pagination.page,
                        "page_size": pagination.per_page,
                        "total_items": pagination.total,
                        "total_pages": total_pages,
                    },
                },
            }
        ),
        200,
    )


class SummaryCounts(BaseModel):
    total: int
    active: int
    inactive: int
    expired: int
    maxed: int
    usable: int
    paused: int


class RecentInvite(BaseModel):
    id: int
    token: str
    custom_path: Optional[str] = None
    created_at: Optional[str] = None
    is_active: bool
    is_expired: bool
    has_reached_max_uses: bool
    is_paused: Optional[bool] = None
    current_uses: Optional[int] = None
    max_uses: Optional[int] = None


class RecentUsage(BaseModel):
    id: int
    invite_id: int
    used_at: Optional[str] = None
    accepted_invite: bool
    plex_username: Optional[str] = None
    discord_username: Optional[str] = None
    status_message: Optional[str] = None


class InviteSummaryData(BaseModel):
    counts: SummaryCounts
    recent_invites: list[RecentInvite]
    recent_usages: list[RecentUsage]


class InviteSummaryResponse(BaseModel):
    data: InviteSummaryData
    meta: MetaModel


@api_v2.get(
    "/invites/summary",
    tags=[invites_tag],
    summary="Get invites summary",
    responses={200: InviteSummaryResponse},
)
@jwt_required_with_user()
def invite_summary(current_user):
    request_id = __import__("uuid").uuid4().hex
    from app.utils.timezone_utils import utcnow
    now = utcnow()

    base_query = Invite.query
    total = base_query.count()
    active = base_query.filter(Invite.is_active.is_(True)).count()
    inactive = base_query.filter(Invite.is_active.is_(False)).count()
    expired = base_query.filter(Invite.expires_at.isnot(None), Invite.expires_at < now).count()
    maxed = base_query.filter(Invite.max_uses.isnot(None), Invite.current_uses >= Invite.max_uses).count()
    usable = 0
    paused = 0
    candidate_invites = (
        base_query.filter(Invite.is_active.is_(True))
        .filter(sa_or(Invite.expires_at.is_(None), Invite.expires_at >= now))
        .filter(sa_or(Invite.max_uses.is_(None), Invite.current_uses < Invite.max_uses))
        .all()
    )
    for inv in candidate_invites:
        servers_payload, _disabled_servers, effective_server_count = _build_invite_server_state(inv)
        if not servers_payload or effective_server_count > 0:
            usable += 1
        else:
            paused += 1

    recent_invites = base_query.order_by(Invite.created_at.desc()).limit(5).all()
    recent_usages = InviteUsage.query.order_by(InviteUsage.used_at.desc()).limit(5).all()

    recent_invite_payload = []
    for inv in recent_invites:
        servers_payload, _disabled_servers, effective_server_count = _build_invite_server_state(inv)
        is_paused = bool(servers_payload) and bool(inv.is_active) and not bool(inv.is_expired) and not bool(inv.has_reached_max_uses) and effective_server_count == 0
        recent_invite_payload.append(
            {
                "id": inv.id,
                "token": inv.token,
                "custom_path": inv.custom_path,
                "created_at": inv.created_at.isoformat() if inv.created_at else None,
                "is_active": bool(inv.is_active),
                "is_expired": bool(inv.is_expired),
                "has_reached_max_uses": bool(inv.has_reached_max_uses),
                "is_paused": is_paused,
                "current_uses": inv.current_uses,
                "max_uses": inv.max_uses,
            }
        )

    recent_usage_payload = [
        {
            "id": u.id,
            "invite_id": u.invite_id,
            "used_at": u.used_at.isoformat() if u.used_at else None,
            "accepted_invite": bool(u.accepted_invite),
            "plex_username": u.plex_username,
            "discord_username": u.discord_username,
            "status_message": u.status_message,
        }
        for u in recent_usages
    ]

    return (
        jsonify(
            {
                "data": {
                    "counts": {
                        "total": total,
                        "active": active,
                        "inactive": inactive,
                        "expired": expired,
                        "maxed": maxed,
                        "usable": usable,
                        "paused": paused,
                    },
                    "recent_invites": recent_invite_payload,
                    "recent_usages": recent_usage_payload,
                },
                "meta": {"request_id": request_id, "generated_at": datetime.utcnow().isoformat() + "Z"},
            }
        ),
        200,
    )
