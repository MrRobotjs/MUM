from __future__ import annotations

from uuid import uuid4
from datetime import datetime, timedelta, timezone
from typing import Optional, List

from flask import jsonify, request
from flask_login import login_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.utils.helpers import permission_required
from app.models_media_services import MediaLibrary, MediaServer


libraries_tag = Tag(name="Libraries", description="Media libraries and items")


class LibraryRef(BaseModel):
    id: int
    internal_id: Optional[str] = None
    external_id: Optional[str] = None
    name: Optional[str] = None
    library_type: Optional[str] = None
    item_count: Optional[int] = None
    last_scanned: Optional[str] = None
    server_id: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    server: Optional[dict] = None


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Optional[dict] = None


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


def _serialize_library(library: MediaLibrary, include_server: bool = False) -> dict:
    data = {
        "id": library.id,
        "internal_id": library.internal_id,
        "external_id": library.external_id,
        "name": library.name,
        "library_type": library.library_type,
        "item_count": library.item_count,
        "last_scanned": library.last_scanned.isoformat() if library.last_scanned else None,
        "server_id": library.server_id,
        "created_at": library.created_at.isoformat() if library.created_at else None,
        "updated_at": library.updated_at.isoformat() if library.updated_at else None,
    }
    if include_server and library.server:
        data["server"] = {
            "id": library.server.id,
            "server_nickname": library.server.server_nickname,
            "server_name": library.server.server_name,
            "service_type": library.server.service_type.value,
        }
    return data


class LibrariesQuery(BaseModel):
    server_id: Optional[int] = None
    library_type: Optional[str] = None
    search: Optional[str] = None
    include_server: bool = Field(False)


class LibrariesListResponse(BaseModel):
    data: List[LibraryRef]
    meta: dict


@api_v2.get(
    "/libraries",
    tags=[libraries_tag],
    summary="List libraries",
    responses={200: LibrariesListResponse},
)
@login_required
@permission_required("view_servers")
def list_libraries(query: LibrariesQuery):
    request_id = uuid4().hex
    q = MediaLibrary.query
    if query.server_id:
        q = q.filter_by(server_id=query.server_id)
    if query.library_type:
        q = q.filter_by(library_type=query.library_type)
    if query.search:
        q = q.filter(MediaLibrary.name.ilike(f"%{query.search}%"))
    q = q.join(MediaServer).order_by(MediaServer.server_nickname, MediaLibrary.name)
    libraries = q.all()

    return jsonify(
        {
            "data": [_serialize_library(lib, query.include_server) for lib in libraries],
            "meta": {
                "request_id": request_id,
                "deprecated": False,
                "filters": {
                    "server_id": query.server_id,
                    "library_type": query.library_type,
                    "search": query.search,
                    "include_server": query.include_server,
                },
                "total_count": len(libraries),
                "generated_at": datetime.utcnow().isoformat() + "Z",
            },
        }
    )


class LibraryPath(BaseModel):
    library_id: int


class LibraryResponse(BaseModel):
    data: LibraryRef
    meta: dict


