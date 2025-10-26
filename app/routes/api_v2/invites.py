from __future__ import annotations

from datetime import datetime
from typing import Optional

from flask import jsonify, current_app
from flask_login import login_required, current_user
from pydantic import BaseModel, Field, field_validator
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.extensions import db
from app.models import Invite, InviteUsage
from app.models_media_services import MediaServer
from sqlalchemy import or_ as sa_or


invites_tag = Tag(name="Invites", description="Invitation management")


class InvitesQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    status: Optional[str] = Field(None, description="active|inactive|expired|maxed|usable")
    search: Optional[str] = Field(None, description="Search token or custom_path")
    server_id: Optional[int] = Field(None, description="Filter by linked server")


class ServerRef(BaseModel):
    id: int
    server_nickname: Optional[str] = None
    service_type: Optional[str] = None


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
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    servers: list[ServerRef] = []
    # extras to align with v1 list
    grant_library_ids: list[str] | None = None
    allow_downloads: bool | None = None


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


class CreateInviteBody(BaseModel):
    custom_path: Optional[str] = None
    expires_at: Optional[str] = Field(None, description="ISO8601 datetime")
    max_uses: Optional[int] = None
    grant_library_ids: list[str] = []
    allow_downloads: Optional[bool] = False
    is_active: Optional[bool] = True
    server_ids: Optional[list[int]] = Field(None, description="Servers to associate with this invite")

    @field_validator("custom_path")
    @classmethod
    def validate_custom_path(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return v
        v = v.strip()
        return v or None


def _server_ref(s: MediaServer) -> dict:
    return {
        "id": s.id,
        "server_nickname": getattr(s, "server_nickname", None) or getattr(s, "name", None),
        "service_type": s.service_type.value if hasattr(s.service_type, "value") else str(s.service_type),
    }


def _invite_item(i: Invite) -> dict:
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
        "created_at": i.created_at.isoformat() + "Z" if i.created_at else None,
        "updated_at": i.updated_at.isoformat() + "Z" if i.updated_at else None,
        "servers": [_server_ref(s) for s in (i.servers or [])],
        "grant_library_ids": i.grant_library_ids or [],
        "allow_downloads": bool(getattr(i, "allow_downloads", False)),
    }


@api_v2.get(
    "/invites",
    tags=[invites_tag],
    summary="List invites",
    responses={200: InvitesListResponse},
)
@login_required
def list_invites(query: InvitesQuery):
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
    elif status == "usable":
        from app.utils.timezone_utils import utcnow
        q = q.filter(Invite.is_active.is_(True)).filter(
            db.or_(Invite.expires_at.is_(None), Invite.expires_at > utcnow())
        ).filter(db.or_(Invite.max_uses.is_(None), Invite.current_uses < Invite.max_uses))

    q = q.order_by(Invite.created_at.desc())

    # Pagination
    page = query.page
    size = query.page_size
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
@login_required
def create_invite(body: CreateInviteBody):
    # Unique custom_path if provided
    if body.custom_path:
        exists = Invite.query.filter_by(custom_path=body.custom_path).first()
        if exists:
            return (
                jsonify(
                    {
                        "error": {"code": "CUSTOM_PATH_EXISTS", "message": "custom_path already exists"},
                        "meta": {"request_id": __import__("uuid").uuid4().hex},
                    }
                ),
                409,
            )

    invite = Invite(
        custom_path=body.custom_path,
        expires_at=datetime.fromisoformat(body.expires_at.replace("Z", "+00:00")) if body.expires_at else None,
        max_uses=body.max_uses,
        grant_library_ids=body.grant_library_ids or [],
        allow_downloads=bool(body.allow_downloads),
        is_active=True if body.is_active is None else body.is_active,
        created_by_owner_id=getattr(current_user, "id", None),
    )

    # Associate servers if provided
    if body.server_ids:
        servers = MediaServer.query.filter(MediaServer.id.in_(body.server_ids)).all()
        invite.servers = servers

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
@login_required
def get_invite(path: InvitePath):
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


@api_v2.patch(
    "/invites/<invite_id>",
    tags=[invites_tag],
    summary="Update invite",
    responses={200: InviteItem, 404: ErrorResponse},
)
@login_required
def update_invite(path: InvitePath, body: UpdateInviteBody):
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
        inv.grant_library_ids = data["grant_library_ids"]
    if "allow_downloads" in data:
        inv.allow_downloads = bool(data["allow_downloads"])
    if "is_active" in data:
        inv.is_active = bool(data["is_active"])

    db.session.commit()
    return jsonify(_invite_item(inv)), 200


@api_v2.delete(
    "/invites/<invite_id>",
    tags=[invites_tag],
    summary="Delete invite",
    responses={200: InviteItem, 404: ErrorResponse},
)
@login_required
def delete_invite(path: InvitePath):
    inv = Invite.query.get(path.invite_id)
    if not inv:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Invite not found"}}), 404
    item = _invite_item(inv)
    db.session.delete(inv)
    db.session.commit()
    return jsonify(item), 200


class SummaryCounts(BaseModel):
    total: int
    active: int
    inactive: int
    expired: int
    maxed: int
    usable: int


class RecentInvite(BaseModel):
    id: int
    token: str
    custom_path: Optional[str] = None
    created_at: Optional[str] = None
    is_active: bool
    is_expired: bool
    has_reached_max_uses: bool
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
@login_required
def invite_summary():
    request_id = __import__("uuid").uuid4().hex
    from app.utils.timezone_utils import utcnow
    now = utcnow()

    base_query = Invite.query
    total = base_query.count()
    active = base_query.filter(Invite.is_active.is_(True)).count()
    inactive = base_query.filter(Invite.is_active.is_(False)).count()
    expired = base_query.filter(Invite.expires_at.isnot(None), Invite.expires_at < now).count()
    maxed = base_query.filter(Invite.max_uses.isnot(None), Invite.current_uses >= Invite.max_uses).count()
    usable = (
        base_query.filter(Invite.is_active.is_(True))
        .filter(sa_or(Invite.expires_at.is_(None), Invite.expires_at >= now))
        .filter(sa_or(Invite.max_uses.is_(None), Invite.current_uses < Invite.max_uses))
        .count()
    )

    recent_invites = base_query.order_by(Invite.created_at.desc()).limit(5).all()
    recent_usages = InviteUsage.query.order_by(InviteUsage.used_at.desc()).limit(5).all()

    recent_invite_payload = [
        {
            "id": inv.id,
            "token": inv.token,
            "custom_path": inv.custom_path,
            "created_at": inv.created_at.isoformat() if inv.created_at else None,
            "is_active": bool(inv.is_active),
            "is_expired": bool(inv.is_expired),
            "has_reached_max_uses": bool(inv.has_reached_max_uses),
            "current_uses": inv.current_uses,
            "max_uses": inv.max_uses,
        }
        for inv in recent_invites
    ]

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
                    },
                    "recent_invites": recent_invite_payload,
                    "recent_usages": recent_usage_payload,
                },
                "meta": {"request_id": request_id, "generated_at": datetime.utcnow().isoformat() + "Z"},
            }
        ),
        200,
    )
