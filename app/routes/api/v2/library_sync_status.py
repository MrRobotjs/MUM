from __future__ import annotations

from uuid import uuid4
from flask import jsonify
from pydantic import BaseModel
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.extensions import cache
from app.utils.jwt_decorators import jwt_required_with_user


library_sync_tag = Tag(name="Library Sync", description="Per-library synchronization status")


class LibraryPath(BaseModel):
  library_id: int


class LibrarySyncStatusData(BaseModel):
  is_syncing: bool
  library_id: int
  started_at: str | None = None
  started_by: int | None = None
  started_by_username: str | None = None
  progress: dict


class LibrarySyncStatusResponse(BaseModel):
  data: LibrarySyncStatusData
  meta: dict


LIB_SYNC_STATUS_KEY_PREFIX = "library_sync_status:"


def _key(library_id: int) -> str:
  return f"{LIB_SYNC_STATUS_KEY_PREFIX}{library_id}"


def get_library_sync_status(library_id: int) -> dict:
  return cache.get(_key(library_id)) or {
    "is_syncing": False,
    "library_id": library_id,
    "started_at": None,
    "started_by": None,
    "started_by_username": None,
    "progress": {
      "phase": None,
      "current_page": 0,
      "total_pages": 0,
      "total_items": 0,
      "total_fetched": 0,
      "shows_current": 0,
      "shows_total": 0,
      "episodes_current": 0,
      "episodes_total": 0,
      "message": None,
    },
  }


def _set_library_sync_status(library_id: int, status_data: dict) -> None:
  cache.set(_key(library_id), status_data, timeout=3600)


def start_library_sync(library_id: int, actor=None) -> dict:
  import datetime as _dt

  status = {
    "is_syncing": True,
    "library_id": library_id,
    "started_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
    "started_by": getattr(actor, "id", None),
    "started_by_username": (
      getattr(actor, "localUsername", None)
      or getattr(actor, "external_username", None)
      if actor
      else "Unknown"
    ),
    "progress": {
      "current_page": 0,
      "total_pages": 0,
      "total_items": 0,
      "total_fetched": 0,
      "message": None,
    },
  }
  _set_library_sync_status(library_id, status)
  return status


def update_library_sync_progress(
  library_id: int,
  *,
  phase: str | None = None,
  current_page: int | None = None,
  total_pages: int | None = None,
  total_items: int | None = None,
  total_fetched: int | None = None,
  shows_current: int | None = None,
  shows_total: int | None = None,
  episodes_current: int | None = None,
  episodes_total: int | None = None,
  message: str | None = None,
) -> None:
  status = get_library_sync_status(library_id)
  progress = status.get("progress", {})
  if phase is not None:
    progress["phase"] = phase
  if current_page is not None:
    progress["current_page"] = current_page
  if total_pages is not None:
    progress["total_pages"] = total_pages
  if total_items is not None:
    progress["total_items"] = total_items
  if total_fetched is not None:
    progress["total_fetched"] = total_fetched
  if shows_current is not None:
    progress["shows_current"] = shows_current
  if shows_total is not None:
    progress["shows_total"] = shows_total
  if episodes_current is not None:
    progress["episodes_current"] = episodes_current
  if episodes_total is not None:
    progress["episodes_total"] = episodes_total
  if message is not None:
    progress["message"] = message
  status["progress"] = progress
  status["is_syncing"] = True
  _set_library_sync_status(library_id, status)


def end_library_sync(library_id: int) -> None:
  # When finished, keep a quick summary and mark as not syncing
  status = get_library_sync_status(library_id)
  status["is_syncing"] = False
  # Do not clear progress immediately so UI can render 100%
  _set_library_sync_status(library_id, status)


@api_v2.get(
  "/libraries/<library_id>/sync-status",
  tags=[library_sync_tag],
  summary="Get current library sync status",
  responses={200: LibrarySyncStatusResponse},
)
@jwt_required_with_user()
def get_library_sync_status_endpoint(path: LibraryPath, current_user):
  request_id = uuid4().hex
  status = get_library_sync_status(path.library_id) or {}
  return jsonify({"data": status, "meta": {"request_id": request_id}})
