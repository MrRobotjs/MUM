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
    sort_by: Optional[str] = Field(
        None,
        description=(
            "title_asc|title_desc|"
            "added_desc|added_asc|added_at_desc|added_at_asc|"
            "year_desc|year_asc|"
            "rating_desc|rating_asc|"
            "total_streams_desc|total_streams_asc"
        ),
    )
    debug_streams: Optional[bool] = Field(False, description="Enable verbose logging for stream_count aggregation")


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
    else:
        # Default behavior: for TV libraries, exclude episodes from the top-level media grid
        lib_type = (lib.library_type or "").lower()
        if lib_type in {"show", "tv", "series", "tvshows"}:
            q = q.filter(MediaItem.item_type != "episode")

    # Sorting by title/added/year/rating (supports added_at_* aliases)
    sort = (query.sort_by or "").lower()
    if sort == "title_asc":
        q = q.order_by(MediaItem.title.asc())
    elif sort == "title_desc":
        q = q.order_by(MediaItem.title.desc())
    elif sort in {"added_asc", "added_at_asc"}:
        q = q.order_by(MediaItem.created_at.asc())
    elif sort == "year_asc":
        q = q.order_by(MediaItem.year.asc())
    elif sort == "year_desc":
        q = q.order_by(MediaItem.year.desc())
    elif sort == "rating_desc":
        q = q.order_by(MediaItem.rating.desc())
    elif sort == "rating_asc":
        q = q.order_by(MediaItem.rating.asc())
    else:  # added_desc default (supports added_at_desc alias)
        q = q.order_by(MediaItem.created_at.desc())

    # Pagination first
    page = query.page
    page_size = query.page_size
    pagination = q.paginate(page=page, per_page=page_size, error_out=False)
    items = pagination.items

    items_data = [item.to_dict() for item in items]

    # Compute stream counts for current page items. For TV libraries, sum episode streams per show.
    try:
        from flask import current_app
        lib_type = (lib.library_type or "").lower()
        from sqlalchemy import func, or_
        # Temporarily force debug logging for stream aggregation
        dbg = True
        if dbg:
            current_app.logger.info(
                f"[v2.media] library_id={path.library_id} type={lib_type} items_on_page={len(items)} sort={sort}"
            )
        if lib_type in {"show", "tv", "series", "tvshows"}:
            # Map each show's identifiers (external_id and rating_key) to its id
            parent_to_show: dict[str, int] = {}
            for show in items:
                # Only for shows
                if getattr(show, "item_type", None) == "show":
                    if getattr(show, "external_id", None):
                        parent_to_show[str(show.external_id)] = show.id
                    if getattr(show, "rating_key", None):
                        parent_to_show[str(show.rating_key)] = show.id

            if dbg:
                current_app.logger.info(
                    f"[v2.media] shows_on_page={len(parent_to_show)} show_ids_page={list(parent_to_show.values())}"
                )

            if parent_to_show:
                # Fetch episodes that belong to these shows by parent_id
                from app.models_media_services import MediaItem as _MediaItem
                eps = (
                    _MediaItem.query
                    .with_entities(_MediaItem.parent_id, _MediaItem.rating_key, _MediaItem.external_id)
                    .filter(
                        _MediaItem.library_id == path.library_id,
                        _MediaItem.item_type == "episode",
                        _MediaItem.parent_id.in_(list(parent_to_show.keys())),
                    )
                    .all()
                )
                # Map episode rating_key -> show_id
                ep_key_to_show: dict[str, int] = {}
                ep_idents: list[str] = []
                for parent_id, ep_rating_key, ep_external_id in eps:
                    ep_key = None
                    if ep_rating_key:
                        ep_key = str(ep_rating_key)
                    elif ep_external_id:
                        ep_key = str(ep_external_id)
                    if not ep_key:
                        continue
                    show_id = parent_to_show.get(str(parent_id))
                    if show_id:
                        ep_key_to_show[ep_key] = show_id
                        ep_idents.append(ep_key)

                stream_counts_by_show: dict[int, int] = {}
                if ep_idents:
                    # Count streams by episode identity (rating_key or external_media_item_id) for this library/server
                    counts = (
                        MediaStreamHistory.query
                        .filter(
                            MediaStreamHistory.server_id == lib.server_id,
                            or_(
                                MediaStreamHistory.rating_key.in_(ep_idents),
                                MediaStreamHistory.external_media_item_id.in_(ep_idents),
                            ),
                        )
                        .with_entities(
                            func.coalesce(
                                MediaStreamHistory.rating_key,
                                MediaStreamHistory.external_media_item_id,
                            ).label('ep_key'),
                            func.count(MediaStreamHistory.id),
                        )
                        .group_by('ep_key')
                        .all()
                    )
                    if dbg:
                        current_app.logger.info(
                            f"[v2.media] ep_map={len(ep_key_to_show)} ep_idents={len(ep_idents)} counts_rows={len(counts)}"
                        )
                    for key, cnt in counts:
                        show_id = ep_key_to_show.get(str(key))
                        if show_id:
                            stream_counts_by_show[show_id] = stream_counts_by_show.get(show_id, 0) + int(cnt)

                # Fallback: If no counts found, aggregate by grandparent_title (show title)
                if not stream_counts_by_show:
                    show_titles = [getattr(s, 'title', None) for s in items if getattr(s, 'item_type', None) == 'show']
                    show_title_to_id = {getattr(s, 'title'): s.id for s in items if getattr(s, 'item_type', None) == 'show'}
                    if show_titles:
                        title_counts = (
                            MediaStreamHistory.query
                            .filter(
                                MediaStreamHistory.server_id == lib.server_id,
                                MediaStreamHistory.grandparent_title.in_(show_titles),
                            )
                            .with_entities(MediaStreamHistory.grandparent_title, func.count(MediaStreamHistory.id))
                            .group_by(MediaStreamHistory.grandparent_title)
                            .all()
                        )
                        for gp_title, cnt in title_counts:
                            sid = show_title_to_id.get(gp_title)
                            if sid:
                                stream_counts_by_show[sid] = int(cnt)
                        if dbg:
                            current_app.logger.info(
                                f"[v2.media] title_fallback_rows={len(title_counts)}"
                            )

                # If some shows still have 0, try per-show fallback using episode titles/ids
                # Track strategy usage per show for diagnostics
                show_strategy: dict[int, str] = {sid: 'none' for sid in parent_to_show.values()}
                for sid, cnt in stream_counts_by_show.items():
                    if cnt > 0:
                        show_strategy[sid] = 'identifiers'
                if dbg:
                    current_app.logger.info(
                        f"[v2.media] pre_fallback_zero_shows={[sid for sid in parent_to_show.values() if stream_counts_by_show.get(sid,0)==0]}"
                    )
                if parent_to_show:
                    from app.models_media_services import MediaItem as _MediaItem
                    for show in items:
                        if getattr(show, "item_type", None) != "show":
                            continue
                        sid = show.id
                        if stream_counts_by_show.get(sid, 0) > 0:
                            continue
                        # Collect this show's episode identifiers and titles
                        parent_keys = []
                        if getattr(show, "external_id", None):
                            parent_keys.append(str(show.external_id))
                        if getattr(show, "rating_key", None):
                            parent_keys.append(str(show.rating_key))
                        if not parent_keys:
                            continue
                        eps_for_show = (
                            _MediaItem.query
                            .with_entities(_MediaItem.rating_key, _MediaItem.external_id, _MediaItem.title)
                            .filter(
                                _MediaItem.library_id == path.library_id,
                                _MediaItem.item_type == "episode",
                                _MediaItem.parent_id.in_(parent_keys),
                            )
                            .all()
                        )
                        rk_list = [str(rk) for rk, ext, _ in eps_for_show if rk]
                        ext_list = [str(ext) for rk, ext, _ in eps_for_show if ext]
                        title_list = [t for _, _, t in eps_for_show if t]
                        if not (rk_list or ext_list or title_list):
                            continue
                        # Count streams for this show's episodes by any identifier or title
                        sub_counts = (
                            MediaStreamHistory.query
                            .filter(
                                MediaStreamHistory.server_id == lib.server_id,
                                or_(
                                    MediaStreamHistory.rating_key.in_(rk_list) if rk_list else False,
                                    MediaStreamHistory.external_media_item_id.in_(ext_list) if ext_list else False,
                                    MediaStreamHistory.media_title.in_(title_list) if title_list else False,
                                ),
                            )
                            .with_entities(func.count(MediaStreamHistory.id))
                            .scalar()
                        )
                        stream_counts_by_show[sid] = int(sub_counts or 0)
                        if stream_counts_by_show[sid] > 0 and show_strategy.get(sid) == 'none':
                            show_strategy[sid] = 'per_show'
                        if dbg:
                            current_app.logger.info(
                                f"[v2.media] per_show_fallback id={sid} title={getattr(show,'title',None)} eps={len(eps_for_show)} rk={len(rk_list)} ext={len(ext_list)} titles={len(title_list)} count={stream_counts_by_show[sid]}"
                            )

                # Attach stream_count to items_data
                for d in items_data:
                    if d.get("type") == "show":
                        d["stream_count"] = int(stream_counts_by_show.get(d.get("id"), 0))
                if dbg:
                    strat_counts = {'identifiers': 0, 'title': 0, 'per_show': 0, 'none': 0}
                    for sid in parent_to_show.values():
                        s = show_strategy.get(sid, 'none')
                        strat_counts[s] = strat_counts.get(s, 0) + 1
                    current_app.logger.info(f"[v2.media] strategy_counts={strat_counts}")
                if dbg:
                    sample = [
                        {"id": d.get("id"), "stream_count": d.get("stream_count", 0)}
                        for d in items_data if d.get("type") == "show"
                    ]
                    current_app.logger.info(f"[v2.media] show_stream_counts_page={sample}")
        else:
            # Non-TV libraries: count by item rating_key for current items
            idents = []
            for i in items:
                rk = getattr(i, "rating_key", None)
                if rk:
                    idents.append(str(rk))
                else:
                    ext = getattr(i, "external_id", None)
                    if ext:
                        idents.append(str(ext))
            if idents:
                counts = (
                    MediaStreamHistory.query
                    .filter(
                        MediaStreamHistory.server_id == lib.server_id,
                        or_(
                            MediaStreamHistory.rating_key.in_(idents),
                            MediaStreamHistory.external_media_item_id.in_(idents),
                        ),
                    )
                    .with_entities(MediaStreamHistory.rating_key, func.count(MediaStreamHistory.id))
                    .group_by(MediaStreamHistory.rating_key)
                    .all()
                )
                rk_count = {str(rk): int(cnt) for rk, cnt in counts}
                for d, i in zip(items_data, items):
                    rk = getattr(i, "rating_key", None)
                    ext = getattr(i, "external_id", None)
                    key = str(rk) if rk else (str(ext) if ext else None)
                    if key is not None:
                        d["stream_count"] = rk_count.get(key, 0)

        # If sorting by total streams, sort items_data accordingly
        if sort in {"total_streams_desc", "total_streams_asc"}:
            items_data.sort(key=lambda x: x.get("stream_count", 0), reverse=(sort == "total_streams_desc"))
    except Exception:
        # Best-effort; if counting fails, continue without stream_count
        pass

    # Debug: log which items have stream_count > 0
    if dbg:
        from flask import current_app
        nonzero = [
            {"id": d.get("id"), "title": d.get("title"), "stream_count": d.get("stream_count", 0)}
            for d in items_data if d.get("stream_count", 0) > 0
        ]
        current_app.logger.info(f"[v2.media] nonzero_stream_items={nonzero}")

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
