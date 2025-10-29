from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from flask_login import login_required, current_user
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.extensions import cache


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


def set_sync_status(status_data: dict):
    cache.set(SYNC_STATUS_KEY, status_data, timeout=3600)


def start_sync(total_servers: int):
    status = {
        "is_syncing": True,
        "started_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "started_by": current_user.id if getattr(current_user, "is_authenticated", False) else None,
        "started_by_username": getattr(current_user, "localUsername", None) if getattr(current_user, "is_authenticated", False) else "Unknown",
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
@login_required
def get_sync_status_endpoint():
    request_id = uuid4().hex
    status = get_sync_status() or {}
    return jsonify({"data": status, "meta": {"request_id": request_id}})
