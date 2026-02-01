from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from app.utils.jwt_decorators import jwt_required_with_user
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.extensions import cache
from app.routes.websockets import publish_channel_event
from app.services.event_normalizer import MessageType


sync_tag = Tag(name="Sync", description="Synchronization status endpoints")


class SyncStatusData(BaseModel):
    is_syncing: bool
    started_at: str | None = None
    started_by: int | None = None
    started_by_username: str | None = None
    progress: dict


class SyncStatusResponse(BaseModel):
    data: SyncStatusData
    meta: dict


SYNC_STATUS_KEY = "user_sync_status"
def get_sync_status():
    return cache.get(SYNC_STATUS_KEY) or {
        "is_syncing": False,
        "started_at": None,
        "started_by": None,
        "started_by_username": None,
        "progress": {
            "current_server": 0,
            "total_servers": 0,
            "current_server_name": None,
        },
    }


def broadcast_sync_status(status_data: dict | None = None):
    """Emit the latest sync status to websocket subscribers."""
    try:
        payload = status_data or get_sync_status()
        publish_channel_event(
            "system.sync_status",
            MessageType.TASK_PROGRESS,
            payload,
            source="system",
        )
    except Exception:
        # Avoid failing core logic if websocket broadcast fails
        pass


def set_sync_status(status_data: dict):
    cache.set(SYNC_STATUS_KEY, status_data, timeout=3600)
    broadcast_sync_status(status_data)


def start_sync(total_servers: int, actor=None):
    status = {
        "is_syncing": True,
        "started_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "started_by": getattr(actor, "id", None),
        "started_by_username": getattr(actor, "localUsername", None) or getattr(actor, "external_username", None) if actor else "Unknown",
        "progress": {
            "current_server": 0,
            "total_servers": total_servers,
            "current_server_name": None,
        },
    }
    set_sync_status(status)
    return status


def update_sync_progress(current_server: int, total_servers: int, server_name: str | None):
    status = get_sync_status()
    status["progress"] = {
        "current_server": current_server,
        "total_servers": total_servers,
        "current_server_name": server_name,
    }
    set_sync_status(status)


def end_sync():
    status = {
        "is_syncing": False,
        "started_at": None,
        "started_by": None,
        "started_by_username": None,
        "progress": {
            "current_server": 0,
            "total_servers": 0,
            "current_server_name": None,
        },
    }
    set_sync_status(status)


@api_v2.get(
    "/sync-status",
    tags=[sync_tag],
    summary="Get current sync status",
    responses={200: SyncStatusResponse},
)
@jwt_required_with_user()
def get_sync_status_endpoint(current_user):
    request_id = uuid4().hex
    status = get_sync_status() or {}
    return jsonify({"data": status, "meta": {"request_id": request_id}})
