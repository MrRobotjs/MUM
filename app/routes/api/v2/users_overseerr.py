from __future__ import annotations

from uuid import uuid4
from typing import Optional, List

from flask import jsonify, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import User, UserType
from app.models_overseerr import OverseerrUserLink
from app.services.overseerr_service import OverseerrService
from app.models_media_services import MediaServer


users_tag = Tag(name="Users", description="User management endpoints")


class UserPath(BaseModel):
    uuid: str = Field(..., description="User UUID")


class OverseerrLinkItem(BaseModel):
    server_id: int
    server_name: Optional[str] = None
    overseerr_user_id: Optional[int] = None
    overseerr_username: Optional[str] = None
    overseerr_email: Optional[str] = None
    is_linked: bool
    last_sync_at: Optional[str] = None


class ListResponse(BaseModel):
    data: List[OverseerrLinkItem]
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict | None = None


def _serialize_overseerr_link(link: OverseerrUserLink) -> dict:
    return {
        "server_id": link.server_id,
        "server_name": link.server.server_nickname if getattr(link, "server", None) else None,
        "overseerr_user_id": link.overseerr_user_id,
        "overseerr_username": link.overseerr_username,
        "overseerr_email": link.overseerr_email,
        "is_linked": bool(getattr(link, "is_linked", False)),
        "last_sync_at": link.last_sync_at.isoformat() if getattr(link, "last_sync_at", None) else None,
        "requests": [],
        "requests_pagination": None,
        "request_error": None,
    }


@api_v2.get(
    "/users/<uuid>/overseerr",
    tags=[users_tag],
    summary="Get Overseerr link info for a user",
    responses={200: ListResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
def get_user_overseerr(path: UserPath, current_user):
    request_id = uuid4().hex
    current_app.logger.info("OVERSEERR v2: request start user_param=%s", path.uuid)
    user = User.query.filter_by(uuid=path.uuid).first()
    if not user:
        current_app.logger.warning("OVERSEERR v2: user not found for uuid=%s", path.uuid)
        return jsonify({"error": {"code": "NOT_FOUND", "message": "User not found"}, "meta": {"request_id": request_id}}), 404

    # For service accounts, prefer linked parent; otherwise fallback to self
    target_uuid = user.linkedUserId if user.userType == UserType.SERVICE else user.uuid
    local_user = User.query.filter_by(uuid=target_uuid).first()
    if not local_user and user.userType == UserType.SERVICE:
        local_user = user
    if not local_user:
        current_app.logger.warning(
            "OVERSEERR v2: local_user not found for target_uuid=%s (userType=%s)",
            target_uuid,
            user.userType,
        )
        return jsonify({"data": [], "meta": {"request_id": request_id, "deprecated": False}}), 200

    plex_service_users = User.get_linked_users_for_local(local_user.uuid) if hasattr(User, "get_linked_users_for_local") else []
    current_app.logger.info(
        "OVERSEERR v2: user=%s local_user=%s plex_service_users=%s plex_uuid=%s plex_username=%s",
        user.uuid,
        local_user.uuid if local_user else None,
        len(plex_service_users or []),
        getattr(local_user, "plex_uuid", None),
        getattr(local_user, "plex_username", None),
    )
    plex_service_users = [
        su
        for su in (plex_service_users or [])
        if getattr(su, "server", None)
        and getattr(su.server, "service_type", None)
        and getattr(su.server.service_type, "value", None) == "plex"
        and su.external_user_id
    ]

    # If viewing a Plex service user directly, include that record explicitly
    if user.userType == UserType.SERVICE and getattr(user, "server", None) and getattr(user.server.service_type, "value", None) == "plex":
        plex_service_users.append(user)

    plex_user_ids = {su.external_user_id for su in plex_service_users}
    current_app.logger.info(
        "OVERSEERR v2: filtered plex service users=%s plex_user_ids=%s",
        len(plex_service_users),
        list(plex_user_ids),
    )

    # Try lazy link for each Plex service user we know about
    for su in plex_service_users:
        try:
            current_app.logger.info(
                "OVERSEERR v2: lazy link server_id=%s plex_user_id=%s plex_username=%s",
                getattr(su, "server_id", None),
                su.external_user_id,
                su.external_username,
            )
            OverseerrUserLink.link_single_user(
                su.server.id,
                su.external_user_id,
                su.external_username,
                su.external_email,
            )
        except Exception as e:
            current_app.logger.warning("OVERSEERR v2: lazy link failed: %s", e)

    # Fetch links for all known plex user ids for this local user
    if plex_user_ids:
        links = OverseerrUserLink.query.filter(
            OverseerrUserLink.plex_user_id.in_(plex_user_ids)
        ).all()
    else:
        links = OverseerrUserLink.query.filter_by(plex_user_id=local_user.plex_uuid).all()
    current_app.logger.info(
        "OVERSEERR v2: fetched overseerr links count=%s via=%s",
        len(links),
        "plex_user_ids" if plex_user_ids else "local_user.plex_uuid",
    )
    if len(links) == 0:
        current_app.logger.info(
            "OVERSEERR v2: no links found (local_user.plex_uuid=%s plex_user_ids=%s)",
            getattr(local_user, "plex_uuid", None),
            list(plex_user_ids),
        )
    data = []
    for l in links:
        item = _serialize_overseerr_link(l)
        server: MediaServer | None = getattr(l, "server", None)
        if (
            server
            and server.overseerr_enabled
            and server.overseerr_url
            and server.overseerr_api_key
            and l.overseerr_user_id
        ):
            try:
                current_app.logger.info(
                    "OVERSEERR v2: fetching requests server_id=%s overseerr_user_id=%s",
                    server.id,
                    l.overseerr_user_id,
                )
                overseerr = OverseerrService(server.overseerr_url, server.overseerr_api_key)
                ok, requests_list, pagination_info, message = overseerr.get_user_requests(l.overseerr_user_id, take=20, skip=0)
                if ok:
                    item["requests"] = requests_list
                    item["requests_pagination"] = pagination_info
                else:
                    current_app.logger.warning(
                        "OVERSEERR v2: request fetch failed server_id=%s overseerr_user_id=%s msg=%s",
                        server.id,
                        l.overseerr_user_id,
                        message,
                    )
                    item["request_error"] = message
            except Exception as e:
                current_app.logger.exception(
                    "OVERSEERR v2: exception fetching requests server_id=%s overseerr_user_id=%s",
                    getattr(server, "id", None),
                    l.overseerr_user_id,
                )
                item["request_error"] = str(e)
        data.append(item)
    current_app.logger.info(
        "OVERSEERR v2: response links=%s request_id=%s", len(data), request_id
    )
    return jsonify({
        "data": data,
        "meta": {
            "request_id": request_id,
            "deprecated": False,
            "debug": {
                "local_user_uuid": getattr(local_user, "uuid", None),
                "local_user_plex_uuid": getattr(local_user, "plex_uuid", None),
                "plex_service_user_count": len(plex_service_users),
                "plex_user_ids": list(plex_user_ids),
                "links_count": len(data),
            },
        },
    }), 200
