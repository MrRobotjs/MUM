from __future__ import annotations

from uuid import uuid4
from typing import List, Literal

from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import Invite
from app.extensions import db
# JWT permission checking handled by jwt_permission_required


invites_tag = Tag(name="Invites", description="Invitation management")


class BulkInviteBody(BaseModel):
    ids: List[int] = Field(..., description="Invite IDs to process")
    action: Literal["enable", "disable", "delete"]


class BulkInviteResult(BaseModel):
    success: bool
    processed_ids: List[int]
    action: str


class BulkInviteResponse(BaseModel):
    data: BulkInviteResult
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.post(
    "/invites/bulk",
    tags=[invites_tag],
    summary="Bulk update or delete invites",
    responses={200: BulkInviteResponse, 400: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def bulk_invite_action(body: BulkInviteBody, current_user):
    request_id = uuid4().hex
    ids = body.ids
    action = body.action

    invites = Invite.query.filter(Invite.id.in_(ids)).all()

    if action == "delete":
        for inv in invites:
            db.session.delete(inv)
    else:
        active_state = action == "enable"
        for inv in invites:
            inv.is_active = active_state

    db.session.commit()

    return (
        jsonify(
            {
                "data": {
                    "success": True,
                    "processed_ids": [inv.id for inv in invites],
                    "action": action,
                },
                "meta": {"request_id": request_id},
            }
        ),
        200,
    )
