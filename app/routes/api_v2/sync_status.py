from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2

# Reuse status accessor from v1 implementation
from app.routes.api_v1.sync_status import get_sync_status


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

