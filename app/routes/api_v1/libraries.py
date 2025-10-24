
from uuid import uuid4

from flask import jsonify, request, current_app
from flask_login import login_required

from app.routes.api_v1 import bp
from app.utils.helpers import permission_required
from app.models_media_services import MediaLibrary, MediaServer
from app.extensions import db
from datetime import datetime


def _serialize_library(library, include_server=False):
    """Serialize a MediaLibrary object to JSON"""
    data = {
        'id': library.id,
        'internal_id': library.internal_id,
        'external_id': library.external_id,
        'name': library.name,
        'library_type': library.library_type,
        'item_count': library.item_count,
        'last_scanned': library.last_scanned.isoformat() if library.last_scanned else None,
        'server_id': library.server_id,
        'created_at': library.created_at.isoformat() if library.created_at else None,
        'updated_at': library.updated_at.isoformat() if library.updated_at else None
    }

    if include_server and library.server:
        data['server'] = {
            'id': library.server.id,
            'server_nickname': library.server.server_nickname,
            'server_name': library.server.server_name,
            'service_type': library.server.service_type.value
        }

    return data


@bp.route('/libraries', methods=['GET'])
@login_required
@permission_required('view_servers')
def list_libraries():
    """List all libraries with optional filtering"""
    request_id = str(uuid4())

    # Get query parameters
    server_id = request.args.get('server_id', type=int)
    library_type = request.args.get('library_type')
    search = request.args.get('search', '').strip()
    include_server = request.args.get('include_server', 'false').lower() == 'true'

    # Build query
    query = MediaLibrary.query

    if server_id:
        query = query.filter_by(server_id=server_id)

    if library_type:
        query = query.filter_by(library_type=library_type)

    if search:
        query = query.filter(MediaLibrary.name.ilike(f'%{search}%'))

    # Order by server and name
    query = query.join(MediaServer).order_by(MediaServer.server_nickname, MediaLibrary.name)

    libraries = query.all()

    return jsonify({
        'data': [_serialize_library(lib, include_server) for lib in libraries],
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'filters': {
                'server_id': server_id,
                'library_type': library_type,
                'search': search,
                'include_server': include_server
            },
            'total_count': len(libraries),
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/libraries/<int:library_id>', methods=['GET'])
@login_required
@permission_required('view_servers')
def get_library(library_id):
    """Get a single library by ID"""
    request_id = str(uuid4())
    library = MediaLibrary.query.get(library_id)

    if not library:
        return jsonify({
            'error': {
                'code': 'LIBRARY_NOT_FOUND',
                'message': f'Library with ID {library_id} not found',
                'details': {'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    include_server = request.args.get('include_server', 'true').lower() == 'true'
    include_items_count = request.args.get('include_items_count', 'false').lower() == 'true'

    data = _serialize_library(library, include_server)

    if include_items_count:
        # Count media items in this library
        from app.models_media_services import MediaItem
        items_count = MediaItem.query.filter_by(library_id=library_id).count()
        data['media_items_count'] = items_count

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/libraries/<int:library_id>/media', methods=['GET'])
@login_required
@permission_required('view_servers')
def list_library_media(library_id):
    """List media items in a library with pagination and search"""
    request_id = str(uuid4())
    library = MediaLibrary.query.get(library_id)

    if not library:
        return jsonify({
            'error': {
                'code': 'LIBRARY_NOT_FOUND',
                'message': f'Library with ID {library_id} not found',
                'details': {'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    from app.models_media_services import MediaItem

    # Pagination parameters
    page = request.args.get('page', 1, type=int)
    page_size = request.args.get('page_size', 25, type=int)
    page_size = min(page_size, 100)  # Max 100 items per page

    # Search/filter parameters
    search = request.args.get('search', '').strip()
    item_type = request.args.get('item_type')
    sort_by = request.args.get('sort_by', 'title_asc')

    current_app.logger.debug(f"GET /libraries/{library_id}/media - sort_by={sort_by}, page={page}, search='{search}'")

    # Build query - exclude episodes as they belong to shows
    query = MediaItem.query.filter_by(library_id=library_id).filter(MediaItem.item_type != 'episode')

    if search:
        query = query.filter(MediaItem.title.ilike(f'%{search}%'))

    if item_type:
        query = query.filter_by(item_type=item_type)

    # Apply sorting (but not for total_streams - we'll sort that after calculating counts)
    if sort_by.startswith('total_streams'):
        # Don't sort in DB query, we'll sort after adding stream counts
        query = query.order_by(MediaItem.title.asc())
    elif sort_by == 'title_desc':
        query = query.order_by(MediaItem.sort_title.desc().nullslast(), MediaItem.title.desc())
    elif sort_by == 'year_asc':
        query = query.order_by(MediaItem.year.asc().nullslast(), MediaItem.title.asc())
    elif sort_by == 'year_desc':
        query = query.order_by(MediaItem.year.desc().nullslast(), MediaItem.title.asc())
    else:  # default title_asc
        query = query.order_by(MediaItem.sort_title.asc().nullsfirst(), MediaItem.title.asc())

    # Get total count for pagination
    total_items = query.count()
    total_pages = (total_items + page_size - 1) // page_size

    # For stream sorting, we need ALL items to properly paginate after sorting
    # For other sorts, we can paginate in the DB
    if sort_by.startswith('total_streams'):
        # Get all items (no pagination yet)
        current_app.logger.debug(f"Fetching ALL items for stream sorting (total: {total_items})")
        items = query.all()
        current_app.logger.debug(f"Fetched {len(items)} items")
    else:
        # Paginate normally
        items = query.offset((page - 1) * page_size).limit(page_size).all()

    # Add stream counts to items
    from app.models_media_services import MediaStreamHistory
    items_data = []
    for item in items:
        item_dict = item.to_dict()

        # Calculate stream count from history
        if item.item_type and item.item_type.lower() in ['show', 'series', 'tv']:
            # For TV shows, count all episodes of the show by matching grandparent_title
            from sqlalchemy import func

            # Debug: Log what we're searching for
            current_app.logger.debug(f"Counting streams for TV show: '{item.title}' (type: {item.item_type})")

            # Try case-insensitive match (more reliable)
            stream_count = MediaStreamHistory.query.filter(
                MediaStreamHistory.server_id == item.server_id,
                func.lower(MediaStreamHistory.grandparent_title) == func.lower(item.title)
            ).count()

            current_app.logger.debug(f"Found {stream_count} streams for '{item.title}'")
        else:
            # For movies and other content, count direct matches
            stream_count = MediaStreamHistory.query.filter(
                MediaStreamHistory.server_id == item.server_id,
                MediaStreamHistory.media_title == item.title
            ).count()

            # If no exact match, try case-insensitive match
            if stream_count == 0:
                from sqlalchemy import func
                stream_count = MediaStreamHistory.query.filter(
                    MediaStreamHistory.server_id == item.server_id,
                    func.lower(MediaStreamHistory.media_title) == func.lower(item.title)
                ).count()

        item_dict['stream_count'] = stream_count
        items_data.append(item_dict)

    # Sort by stream count if requested (now that we have the counts)
    if sort_by == 'total_streams_desc':
        items_data.sort(key=lambda x: x.get('stream_count', 0), reverse=True)
    elif sort_by == 'total_streams_asc':
        items_data.sort(key=lambda x: x.get('stream_count', 0), reverse=False)

    # Paginate stream-sorted results
    if sort_by.startswith('total_streams'):
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        items_data = items_data[start_idx:end_idx]

    return jsonify({
        'data': items_data,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'pagination': {
                'page': page,
                'page_size': page_size,
                'total_items': total_items,
                'total_pages': total_pages
            },
            'filters': {
                'search': search,
                'item_type': item_type,
                'sort_by': sort_by
            },
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/libraries/<int:library_id>/media/<int:media_id>', methods=['GET'])
@login_required
@permission_required('view_servers')
def get_media_item(library_id, media_id):
    """Get a single media item by ID with full details"""
    request_id = str(uuid4())

    from app.models_media_services import MediaItem

    # Get the media item and verify it belongs to the specified library
    media_item = MediaItem.query.filter_by(id=media_id, library_id=library_id).first()

    if not media_item:
        return jsonify({
            'error': {
                'code': 'MEDIA_NOT_FOUND',
                'message': f'Media item with ID {media_id} not found in library {library_id}',
                'details': {'media_id': media_id, 'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    # Get library and server info
    library = MediaLibrary.query.get(library_id)
    include_library = request.args.get('include_library', 'true').lower() == 'true'

    data = media_item.to_dict()

    if include_library and library:
        data['library'] = {
            'id': library.id,
            'name': library.name,
            'library_type': library.library_type,
            'server_id': library.server_id
        }

        if library.server:
            data['library']['server'] = {
                'id': library.server.id,
                'server_nickname': library.server.server_nickname,
                'server_name': library.server.server_name,
                'service_type': library.server.service_type.value
            }

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })



@bp.route('/libraries/<int:library_id>/stats', methods=['GET'])
@login_required
@permission_required('view_servers')
def get_library_stats(library_id):
    """Get statistics for a library"""
    request_id = str(uuid4())
    library = MediaLibrary.query.get(library_id)

    if not library:
        return jsonify({
            'error': {
                'code': 'LIBRARY_NOT_FOUND',
                'message': f'Library with ID {library_id} not found',
                'details': {'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    days = request.args.get('days', 30, type=int)

    from app.routes.library_modules.statistics import get_advanced_library_statistics, get_library_user_engagement_metrics
    from app.models_media_services import MediaStreamHistory
    from datetime import timedelta, timezone
    from collections import defaultdict

    stats = get_advanced_library_statistics(library, days=days)
    user_metrics = get_library_user_engagement_metrics(library, days=days)

    # Generate daily chart data
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days)

    # Get all streams for chart
    streams = MediaStreamHistory.query.filter(
        MediaStreamHistory.server_id == library.server_id,
        MediaStreamHistory.library_name == library.name,
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    ).all()

    # Group by date
    daily_data = defaultdict(lambda: {'plays': 0, 'time': 0})
    for stream in streams:
        date_key = stream.started_at.date().isoformat()
        daily_data[date_key]['plays'] += 1
        daily_data[date_key]['time'] += (stream.duration_seconds or 0) / 60  # Convert to minutes

    # Create chart data array
    chart_data = []
    current_date = start_date.date()
    end = end_date.date()
    while current_date <= end:
        date_key = current_date.isoformat()
        chart_data.append({
            'date': date_key,
            'label': current_date.strftime('%b %d'),
            'plays': daily_data[date_key]['plays'],
            'time': round(daily_data[date_key]['time'], 1)
        })
        current_date += timedelta(days=1)

    return jsonify({
        'data': {
            'stats': stats,
            'user_metrics': user_metrics,
            'chart_data': chart_data
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'filters': {'days': days},
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/libraries/<int:library_id>/activity', methods=['GET'])
@login_required
@permission_required('view_servers')
def get_library_activity(library_id):
    """Get recent activity for a library"""
    request_id = str(uuid4())
    library = MediaLibrary.query.get(library_id)

    if not library:
        return jsonify({
            'error': {
                'code': 'LIBRARY_NOT_FOUND',
                'message': f'Library with ID {library_id} not found',
                'details': {'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    days = request.args.get('days', 30, type=int)
    page = request.args.get('page', 1, type=int)
    page_size = request.args.get('page_size', 50, type=int)
    page_size = min(page_size, 100)

    from app.models_media_services import MediaStreamHistory
    from datetime import timedelta, timezone

    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days)

    # Query recent streams
    query = MediaStreamHistory.query.filter(
        MediaStreamHistory.server_id == library.server_id,
        MediaStreamHistory.library_name == library.name,
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    ).order_by(MediaStreamHistory.started_at.desc())

    total_items = query.count()
    total_pages = (total_items + page_size - 1) // page_size

    streams = query.offset((page - 1) * page_size).limit(page_size).all()

    # Serialize streams
    streams_data = []
    for stream in streams:
        # Get user avatar using the same logic as get_avatar() method
        user_avatar_url = None
        if stream.user:
            user_avatar_url = stream.user.get_avatar(fallback=None)

        # Try to find the linked media item to get poster
        thumb_path = None
        media_type = None

        # Try to find the media item by matching title and library
        from app.models_media_services import MediaItem
        media_item = None

        if stream.grandparent_title:
            # This is likely a TV show episode
            media_item = MediaItem.query.filter_by(
                library_id=library.id,
                title=stream.grandparent_title
            ).first()
            media_type = 'episode'
        elif stream.media_title:
            # This is likely a movie or other content
            media_item = MediaItem.query.filter_by(
                library_id=library.id,
                title=stream.media_title
            ).first()
            if media_item and media_item.item_type:
                media_type = media_item.item_type

        if media_item and media_item.thumb_path:
            # Convert thumb_path to proper proxy URL
            if media_item.thumb_path.startswith('/admin/api/'):
                # Already a proxy URL with correct prefix
                thumb_path = media_item.thumb_path
            elif media_item.thumb_path.startswith('/api/'):
                # Legacy proxy URL without admin prefix - add it
                thumb_path = f"/admin{media_item.thumb_path}"
            elif media_item.thumb_path.startswith('http'):
                # Full URL - use as-is
                thumb_path = media_item.thumb_path
            else:
                # Plex format: regular path that needs proxy construction
                thumb_path = f"/admin/api/media/{library.server.service_type.value}/images/proxy?path={media_item.thumb_path.lstrip('/')}"

        streams_data.append({
            'id': stream.id,
            'media_title': stream.media_title,
            'grandparent_title': stream.grandparent_title,
            'parent_title': stream.parent_title,
            'media_type': media_type,
            'thumb_path': thumb_path,
            'user_display_name': stream.user.get_display_name() if stream.user else 'Unknown',
            'user_avatar_url': user_avatar_url,
            'started_at': stream.started_at.isoformat() if stream.started_at else None,
            'duration_seconds': stream.duration_seconds,
            'platform': stream.platform,
            'player': stream.player,
            'product': stream.product
        })

    return jsonify({
        'data': streams_data,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'pagination': {
                'page': page,
                'page_size': page_size,
                'total_items': total_items,
                'total_pages': total_pages
            },
            'filters': {'days': days},
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/libraries/<int:library_id>/collections', methods=['GET'])
@login_required
@permission_required('view_servers')
def get_library_collections(library_id):
    """Get collections for a Plex library"""
    request_id = str(uuid4())

    # Get library and verify it exists
    library = MediaLibrary.query.get(library_id)
    if not library:
        return jsonify({
            'error': {
                'code': 'LIBRARY_NOT_FOUND',
                'message': f'Library with ID {library_id} not found',
                'details': {'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    # Check if this is a Plex library
    if library.server.service_type.value.lower() != 'plex':
        return jsonify({
            'error': {
                'code': 'UNSUPPORTED_SERVICE',
                'message': 'Collections are only available for Plex libraries',
                'details': {'service_type': library.server.service_type.value}
            },
            'meta': {'request_id': request_id}
        }), 400

    try:
        from app.services.media_service_factory import MediaServiceFactory

        # Create Plex service instance
        service = MediaServiceFactory.create_service_from_db(library.server)
        if not service or not hasattr(service, 'get_library_collections'):
            return jsonify({
                'error': {
                    'code': 'SERVICE_UNAVAILABLE',
                    'message': 'Plex service is not available or does not support collections',
                    'details': {}
                },
                'meta': {'request_id': request_id}
            }), 503

        # Get collections using the library's external_id (UUID)
        collections_data = service.get_library_collections(library.external_id)

        if collections_data.get('success'):
            return jsonify({
                'data': {
                    'collections': collections_data.get('collections', []),
                    'library_name': collections_data.get('library_name', library.name),
                    'library_type': collections_data.get('library_type', 'unknown')
                },
                'meta': {
                    'request_id': request_id,
                    'deprecated': False,
                    'total_count': len(collections_data.get('collections', [])),
                    'generated_at': datetime.utcnow().isoformat() + 'Z'
                }
            })
        else:
            return jsonify({
                'error': {
                    'code': 'COLLECTION_FETCH_FAILED',
                    'message': collections_data.get('error', 'Failed to fetch collections'),
                    'details': {}
                },
                'meta': {'request_id': request_id}
            }), 500

    except Exception as e:
        return jsonify({
            'error': {
                'code': 'INTERNAL_ERROR',
                'message': f'Error fetching collections: {str(e)}',
                'details': {}
            },
            'meta': {'request_id': request_id}
        }), 500

@bp.route('/libraries/<int:library_id>/media/<int:media_id>/episodes', methods=['GET'])
@login_required
@permission_required('view_servers')
def get_media_episodes(library_id, media_id):
    """Get episodes for a TV show"""
    request_id = str(uuid4())

    from app.models_media_services import MediaItem

    # Get the media item and verify it's in a TV show library
    media_item = MediaItem.query.filter_by(id=media_id, library_id=library_id).first()

    if not media_item:
        return jsonify({
            'error': {
                'code': 'MEDIA_NOT_FOUND',
                'message': f'Media item with ID {media_id} not found in library {library_id}',
                'details': {'media_id': media_id, 'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    # Get library and check if it's a TV show library
    library = MediaLibrary.query.get(library_id)
    if not library:
        return jsonify({
            'error': {
                'code': 'LIBRARY_NOT_FOUND',
                'message': f'Library with ID {library_id} not found',
                'details': {'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    library_type = library.library_type.lower() if library.library_type else ''
    if library_type not in ['show', 'tv', 'series', 'tvshows']:
        return jsonify({
            'error': {
                'code': 'NOT_A_TV_SHOW_LIBRARY',
                'message': 'This library is not a TV show library',
                'details': {'library_type': library.library_type}
            },
            'meta': {'request_id': request_id}
        }), 400

    # Pagination and filter parameters
    page = request.args.get('page', 1, type=int)
    page_size = request.args.get('page_size', 24, type=int)
    page_size = min(page_size, 100)  # Max 100 items per page
    search = request.args.get('search', '').strip()
    sort_by = request.args.get('sort_by', 'season_episode_asc')

    # Build query for episodes
    from sqlalchemy import or_
    query = MediaItem.query.filter(
        MediaItem.library_id == library_id,
        MediaItem.item_type == 'episode',
        or_(
            MediaItem.parent_id == media_item.external_id,
            MediaItem.parent_id == media_item.rating_key
        )
    )

    # Apply search filter
    if search:
        search_term = f'%{search}%'
        query = query.filter(
            or_(
                MediaItem.title.ilike(search_term),
                MediaItem.summary.ilike(search_term)
            )
        )

    # Get total count before pagination
    total_items = query.count()
    total_pages = (total_items + page_size - 1) // page_size

    # For season/episode sorting or stream count sorting, we need to fetch all and sort in Python
    if sort_by.startswith('season_episode') or sort_by.startswith('total_streams'):
        # Get all episodes (no pagination yet)
        all_episodes = query.all()

        # Convert to dict
        episodes_data = [ep.to_dict() for ep in all_episodes]

        # Add stream counts for each episode
        from app.models_media_services import MediaStreamHistory
        for ep_dict in episodes_data:
            # Find the original episode object to get server_id
            ep_obj = next((e for e in all_episodes if e.id == ep_dict['id']), None)
            if ep_obj:
                # Count streams for this specific episode
                stream_count = MediaStreamHistory.query.filter(
                    MediaStreamHistory.server_id == ep_obj.server_id,
                    MediaStreamHistory.media_title == ep_obj.title
                ).count()
                ep_dict['stream_count'] = stream_count
            else:
                ep_dict['stream_count'] = 0

        # Sort based on sort_by parameter
        if sort_by.startswith('season_episode'):
            # Sort by season and episode number
            reverse = sort_by.endswith('_desc')
            def season_episode_sort_key(episode):
                season = episode.get('season_number', 0) or 0
                episode_num = episode.get('episode_number', 0) or 0
                return (season, episode_num)
            episodes_data.sort(key=season_episode_sort_key, reverse=reverse)
        elif sort_by == 'total_streams_desc':
            episodes_data.sort(key=lambda x: x.get('stream_count', 0), reverse=True)
        elif sort_by == 'total_streams_asc':
            episodes_data.sort(key=lambda x: x.get('stream_count', 0), reverse=False)

        # Now paginate the sorted data
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        episodes_data = episodes_data[start_idx:end_idx]

    else:
        # Apply database-level sorting for other fields
        if sort_by == 'title_asc':
            query = query.order_by(MediaItem.sort_title.asc())
        elif sort_by == 'title_desc':
            query = query.order_by(MediaItem.sort_title.desc())
        elif sort_by == 'year_asc':
            query = query.order_by(MediaItem.year.asc())
        elif sort_by == 'year_desc':
            query = query.order_by(MediaItem.year.desc())
        elif sort_by == 'added_at_asc':
            query = query.order_by(MediaItem.added_at.asc())
        elif sort_by == 'added_at_desc':
            query = query.order_by(MediaItem.added_at.desc())
        else:
            query = query.order_by(MediaItem.sort_title.asc())

        # Paginate
        episodes = query.offset((page - 1) * page_size).limit(page_size).all()
        episodes_data = [ep.to_dict() for ep in episodes]

    # Check if episodes need syncing
    needs_sync = False
    if media_item.last_synced:
        from datetime import timedelta
        sync_age = datetime.utcnow() - media_item.last_synced
        needs_sync = sync_age > timedelta(hours=24)
    else:
        needs_sync = True

    return jsonify({
        'data': {
            'episodes': episodes_data,
            'show_info': {
                'id': media_item.id,
                'title': media_item.title,
                'external_id': media_item.external_id,
                'rating_key': media_item.rating_key,
                'last_synced': media_item.last_synced.isoformat() if media_item.last_synced else None
            }
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'pagination': {
                'page': page,
                'page_size': page_size,
                'total_items': total_items,
                'total_pages': total_pages
            },
            'filters': {
                'search': search,
                'sort_by': sort_by
            },
            'needs_sync': needs_sync,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/libraries/<int:library_id>/media/<int:media_id>/episodes/sync', methods=['POST'])
@login_required
@permission_required('view_servers')
def sync_media_episodes(library_id, media_id):
    """Sync episodes for a TV show"""
    request_id = str(uuid4())

    from app.models_media_services import MediaItem
    from app.services.media_sync_service import MediaSyncService

    # Get the media item and verify it's in a TV show library
    media_item = MediaItem.query.filter_by(id=media_id, library_id=library_id).first()

    if not media_item:
        return jsonify({
            'error': {
                'code': 'MEDIA_NOT_FOUND',
                'message': f'Media item with ID {media_id} not found in library {library_id}',
                'details': {'media_id': media_id, 'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    # Get library and check if it's a TV show library
    library = MediaLibrary.query.get(library_id)
    if not library:
        return jsonify({
            'error': {
                'code': 'LIBRARY_NOT_FOUND',
                'message': f'Library with ID {library_id} not found',
                'details': {'library_id': library_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    library_type = library.library_type.lower() if library.library_type else ''
    if library_type not in ['show', 'tv', 'series', 'tvshows']:
        return jsonify({
            'error': {
                'code': 'NOT_A_TV_SHOW_LIBRARY',
                'message': 'This library is not a TV show library',
                'details': {'library_type': library.library_type}
            },
            'meta': {'request_id': request_id}
        }), 400

    try:
        # Trigger episode sync
        result = MediaSyncService.sync_show_episodes(media_id)

        if result['success']:
            return jsonify({
                'success': True,
                'message': f"Episodes synced for {media_item.title}",
                'result': {
                    'added': result.get('added', 0),
                    'updated': result.get('updated', 0),
                    'removed': result.get('removed', 0),
                    'total': result.get('total', 0)
                },
                'meta': {
                    'request_id': request_id,
                    'generated_at': datetime.utcnow().isoformat() + 'Z'
                }
            })
        else:
            return jsonify({
                'error': {
                    'code': 'SYNC_FAILED',
                    'message': result.get('error', 'Failed to sync episodes'),
                    'details': {}
                },
                'meta': {'request_id': request_id}
            }), 500

    except Exception as e:
        return jsonify({
            'error': {
                'code': 'INTERNAL_ERROR',
                'message': f'Error syncing episodes: {str(e)}',
                'details': {}
            },
            'meta': {'request_id': request_id}
        }), 500
