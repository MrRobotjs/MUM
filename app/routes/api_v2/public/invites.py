from __future__ import annotations

from uuid import uuid4

from flask import jsonify
from pydantic import BaseModel

from app.models import Invite
from . import api_v2_public, public_invite_tag


def _serialize_invite(invite: Invite):
    return {
        'token': invite.token,
        'custom_path': invite.custom_path,
        'expires_at': invite.expires_at.isoformat() if invite.expires_at else None,
        'max_uses': invite.max_uses,
        'current_uses': invite.current_uses,
        'is_active': invite.is_active,
        'grant_library_ids': invite.grant_library_ids,
        'allow_downloads': invite.allow_downloads,
    }


class InviteResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


@api_v2_public.get(
    "/public/invite/<token>",
    tags=[public_invite_tag],
    summary="Validate a public invite token or custom path",
    responses={200: InviteResponse, 404: InviteResponse},
)
def validate_public_invite_v2(token):
    request_id = str(uuid4())
    invite = Invite.query.filter((Invite.token == token) | (Invite.custom_path == token)).first()
    if not invite:
        return jsonify({'error': {'code': 'INVITE_NOT_FOUND', 'message': 'Invite not found.'}, 'meta': {'request_id': request_id}}), 404

    return jsonify({'data': _serialize_invite(invite), 'meta': {'request_id': request_id, 'deprecated': False}}), 200

