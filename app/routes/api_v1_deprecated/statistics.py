from uuid import uuid4
from datetime import datetime, timezone, timedelta

from flask import jsonify, request
from flask_login import login_required
from sqlalchemy import func, desc

from app.routes.api_v1_deprecated import bp
from app.models_media_services import MediaStreamHistory, MediaServer, ServiceType, MediaItem
from app.utils.helpers import format_duration


def _parse_days_param():
    try:
        return int(request.args.get('days', 7))
    except (TypeError, ValueError):
        return 7


def _parse_services_param():
    raw = request.args.get('services')
    if not raw:
        return []
    services = []
    for item in raw.split(','):
        trimmed = item.strip().lower()
        if trimmed:
            services.append(trimmed)
    return services


def _construct_poster_url(thumb_path, service_type):
    """
    Construct a poster URL from a MediaItem's thumb_path.
    Mirrors the logic in MediaItem.to_dict()
    """
    if not thumb_path:
        return None

    if thumb_path.startswith('/admin/api/'):
        # Already a proxy URL with correct prefix (Jellyfin or other services)
        return thumb_path
    elif thumb_path.startswith('/api/'):
        # Legacy proxy URL without admin prefix - add it
        return f"/admin{thumb_path}"
    elif thumb_path.startswith('http'):
        # Full URL (like RomM) - use as-is
        return thumb_path
    else:
        # Plex format: regular path that needs proxy construction
        return f"/admin/api/media/{service_type}/images/proxy?path={thumb_path.lstrip('/')}"


@bp.route('/statistics/watch', methods=['GET'])
@login_required
def get_watch_statistics():
    """
    Returns aggregated watch statistics (movies, shows, platforms, totals)
    mirroring the legacy dashboard widget.
    """
    request_id = str(uuid4())
    days = _parse_days_param()
    service_filters = _parse_services_param()

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

    # Top movies, shows, platforms
    # Join with MediaItem to get poster URLs
    # For movies: use external_media_item_id to match MediaItem.external_id
    top_movies = base_query.filter(
        MediaStreamHistory.media_type.in_(['movie', 'film'])
    ).join(
        MediaServer, MediaStreamHistory.server_id == MediaServer.id
    ).outerjoin(
        MediaItem,
        (MediaStreamHistory.external_media_item_id == MediaItem.external_id) &
        (MediaStreamHistory.server_id == MediaItem.server_id)
    ).with_entities(
        MediaStreamHistory.media_title,
        func.count(MediaStreamHistory.id).label('play_count'),
        func.sum(
            func.coalesce(
                MediaStreamHistory.duration_seconds,
                MediaStreamHistory.view_offset_at_end_seconds,
                60
            )
        ).label('total_duration'),
        func.max(MediaItem.thumb_path).label('thumb_path'),
        func.max(MediaServer.service_type).label('service_type')
    ).group_by(MediaStreamHistory.media_title).order_by(desc('play_count')).limit(5).all()

    # For shows: group by grandparent_title (show name) and find the show poster
    # We need to join with MediaItem where item_type='show' and title matches grandparent_title
    top_shows = base_query.filter(
        MediaStreamHistory.media_type.in_(['show', 'episode', 'tv', 'series']),
        MediaStreamHistory.grandparent_title.isnot(None)
    ).join(
        MediaServer, MediaStreamHistory.server_id == MediaServer.id
    ).outerjoin(
        MediaItem,
        (MediaStreamHistory.grandparent_title == MediaItem.title) &
        (MediaStreamHistory.server_id == MediaItem.server_id) &
        (MediaItem.item_type == 'show')
    ).with_entities(
        MediaStreamHistory.grandparent_title.label('show_title'),
        func.count(MediaStreamHistory.id).label('play_count'),
        func.sum(
            func.coalesce(
                MediaStreamHistory.duration_seconds,
                MediaStreamHistory.view_offset_at_end_seconds,
                60
            )
        ).label('total_duration'),
        func.max(MediaItem.thumb_path).label('thumb_path'),
        func.max(MediaServer.service_type).label('service_type')
    ).group_by(MediaStreamHistory.grandparent_title).order_by(desc('play_count')).limit(5).all()

    top_platforms = base_query.with_entities(
        MediaStreamHistory.platform,
        func.count(MediaStreamHistory.id).label('play_count'),
        func.sum(
            func.coalesce(
                MediaStreamHistory.duration_seconds,
                MediaStreamHistory.view_offset_at_end_seconds,
                60
            )
        ).label('total_duration')
    ).group_by(MediaStreamHistory.platform).order_by(desc('play_count')).limit(5).all()

    total_stats = base_query.with_entities(
        func.count(MediaStreamHistory.id).label('total_plays'),
        func.sum(
            func.coalesce(
                MediaStreamHistory.duration_seconds,
                MediaStreamHistory.view_offset_at_end_seconds,
                60
            )
        ).label('total_duration'),
        func.count(func.distinct(MediaStreamHistory.media_title)).label('unique_titles'),
        func.count(func.distinct(MediaStreamHistory.user_uuid)).label('unique_users')
    ).first()

    daily_stream_counts = base_query.with_entities(
        func.date(MediaStreamHistory.started_at).label('stream_date'),
        func.count(MediaStreamHistory.id).label('daily_count')
    ).group_by(func.date(MediaStreamHistory.started_at)).order_by(desc('daily_count')).first()

    avg_session = base_query.with_entities(
        func.avg(
            func.coalesce(
                MediaStreamHistory.duration_seconds,
                MediaStreamHistory.view_offset_at_end_seconds,
                60
            )
        ).label('avg_duration')
    ).first()

    payload = {
        'top_movies': [
            {
                'title': movie.media_title or 'Unknown Movie',
                'plays': movie.play_count,
                'duration': format_duration(int(movie.total_duration or 0)),
                'poster_url': _construct_poster_url(
                    movie.thumb_path,
                    movie.service_type.value if movie.service_type else 'plex'
                ) if hasattr(movie, 'thumb_path') else None
            }
            for movie in top_movies
        ],
        'top_shows': [
            {
                'title': show.show_title or 'Unknown Show',
                'plays': show.play_count,
                'duration': format_duration(int(show.total_duration or 0)),
                'poster_url': _construct_poster_url(
                    show.thumb_path,
                    show.service_type.value if show.service_type else 'plex'
                ) if hasattr(show, 'thumb_path') else None
            }
            for show in top_shows
        ],
        'top_platforms': [
            {
                'name': platform.platform or 'Unknown Platform',
                'plays': platform.play_count,
                'duration': format_duration(int(platform.total_duration or 0))
            }
            for platform in top_platforms
        ],
        'totals': {
            'total_plays': total_stats.total_plays if total_stats and total_stats.total_plays else 0,
            'total_duration': format_duration(int(total_stats.total_duration or 0)) if total_stats else '0 min',
            'unique_titles': total_stats.unique_titles if total_stats else 0,
            'unique_users': total_stats.unique_users if total_stats else 0,
            'avg_session_length': format_duration(int(avg_session.avg_duration or 0)) if avg_session and avg_session.avg_duration else '0 min',
            'peak_day_streams': daily_stream_counts.daily_count if daily_stream_counts else 0
        },
        'filters': {
            'days': days,
            'services': service_filters
        }
    }

    response = {
        'data': payload,
        'meta': {
            'request_id': request_id,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'deprecated': False
        }
    }
    return jsonify(response), 200