@api_v2.get(
    "/libraries/<library_id>",
    tags=[libraries_tag],
    summary="Get library",
    responses={200: LibraryResponse, 404: ErrorResponse},
)
@login_required
@permission_required("view_servers")
def get_library(path: LibraryPath):
    request_id = uuid4().hex
    lib = MediaLibrary.query.get(path.library_id)
    if not lib:
        return jsonify({"error": {"code": "LIBRARY_NOT_FOUND", "message": f"Library with ID {path.library_id} not found", "details": {"library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404

    include_server = (request.args.get("include_server", "true").lower() == "true")
    include_items_count = (request.args.get("include_items_count", "false").lower() == "true")
    data = _serialize_library(lib, include_server)
    if include_items_count:
        from app.models_media_services import MediaItem
        count = MediaItem.query.filter_by(library_id=path.library_id).count()
        data["media_items_count"] = count

    return jsonify({"data": data, "meta": {"request_id": request_id, "deprecated": False, "generated_at": datetime.utcnow().isoformat() + "Z"}})


class LibraryMediaQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    search: Optional[str] = None
    item_type: Optional[str] = Field(None, description="movie|show|season|episode|album|track|book|comic|audiobook|game")
    sort_by: Optional[str] = Field(None, description="title_asc|title_desc|added_desc|added_asc|total_streams_desc|total_streams_asc")


class MediaItemRef(BaseModel):
    id: int
    library_id: int
    title: Optional[str] = None
    item_type: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    stream_count: Optional[int] = None


class LibraryMediaResponse(BaseModel):
    data: List[dict]
    meta: dict


@api_v2.get(
    "/libraries/<library_id>/media",
    tags=[libraries_tag],
    summary="List media items for a library",
    responses={200: LibraryMediaResponse, 404: ErrorResponse},
)
@login_required
@permission_required("view_servers")
def list_library_media(path: LibraryPath, query: LibraryMediaQuery):
    request_id = uuid4().hex
    lib = MediaLibrary.query.get(path.library_id)
    if not lib:
        return jsonify({"error": {"code": "LIBRARY_NOT_FOUND", "message": f"Library with ID {path.library_id} not found", "details": {"library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404

    from app.models_media_services import MediaItem, MediaStreamHistory
    q = MediaItem.query.filter_by(library_id=path.library_id)
    if query.search:
        q = q.filter(MediaItem.title.ilike(f"%{query.search}%"))
    if query.item_type:
        q = q.filter(MediaItem.item_type == query.item_type)

    # Sorting by title/added
    sort = (query.sort_by or "").lower()
    if sort == "title_asc":
        q = q.order_by(MediaItem.title.asc())
    elif sort == "title_desc":
        q = q.order_by(MediaItem.title.desc())
    elif sort == "added_asc":
        q = q.order_by(MediaItem.created_at.asc())
    else:  # added_desc default
        q = q.order_by(MediaItem.created_at.desc())

    # Pagination first
    page = query.page
    page_size = query.page_size
    pagination = q.paginate(page=page, per_page=page_size, error_out=False)
    items = pagination.items

    items_data = [item.to_dict() for item in items]

    # Optional stream count sort: compute counts for current page items
    if sort in {"total_streams_desc", "total_streams_asc"}:
        ids = [i.id for i in items]
        counts = (
            MediaStreamHistory.query
            .filter(MediaStreamHistory.library_name == lib.name, MediaStreamHistory.server_id == lib.server_id)
            .with_entities(MediaStreamHistory.media_item_id, func.count(MediaStreamHistory.id))
            .group_by(MediaStreamHistory.media_item_id)
            .all()
        )
        count_map = {mid: cnt for mid, cnt in counts}
        for d in items_data:
            d["stream_count"] = count_map.get(d.get("id"), 0)
        items_data.sort(key=lambda x: x.get("stream_count", 0), reverse=(sort == "total_streams_desc"))

    return jsonify(
        {
            "data": items_data,
            "meta": {
                "request_id": request_id,
                "deprecated": False,
                "pagination": {
                    "page": pagination.page,
                    "page_size": pagination.per_page,
                    "total_items": pagination.total,
                    "total_pages": pagination.pages or 1,
                },
                "filters": {"search": query.search, "item_type": query.item_type, "sort_by": query.sort_by},
                "generated_at": datetime.utcnow().isoformat() + "Z",
            },
        }
    )


class MediaPath(BaseModel):
    library_id: int
    media_id: int


class MediaItemResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/libraries/<library_id>/media/<media_id>",
    tags=[libraries_tag],
    summary="Get a media item",
    responses={200: MediaItemResponse, 404: ErrorResponse},
)
@login_required
@permission_required("view_servers")
def get_media_item(path: MediaPath):
    request_id = uuid4().hex
    from app.models_media_services import MediaItem
    media_item = MediaItem.query.filter_by(id=path.media_id, library_id=path.library_id).first()
    if not media_item:
        return jsonify({"error": {"code": "MEDIA_NOT_FOUND", "message": f"Media item with ID {path.media_id} not found in library {path.library_id}", "details": {"media_id": path.media_id, "library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404

    data = media_item.to_dict()
    lib = MediaLibrary.query.get(path.library_id)
    include_library = (request.args.get("include_library", "true").lower() == "true")
    if include_library and lib:
        data["library"] = {"id": lib.id, "name": lib.name, "library_type": lib.library_type, "server_id": lib.server_id}
        if lib.server:
            data["library"]["server"] = {
                "id": lib.server.id,
                "server_nickname": lib.server.server_nickname,
                "server_name": lib.server.server_name,
                "service_type": lib.server.service_type.value,
            }

    return jsonify({"data": data, "meta": {"request_id": request_id, "deprecated": False, "generated_at": datetime.utcnow().isoformat() + "Z"}})


class LibraryStatsResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/libraries/<library_id>/stats",
    tags=[libraries_tag],
    summary="Get library statistics",
    responses={200: LibraryStatsResponse, 404: ErrorResponse},
)
@login_required
@permission_required("view_servers")
def get_library_stats(path: LibraryPath):
    request_id = uuid4().hex
    lib = MediaLibrary.query.get(path.library_id)
    if not lib:
        return jsonify({"error": {"code": "LIBRARY_NOT_FOUND", "message": f"Library with ID {path.library_id} not found", "details": {"library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404

    days = request.args.get("days", type=int, default=30)
    from app.routes.library_modules.statistics import get_advanced_library_statistics, get_library_user_engagement_metrics
    stats = get_advanced_library_statistics(lib, days=days)
    user_metrics = get_library_user_engagement_metrics(lib, days=days)

    # Build daily chart data
    from app.models_media_services import MediaStreamHistory
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days)
    streams = MediaStreamHistory.query.filter(
        MediaStreamHistory.server_id == lib.server_id,
        MediaStreamHistory.library_name == lib.name,
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date,
    ).all()
    daily = {}
    for s in streams:
        day = s.started_at.date().isoformat() if s.started_at else None
        if not day:
            continue
        daily[day] = daily.get(day, 0) + 1

    chart = [{"date": k, "count": v} for k, v in sorted(daily.items())]
    return jsonify(
        {
            "data": {"stats": stats, "user_metrics": user_metrics, "daily": chart},
            "meta": {"request_id": request_id},
        }
    )

