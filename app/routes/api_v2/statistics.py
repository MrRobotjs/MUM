from __future__ import annotations

from uuid import uuid4
from datetime import datetime, timezone, timedelta
from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models_media_services import MediaStreamHistory, MediaServer, ServiceType, MediaItem
from app.utils.helpers import format_duration
from sqlalchemy import func, desc


stats_tag = Tag(name="Statistics", description="Watch statistics for dashboard")


class WatchStatsQuery(BaseModel):
    days: int = Field(7)
    services: str | None = Field(None, description="Comma separated service types (plex,jellyfin,...) or empty for all")


class WatchStatsResponse(BaseModel):
    data: dict
    meta: dict


def _parse_days_param(val: int | None) -> int:
    try:
        return int(val or 7)
    except (TypeError, ValueError):
        return 7


def _parse_services_param(raw: str | None):
    if not raw:
        return []
    services = []
    for item in raw.split(','):
        trimmed = item.strip().lower()
        if trimmed:
            services.append(trimmed)
    return services


def _construct_poster_url(thumb_path, service_type):
    if not thumb_path:
        return None
    if thumb_path.startswith('/admin/api/'):
        return thumb_path
    elif thumb_path.startswith('/api/'):
        return f"/admin{thumb_path}"
    elif thumb_path.startswith('http'):
        return thumb_path
    else:
        return f"/admin/api/v2/media/{service_type}/images/proxy?path={thumb_path.lstrip('/')}"


@api_v2.get(
    "/statistics/watch",
    tags=[stats_tag],
    summary="Aggregated watch statistics",
    responses={200: WatchStatsResponse},
)
@jwt_required_with_user()
def get_watch_statistics(query: WatchStatsQuery, current_user):
    request_id = str(uuid4())
    days = _parse_days_param(query.days)
    service_filters = _parse_services_param(query.services)

    end_date = datetime.now(timezone.utc)
    if days == -1:
        earliest_stream = MediaStreamHistory.query.order_by(MediaStreamHistory.started_at.asc()).first()
        start_date = earliest_stream.started_at if earliest_stream else end_date - timedelta(days=7)
    else:
        start_date = end_date - timedelta(days=days - 1)

    base_query = MediaStreamHistory.query.filter(
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    )
    if service_filters:
        base_query = base_query.join(MediaServer, MediaStreamHistory.server_id == MediaServer.id)
        accepted = []
        for service in service_filters:
            try:
                accepted.append(ServiceType(service))
            except ValueError:
                continue
        if accepted:
            base_query = base_query.filter(MediaServer.service_type.in_(accepted))

    top_movies = base_query.filter(MediaStreamHistory.media_type.in_(['movie', 'film']))\
        .join(MediaServer, MediaStreamHistory.server_id == MediaServer.id)\
        .outerjoin(MediaItem, (MediaStreamHistory.external_media_item_id == MediaItem.external_id) & (MediaStreamHistory.server_id == MediaItem.server_id))\
        .with_entities(
            MediaStreamHistory.media_title,
            func.count(MediaStreamHistory.id).label('play_count'),
            func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration'),
            func.max(MediaItem.thumb_path).label('thumb_path'),
            func.max(MediaServer.service_type).label('service_type')
        ).group_by(MediaStreamHistory.media_title).order_by(desc('play_count')).limit(5).all()

    top_shows = base_query.filter(MediaStreamHistory.media_type.in_(['show', 'episode', 'tv', 'series']), MediaStreamHistory.grandparent_title.isnot(None))\
        .join(MediaServer, MediaStreamHistory.server_id == MediaServer.id)\
        .outerjoin(MediaItem, (MediaStreamHistory.grandparent_title == MediaItem.title) & (MediaStreamHistory.server_id == MediaItem.server_id) & (MediaItem.item_type == 'show'))\
        .with_entities(
            MediaStreamHistory.grandparent_title.label('show_title'),
            func.count(MediaStreamHistory.id).label('play_count'),
            func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration'),
            func.max(MediaItem.thumb_path).label('thumb_path'),
            func.max(MediaServer.service_type).label('service_type')
        ).group_by(MediaStreamHistory.grandparent_title).order_by(desc('play_count')).limit(5).all()

    top_platforms = base_query.with_entities(MediaStreamHistory.platform, func.count(MediaStreamHistory.id).label('play_count'), func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration'))\
        .group_by(MediaStreamHistory.platform).order_by(desc('play_count')).limit(5).all()

    total_stats = base_query.with_entities(
        func.count(MediaStreamHistory.id).label('total_plays'),
        func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration'),
        func.count(func.distinct(MediaStreamHistory.media_title)).label('unique_titles'),
        func.count(func.distinct(MediaStreamHistory.user_uuid)).label('unique_users')
    ).first()

    daily_stream_counts = base_query.with_entities(func.date(MediaStreamHistory.started_at).label('stream_date'), func.count(MediaStreamHistory.id).label('daily_count')).group_by(func.date(MediaStreamHistory.started_at)).order_by(desc('daily_count')).first()

    avg_session = base_query.with_entities(func.avg(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('avg_duration')).first()

    payload = {
        'top_movies': [{
            'title': movie.media_title or 'Unknown Movie',
            'plays': movie.play_count,
            'duration': format_duration(int(movie.total_duration or 0)),
            'poster_url': _construct_poster_url(movie.thumb_path, movie.service_type.value if movie.service_type else 'plex') if hasattr(movie, 'thumb_path') else None
        } for movie in top_movies],
        'top_shows': [{
            'title': show.show_title or 'Unknown Show',
            'plays': show.play_count,
            'duration': format_duration(int(show.total_duration or 0)),
            'poster_url': _construct_poster_url(show.thumb_path, show.service_type.value if show.service_type else 'plex') if hasattr(show, 'thumb_path') else None
        } for show in top_shows],
        'top_platforms': [{
            'name': platform.platform or 'Unknown Platform',
            'plays': platform.play_count,
            'duration': format_duration(int(platform.total_duration or 0))
        } for platform in top_platforms],
        'totals': {
            'total_plays': total_stats.total_plays if total_stats and total_stats.total_plays else 0,
            'total_duration': format_duration(int(total_stats.total_duration or 0)) if total_stats else '0 min',
            'unique_titles': total_stats.unique_titles if total_stats else 0,
            'unique_users': total_stats.unique_users if total_stats else 0,
            'avg_session_length': format_duration(int(avg_session.avg_duration or 0)) if avg_session and avg_session.avg_duration else '0 min',
            'peak_day_streams': daily_stream_counts.daily_count if daily_stream_counts else 0
        },
        'filters': {'days': days, 'services': service_filters}
    }

    response = {'data': payload, 'meta': {'request_id': request_id, 'generated_at': datetime.utcnow().isoformat() + 'Z', 'deprecated': False}}
    return jsonify(response), 200
