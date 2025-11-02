from __future__ import annotations

from uuid import uuid4
from typing import Optional

from flask import jsonify
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import Invite


invite_wizard_tag = Tag(name="Invite Wizard", description="Public invite validation")


class InvitePath(BaseModel):
    token: str = Field(..., description="Invite token or custom_path")


class InvitePublicData(BaseModel):
    token: str
    custom_path: Optional[str] = None
    expires_at: Optional[str] = None
    max_uses: Optional[int] = None
    current_uses: Optional[int] = None
    is_active: bool
    grant_library_ids: list[str] | None = None
    allow_downloads: bool | None = None


class InvitePublicResponse(BaseModel):
    data: InvitePublicData
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


def _serialize_invite(inv: Invite) -> dict:
    return {
        "token": inv.token,
        "custom_path": inv.custom_path,
        "expires_at": inv.expires_at.isoformat() if inv.expires_at else None,
        "max_uses": inv.max_uses,
        "current_uses": inv.current_uses,
        "is_active": bool(inv.is_active),
        "grant_library_ids": inv.grant_library_ids,
        "allow_downloads": bool(getattr(inv, "allow_downloads", False)),
    }


@api_v2.get(
    "/public/invite/<token>",
    tags=[invite_wizard_tag],
    summary="Validate/inspect invite token",
    responses={200: InvitePublicResponse, 404: ErrorResponse},
)
def validate_invite(path: InvitePath):
    request_id = uuid4().hex
    inv = Invite.query.filter((Invite.token == path.token) | (Invite.custom_path == path.token)).first()
    if not inv:
        return jsonify({"error": {"code": "INVITE_NOT_FOUND", "message": "Invite not found."}, "meta": {"request_id": request_id}}), 404
    return jsonify({"data": _serialize_invite(inv), "meta": {"request_id": request_id}}), 200
