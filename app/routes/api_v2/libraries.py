from __future__ import annotations

from uuid import uuid4
from datetime import datetime, timedelta, timezone
from typing import Optional, List

from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
# JWT permission checking handled by jwt_permission_required
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
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def list_libraries(query: LibrariesQuery, current_user):
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
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def get_library(path: LibraryPath, current_user):
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
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def list_library_media(path: LibraryPath, query: LibraryMediaQuery, current_user):
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
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def get_media_item(path: MediaPath, current_user):
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
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def get_library_stats(path: LibraryPath, current_user):
    request_id = uuid4().hex
    lib = MediaLibrary.query.get(path.library_id)
    if not lib:
        return jsonify({"error": {"code": "LIBRARY_NOT_FOUND", "message": f"Library with ID {path.library_id} not found", "details": {"library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404

    days = request.args.get("days", type=int, default=30)
    from app.routes.library_modules_deprecated.statistics import get_advanced_library_statistics, get_library_user_engagement_metrics
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


# Additional library endpoints migrated from v1


class ActivityListResponse(BaseModel):
    data: list[dict]
    meta: dict


@api_v2.get(
    "/libraries/<library_id>/activity",
    tags=[libraries_tag],
    summary="Get recent activity for a library",
    responses={200: ActivityListResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def get_library_activity(path: LibraryPath, current_user):
    request_id = uuid4().hex
    library = MediaLibrary.query.get(path.library_id)
    if not library:
        return (
            jsonify(
                {
                    "error": {
                        "code": "LIBRARY_NOT_FOUND",
                        "message": f"Library with ID {path.library_id} not found",
                        "details": {"library_id": path.library_id},
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            404,
        )

    days = request.args.get("days", 30, type=int)
    page = request.args.get("page", 1, type=int)
    page_size = min(request.args.get("page_size", 50, type=int), 100)

    from app.models_media_services import MediaStreamHistory, MediaItem
    from datetime import timedelta, timezone

    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days)

    q = (
        MediaStreamHistory.query.filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date,
        )
        .order_by(MediaStreamHistory.started_at.desc())
    )
    total_items = q.count()
    total_pages = (total_items + page_size - 1) // page_size
    streams = q.offset((page - 1) * page_size).limit(page_size).all()

    streams_data: list[dict] = []
    for stream in streams:
        user_avatar_url = stream.user.get_avatar(fallback=None) if getattr(stream, "user", None) else None
        thumb_path = None
        media_type = None
        media_item = None
        if stream.grandparent_title:
            media_item = MediaItem.query.filter_by(
                library_id=library.id, title=stream.grandparent_title
            ).first()
            media_type = "episode"
        elif stream.media_title:
            media_item = MediaItem.query.filter_by(
                library_id=library.id, title=stream.media_title
            ).first()
            if media_item and getattr(media_item, "item_type", None):
                media_type = media_item.item_type
        if media_item and getattr(media_item, "thumb_path", None):
            if media_item.thumb_path.startswith("/admin/api/"):
                thumb_path = media_item.thumb_path
            elif media_item.thumb_path.startswith("/api/"):
                thumb_path = f"/admin{media_item.thumb_path}"
            elif media_item.thumb_path.startswith("http"):
                thumb_path = media_item.thumb_path
            else:
                thumb_path = f"/admin/api/v2/media/{library.server.service_type.value}/images/proxy?path={media_item.thumb_path.lstrip('/')}"

        streams_data.append(
            {
                "id": stream.id,
                "media_title": stream.media_title,
                "grandparent_title": stream.grandparent_title,
                "parent_title": stream.parent_title,
                "media_type": media_type,
                "thumb_path": thumb_path,
                "user_display_name": stream.user.get_display_name() if getattr(stream, "user", None) else "Unknown",
                "user_avatar_url": user_avatar_url,
                "started_at": stream.started_at.isoformat() if stream.started_at else None,
                "duration_seconds": stream.duration_seconds,
                "platform": stream.platform,
                "player": stream.player,
                "product": stream.product,
            }
        )

    return jsonify(
        {
            "data": streams_data,
            "meta": {
                "request_id": request_id,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total_items": total_items,
                    "total_pages": total_pages,
                },
                "filters": {"days": days},
                "generated_at": datetime.utcnow().isoformat() + "Z",
            },
        }
    )


class CollectionsResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/libraries/<library_id>/collections",
    tags=[libraries_tag],
    summary="Get collections for a Plex library",
    responses={200: CollectionsResponse, 400: ErrorResponse, 404: ErrorResponse, 503: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def get_library_collections(path: LibraryPath, current_user):
    request_id = uuid4().hex
    library = MediaLibrary.query.get(path.library_id)
    if not library:
        return (
            jsonify(
                {
                    "error": {
                        "code": "LIBRARY_NOT_FOUND",
                        "message": f"Library with ID {path.library_id} not found",
                        "details": {"library_id": path.library_id},
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            404,
        )

    if library.server.service_type.value.lower() != "plex":
        return (
            jsonify(
                {
                    "error": {
                        "code": "UNSUPPORTED_SERVICE",
                        "message": "Collections are only available for Plex libraries",
                        "details": {"service_type": library.server.service_type.value},
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            400,
        )

    try:
        from app.services.media_service_factory import MediaServiceFactory

        service = MediaServiceFactory.create_service_from_db(library.server)
        if not service or not hasattr(service, "get_library_collections"):
            return (
                jsonify(
                    {
                        "error": {
                            "code": "SERVICE_UNAVAILABLE",
                            "message": "Plex service is not available or does not support collections",
                            "details": {},
                        },
                        "meta": {"request_id": request_id},
                    }
                ),
                503,
            )

        collections_data = service.get_library_collections(library.external_id)
        if collections_data.get("success"):
            return jsonify(
                {
                    "data": {
                        "collections": collections_data.get("collections", []),
                        "library_name": collections_data.get("library_name", library.name),
                        "library_type": collections_data.get("library_type", "unknown"),
                    },
                    "meta": {
                        "request_id": request_id,
                        "total_count": len(collections_data.get("collections", [])),
                        "generated_at": datetime.utcnow().isoformat() + "Z",
                    },
                }
            )
        else:
            return (
                jsonify(
                    {
                        "error": {
                            "code": "COLLECTION_FETCH_FAILED",
                            "message": collections_data.get("error", "Failed to fetch collections"),
                            "details": {},
                        },
                        "meta": {"request_id": request_id},
                    }
                ),
                500,
            )
    except Exception as e:
        return (
            jsonify(
                {
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": f"Error fetching collections: {str(e)}",
                        "details": {},
                    },
                    "meta": {"request_id": request_id},
                }
            ),
            500,
        )


class EpisodesResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/libraries/<library_id>/media/<int:media_id>/episodes",
    tags=[libraries_tag],
    summary="List episodes for a show",
    responses={200: EpisodesResponse, 400: ErrorResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def get_media_episodes(path: MediaPath, current_user):
    request_id = uuid4().hex
    from app.models_media_services import MediaItem
    media_item = MediaItem.query.filter_by(id=path.media_id, library_id=path.library_id).first()
    if not media_item:
        return jsonify({"error": {"code": "MEDIA_NOT_FOUND", "message": f"Media item with ID {path.media_id} not found in library {path.library_id}", "details": {"media_id": path.media_id, "library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404

    library = MediaLibrary.query.get(path.library_id)
    if not library:
        return jsonify({"error": {"code": "LIBRARY_NOT_FOUND", "message": f"Library with ID {path.library_id} not found", "details": {"library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404

    library_type = (library.library_type or "").lower()
    if library_type not in ["show", "tv", "series", "tvshows"]:
        return jsonify({"error": {"code": "NOT_A_TV_SHOW_LIBRARY", "message": "This library is not a TV show library", "details": {"library_type": library.library_type}}, "meta": {"request_id": request_id}}), 400

    page = request.args.get("page", 1, type=int)
    page_size = min(request.args.get("page_size", 24, type=int), 100)
    search = (request.args.get("search", "") or "").strip()
    sort_by = request.args.get("sort_by", "season_episode_asc")

    from sqlalchemy import or_
    q = MediaItem.query.filter(
        MediaItem.library_id == path.library_id,
        MediaItem.item_type == "episode",
        or_(MediaItem.parent_id == media_item.external_id, MediaItem.parent_id == media_item.rating_key),
    )

    if search:
        search_term = f"%{search}%"
        q = q.filter(or_(MediaItem.title.ilike(search_term), MediaItem.summary.ilike(search_term)))

    total_items = q.count()
    total_pages = (total_items + page_size - 1) // page_size

    if sort_by.startswith("season_episode") or sort_by.startswith("total_streams"):
        all_eps = q.all()
        episodes_data = [ep.to_dict() for ep in all_eps]
        from app.models_media_services import MediaStreamHistory
        for ep_dict in episodes_data:
            ep_obj = next((e for e in all_eps if e.id == ep_dict.get("id")), None)
            if ep_obj:
                stream_count = (
                    MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == ep_obj.server_id,
                        MediaStreamHistory.media_title == ep_obj.title,
                    ).count()
                )
                ep_dict["stream_count"] = stream_count
            else:
                ep_dict["stream_count"] = 0
        if sort_by.startswith("season_episode"):
            reverse = sort_by.endswith("_desc")
            episodes_data.sort(
                key=lambda e: ((e.get("season_number") or 0), (e.get("episode_number") or 0)),
                reverse=reverse,
            )
        elif sort_by == "total_streams_desc":
            episodes_data.sort(key=lambda x: x.get("stream_count", 0), reverse=True)
        elif sort_by == "total_streams_asc":
            episodes_data.sort(key=lambda x: x.get("stream_count", 0), reverse=False)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        episodes_data = episodes_data[start_idx:end_idx]
    else:
        if sort_by == "title_asc":
            q = q.order_by(MediaItem.sort_title.asc())
        elif sort_by == "title_desc":
            q = q.order_by(MediaItem.sort_title.desc())
        elif sort_by == "year_asc":
            q = q.order_by(MediaItem.year.asc())
        elif sort_by == "year_desc":
            q = q.order_by(MediaItem.year.desc())
        elif sort_by == "added_at_asc":
            q = q.order_by(MediaItem.added_at.asc())
        elif sort_by == "added_at_desc":
            q = q.order_by(MediaItem.added_at.desc())
        else:
            q = q.order_by(MediaItem.sort_title.asc())
        episodes = q.offset((page - 1) * page_size).limit(page_size).all()
        episodes_data = [ep.to_dict() for ep in episodes]

    needs_sync = False
    if getattr(media_item, "last_synced", None):
        from datetime import timedelta
        sync_age = datetime.utcnow() - media_item.last_synced
        needs_sync = sync_age > timedelta(hours=24)
    else:
        needs_sync = True

    return jsonify(
        {
            "data": {
                "episodes": episodes_data,
                "show_info": {
                    "id": media_item.id,
                    "title": media_item.title,
                    "external_id": media_item.external_id,
                    "rating_key": media_item.rating_key,
                    "last_synced": media_item.last_synced.isoformat() if getattr(media_item, "last_synced", None) else None,
                },
            },
            "meta": {
                "request_id": request_id,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total_items": total_items,
                    "total_pages": total_pages,
                },
                "filters": {"search": search, "sort_by": sort_by},
                "needs_sync": needs_sync,
                "generated_at": datetime.utcnow().isoformat() + "Z",
            },
        }
    )


class SyncEpisodesResponse(BaseModel):
    success: bool
    message: str | None = None
    result: dict | None = None
    meta: dict | None = None


@api_v2.post(
    "/libraries/<library_id>/media/<int:media_id>/episodes/sync",
    tags=[libraries_tag],
    summary="Sync episodes for a show",
    responses={200: SyncEpisodesResponse, 400: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required("view_servers")
def sync_media_episodes(path: MediaPath, current_user):
    request_id = uuid4().hex
    from app.models_media_services import MediaItem
    from app.services.media_sync_service import MediaSyncService
    media_item = MediaItem.query.filter_by(id=path.media_id, library_id=path.library_id).first()
    if not media_item:
        return jsonify({"error": {"code": "MEDIA_NOT_FOUND", "message": f"Media item with ID {path.media_id} not found in library {path.library_id}", "details": {"media_id": path.media_id, "library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404
    library = MediaLibrary.query.get(path.library_id)
    if not library:
        return jsonify({"error": {"code": "LIBRARY_NOT_FOUND", "message": f"Library with ID {path.library_id} not found", "details": {"library_id": path.library_id}}, "meta": {"request_id": request_id}}), 404
    library_type = (library.library_type or "").lower()
    if library_type not in ["show", "tv", "series", "tvshows"]:
        return jsonify({"error": {"code": "NOT_A_TV_SHOW_LIBRARY", "message": "This library is not a TV show library", "details": {"library_type": library.library_type}}, "meta": {"request_id": request_id}}), 400
    try:
        result = MediaSyncService.sync_show_episodes(path.media_id)
        if result.get("success"):
            return jsonify({
                "success": True,
                "message": f"Episodes synced for {media_item.title}",
                "result": {
                    "added": result.get("added", 0),
                    "updated": result.get("updated", 0),
                    "removed": result.get("removed", 0),
                    "total": result.get("total", 0),
                },
                "meta": {"request_id": request_id},
            })
        else:
            return jsonify({"error": {"code": "SYNC_FAILED", "message": result.get("error", "Failed to sync episodes"), "details": {}}, "meta": {"request_id": request_id}}), 500
    except Exception as e:
        return jsonify({"error": {"code": "INTERNAL_ERROR", "message": f"Error syncing episodes: {str(e)}", "details": {}}, "meta": {"request_id": request_id}}), 500
