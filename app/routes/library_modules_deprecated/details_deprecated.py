"""DEPRECATED: SSR library/media/episode detail views (use React + v2 APIs)."""

from flask import render_template, current_app, request, abort
from flask_login import login_required, current_user
from app.utils.helpers import setup_required, permission_required, encode_url_component, decode_url_component, decode_url_component_variations, generate_url_slug, format_duration, format_media_duration
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.models_media_services import MediaLibrary, MediaServer, MediaStreamHistory
from app.models import User, UserType
from app.extensions import db
from datetime import datetime, timezone, timedelta
import urllib.parse
from .helpers import get_library_statistics, generate_library_chart_data, get_library_user_stats, get_media_details_cached_only, get_media_details, get_show_episodes_by_item, get_library_media_content
from . import libraries_bp


@libraries_bp.route('/library/<int:server_id>/<library_id>/raw-data')
@login_required
@setup_required
@permission_required('view_libraries')
def get_library_raw_data(server_id, library_id):
    """Get raw API data for a specific library"""
    try:
        # Get the server
        server = MediaServer.query.get_or_404(server_id)
        
        # Create service instance
        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return {'error': 'Could not create service instance'}, 500
        
        # Get raw libraries data (unmodified API response)
        if hasattr(service, 'get_libraries_raw'):
            # Use raw data method if available (shows true API response)
            libraries_response = service.get_libraries_raw()
            
            # Handle different response formats
            if isinstance(libraries_response, dict) and 'libraries' in libraries_response:
                # AudioBookshelf format: {"libraries": [...]}
                libraries = libraries_response['libraries']
            elif isinstance(libraries_response, list):
                # Direct array format
                libraries = libraries_response
            else:
                # Fallback
                libraries = libraries_response
            
            # For raw data, we need to match against the actual API field names
            target_library = None
            for lib in libraries:
                # Check different possible ID fields from the raw API based on service type
                lib_id = None
                if server.service_type.value.lower() == 'plex':
                    # Plex uses UUID exclusively
                    lib_uuid = lib.get('uuid')
                    current_app.logger.debug(f"Comparing Plex library UUID '{lib_uuid}' with requested ID '{library_id}' for library '{lib.get('title', 'Unknown')}'")
                    if str(lib_uuid) == str(library_id):
                        target_library = lib
                        break
                    continue
                elif server.service_type.value.lower() in ['jellyfin', 'emby']:
                    # Jellyfin/Emby use 'ItemId'
                    lib_id = lib.get('ItemId')
                elif server.service_type.value.lower() in ['kavita', 'komga', 'romm']:
                    # These services use 'id'
                    lib_id = lib.get('id')
                elif server.service_type.value.lower() == 'audiobookshelf':
                    # AudioBookshelf uses 'id'
                    lib_id = lib.get('id')
                else:
                    # Fallback - try common field names
                    lib_id = lib.get('ItemId') or lib.get('id') or lib.get('key') or lib.get('external_id')
                
                if str(lib_id) == str(library_id):
                    target_library = lib
                    break
        else:
            # Fallback to processed data for services that don't have raw method
            libraries = service.get_libraries()
            target_library = None
            for lib in libraries:
                lib_external_id = lib.get('external_id') or lib.get('id')
                if str(lib_external_id) == str(library_id):
                    target_library = lib
                    break
        
        if not target_library:
            # Debug: Log all available libraries for troubleshooting
            if server.service_type.value.lower() == 'plex':
                available_libs = []
                for lib in libraries:
                    available_libs.append({
                        'title': lib.get('title', 'Unknown'),
                        'uuid': lib.get('uuid'),
                        'key': lib.get('key')
                    })
                current_app.logger.error(f"Library with ID '{library_id}' not found. Available Plex libraries: {available_libs}")
            return {'error': f'Library with ID {library_id} not found on server'}, 404
        
        return {
            'success': True,
            'library_data': target_library,
            'server_info': {
                'name': server.server_nickname,
                'service_type': server.service_type.value,
                'url': server.url
            }
        }
        
    except Exception as e:
        current_app.logger.error(f"Error fetching raw library data: {e}")
        return {'error': str(e)}, 500


@libraries_bp.route('/library/<server_nickname>/<library_name>/<int:media_id>/<tv_show_slug>/<episode_slug>')
@login_required
@setup_required
@permission_required('view_libraries')
def episode_detail(server_nickname, library_name, media_id, tv_show_slug, episode_slug):
    """Display detailed episode information"""
    # URL decode the parameters to handle special characters
    try:
        server_nickname = urllib.parse.unquote(server_nickname)
        library_name = urllib.parse.unquote(library_name)
        tv_show_slug = urllib.parse.unquote(tv_show_slug)
        episode_slug = urllib.parse.unquote(episode_slug)
        
        # Decode URL component back to original name for lookup
        library_name_for_lookup = decode_url_component(library_name)
        tv_show_name = decode_url_component(tv_show_slug)
        episode_name = decode_url_component(episode_slug)
        
    except Exception as e:
        current_app.logger.warning(f"Error decoding URL parameters: {e}")
        abort(400)
    
    # Validate parameters
    if not server_nickname or not library_name or not media_id or not tv_show_slug or not episode_slug:
        abort(400)
    
    # Find the server by nickname
    server = MediaServer.query.filter_by(server_nickname=server_nickname).first_or_404()
    
    # Find the library by name and server - try multiple variations for library name
    library = None
    library_name_variations = decode_url_component_variations(library_name)
    
    for variation in library_name_variations:
        library = MediaLibrary.query.filter_by(
            server_id=server.id,
            name=variation
        ).first()
        if library:
            # Store the actual library name that worked
            library_name_for_lookup = variation
            break
    
    if not library:
        abort(404)
    
    # Get the TV show details by database ID
    from app.models_media_services import MediaItem
    tv_show_item = MediaItem.query.filter_by(
        id=media_id,
        library_id=library.id  # Ensure the media belongs to this library
    ).first_or_404()
    
    # Get episode details from the service
    service = MediaServiceFactory.create_service_from_db(server)
    if not service:
        abort(500)
    
    # Get episodes for the show to find the specific episode
    episode_details = None
    if hasattr(service, 'get_show_episodes'):
        # Use rating_key if available, otherwise fall back to external_id
        show_id = tv_show_item.rating_key if tv_show_item.rating_key else tv_show_item.external_id
        episodes_data = service.get_show_episodes(show_id, page=1, per_page=1000)
        if episodes_data and episodes_data.get('items'):
            for episode in episodes_data['items']:
                if generate_url_slug(episode.get('title', '')) == episode_slug:
                    episode_details = episode
                    break
    
    if not episode_details:
        abort(404)
    
    # Get streaming history for this specific episode
    streaming_history = None
    page = request.args.get('page', 1, type=int)
    days_filter = int(request.args.get('days', 30))
    
    # Calculate date range
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days_filter)
    
    # Get streaming history for this specific episode
    activity_query = MediaStreamHistory.query.filter(
        MediaStreamHistory.server_id == server.id,
        MediaStreamHistory.library_name == library_name_for_lookup,
        MediaStreamHistory.media_title == episode_details.get('title'),
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    ).order_by(MediaStreamHistory.started_at.desc())
    
    # Paginate the results
    activity_pagination = activity_query.paginate(
        page=page, per_page=20, error_out=False
    )
    
    # Enhance activity entries with user info
    for entry in activity_pagination.items:
        if entry.user_uuid:
            user = User.query.filter_by(uuid=entry.user_uuid).first()
            if user:
                entry.user_display_name = user.get_display_name()
                entry.user_type = 'service' if user.userType == UserType.SERVICE else 'local'
                entry.user_server_nickname = user.server.server_nickname if user.server else None
                entry.user_external_username = user.external_username if user.userType == UserType.SERVICE else None
                
                # Get avatar URL based on user type
                if user.userType == UserType.SERVICE:
                    entry.user_avatar_url = user.external_avatar_url
                else:
                    entry.user_avatar_url = None  # Local users don't have service avatars
            else:
                entry.user_display_name = 'Unknown User'
                entry.user_type = 'unknown'
                entry.user_avatar_url = None
                entry.user_server_nickname = None
                entry.user_external_username = None
        else:
            entry.user_display_name = 'Unknown User'
            entry.user_type = 'unknown'
            entry.user_avatar_url = None
            entry.user_server_nickname = None
            entry.user_external_username = None
    
    streaming_history = activity_pagination
    
    return render_template('library/episode_detail.html',
                         title=f"Episode: {episode_details.get('title')}",
                         episode_details=episode_details,
                         tv_show_item=tv_show_item,
                         library=library,
                         server=server,
                         streaming_history=streaming_history,
                         days_filter=days_filter)


@libraries_bp.route('/library/<server_nickname>/<library_name>/<int:media_id>')
@libraries_bp.route('/library/<server_nickname>/<library_name>/<int:media_id>/<slug>')
@login_required
@setup_required
@permission_required('view_libraries')
def media_detail(server_nickname, library_name, media_id, slug=None):
    """Display detailed media information using database ID lookup"""
    # URL decode the parameters to handle special characters
    try:
        server_nickname = urllib.parse.unquote(server_nickname)
        library_name = urllib.parse.unquote(library_name)
        
        # Decode URL component back to original name for lookup
        library_name_for_lookup = decode_url_component(library_name)
        
    except Exception as e:
        current_app.logger.warning(f"Error decoding URL parameters: {e}")
        abort(400)
    
    # Validate parameters
    if not server_nickname or not library_name or not media_id:
        abort(400)
    
    # Find the server by nickname
    server = MediaServer.query.filter_by(server_nickname=server_nickname).first_or_404()
    
    # Find the library by name and server - try multiple variations for library name
    library = None
    library_name_variations = decode_url_component_variations(library_name)
    
    for variation in library_name_variations:
        library = MediaLibrary.query.filter_by(
            server_id=server.id,
            name=variation
        ).first()
        if library:
            # Store the actual library name that worked
            library_name_for_lookup = variation
            break
    
    if not library:
        abort(404)
    
    # Get the active tab from the URL query, default to 'overview'
    tab = request.args.get('tab', 'overview')
    
    # Get media details by database ID - this is fast and reliable!
    from app.models_media_services import MediaItem
    media_item = MediaItem.query.filter_by(
        id=media_id,
        library_id=library.id  # Ensure the media belongs to this library
    ).first_or_404()
    
    # Convert database item to the expected format
    media_details = media_item.to_dict()
    content_name_for_lookup = media_item.title  # Use the actual title from database
    
    # Get episodes for TV shows
    episodes_content = None
    episodes_cached = False
    if tab == 'episodes' and library.library_type and library.library_type.lower() in ['show', 'tv', 'series', 'tvshows']:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 24, type=int)
        search_query = request.args.get('search', '').strip()
        sort_by = request.args.get('sort_by', 'season_episode_asc').strip()
        
        # Validate per_page parameter
        if per_page not in [12, 24, 48, 96]:
            per_page = 24
            
        # Validate sort_by parameter
        valid_sorts = [
            'season_episode_asc', 'season_episode_desc',
            'title_asc', 'title_desc', 'year_asc', 'year_desc', 
            'added_at_asc', 'added_at_desc',
            'total_streams_asc', 'total_streams_desc'
        ]
        if sort_by not in valid_sorts:
            sort_by = 'season_episode_asc'
        
        # Check if we have cached episodes
        from sqlalchemy import or_
        cached_episodes_count = MediaItem.query.filter(
            MediaItem.library_id == library.id,
            MediaItem.item_type == 'episode',
            or_(
                MediaItem.parent_id == media_item.external_id,
                MediaItem.parent_id == media_item.rating_key
            )
        ).count()
        
        episodes_cached = cached_episodes_count > 0
        
        # Only get episodes if we have cached data
        if episodes_cached:
            episodes_content = get_show_episodes_by_item(server, library, media_item, page, per_page, search_query, sort_by)
    
    # Get issues for comic series (Komga)
    issues_content = None
    if tab == 'issues' and library.library_type and library.library_type.lower() in ['comic', 'comics'] and server.service_type.value == 'komga':
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 24, type=int)
        sort_by = request.args.get('sort_by', 'number_asc').strip()
        
        # Validate per_page parameter
        if per_page not in [12, 24, 48, 96]:
            per_page = 24
            
        # Validate sort_by parameter
        valid_sorts = ['number_asc', 'number_desc', 'title_asc', 'title_desc', 'date_asc', 'date_desc']
        if sort_by not in valid_sorts:
            sort_by = 'number_asc'
        
        try:
            # Create service instance to get series books
            service = MediaServiceFactory.create_service_from_db(server)
            if service and hasattr(service, 'get_series_books'):
                # Use the external_id (series ID) to get books
                series_id = media_item.external_id
                current_app.logger.info(f"Fetching issues for series {series_id} from Komga")
                
                issues_data = service.get_series_books(series_id, page=page, per_page=per_page, sort_by=sort_by)
                if issues_data.get('success'):
                    issues_content = {
                        'issues': issues_data.get('items', []),
                        'pagination': issues_data.get('pagination', {}),
                        'sort_by': sort_by
                    }
                else:
                    current_app.logger.error(f"Failed to fetch issues: {issues_data.get('error', 'Unknown error')}")
                    issues_content = {'issues': [], 'pagination': {}, 'sort_by': sort_by, 'error': issues_data.get('error')}
            else:
                current_app.logger.error("Komga service does not support get_series_books method")
                issues_content = {'issues': [], 'pagination': {}, 'sort_by': sort_by, 'error': 'Service does not support book retrieval'}
        except Exception as e:
            current_app.logger.error(f"Error fetching issues for series {media_item.external_id}: {e}")
            issues_content = {'issues': [], 'pagination': {}, 'sort_by': sort_by, 'error': str(e)}
    
    # Get streaming history for this specific content
    streaming_history = None
    if tab == 'activity':
        page = request.args.get('page', 1, type=int)
        days_filter = int(request.args.get('days', 30))
        
        # Calculate date range
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days_filter)
        
        # Get streaming history for this specific content
        # For TV shows, we need to check grandparent_title (show name) instead of media_title (episode name)
        if library.library_type and library.library_type.lower() in ['show', 'tv', 'series', 'tvshows']:
            # For TV shows, filter by grandparent_title to get all episodes of the show
            activity_query = MediaStreamHistory.query.filter(
                MediaStreamHistory.server_id == server.id,
                MediaStreamHistory.library_name == library_name_for_lookup,
                MediaStreamHistory.grandparent_title == content_name_for_lookup,
                MediaStreamHistory.started_at >= start_date,
                MediaStreamHistory.started_at <= end_date
            ).order_by(MediaStreamHistory.started_at.desc())
        else:
            # For movies and other content, filter by media_title
            activity_query = MediaStreamHistory.query.filter(
                MediaStreamHistory.server_id == server.id,
                MediaStreamHistory.library_name == library_name_for_lookup,
                MediaStreamHistory.media_title == content_name_for_lookup,
                MediaStreamHistory.started_at >= start_date,
                MediaStreamHistory.started_at <= end_date
            ).order_by(MediaStreamHistory.started_at.desc())
        
        # Paginate the results
        activity_pagination = activity_query.paginate(
            page=page, per_page=20, error_out=False
        )
        
        # Enhance activity entries with user info
        for entry in activity_pagination.items:
            if entry.user_uuid:
                user = User.query.filter_by(uuid=entry.user_uuid).first()
                if user:
                    entry.user_display_name = user.get_display_name()
                    entry.user_type = 'service' if user.userType == UserType.SERVICE else 'local'
                    entry.user_server_nickname = user.server.server_nickname if user.server else None
                    entry.user_external_username = user.external_username if user.userType == UserType.SERVICE else None
                    if user.userType == UserType.SERVICE:
                        entry.user_avatar_url = user.external_avatar_url
                    else:
                        entry.user_avatar_url = None
                else:
                    entry.user_display_name = 'Unknown User'
                    entry.user_type = 'unknown'
                    entry.user_avatar_url = None
                    entry.user_server_nickname = None
                    entry.user_external_username = None
            else:
                entry.user_display_name = 'Unknown User'
                entry.user_type = 'unknown'
                entry.user_avatar_url = None
                entry.user_server_nickname = None
                entry.user_external_username = None
        
        streaming_history = activity_pagination
    
    # Check if this is an HTMX request for partial content
    if request.headers.get('HX-Request'):
        if tab == 'episodes':
            current_app.logger.info(f"HTMX EPISODES DEBUG: Rendering template with media_item.id = {media_item.id}")
            return render_template('library/_partials/episodes_content.html',
                                 episodes_content=episodes_content,
                                 episodes_cached=episodes_cached,
                                 media_details=media_details,
                                 media_item=media_item,
                                 library=library,
                                 server=server,
                                 current_sort_by=sort_by)
        elif tab == 'issues':
            return render_template('library/_partials/issues_content.html',
                                 issues_content=issues_content,
                                 media_details=media_details,
                                 library=library,
                                 server=server)
        elif tab == 'activity':
            return render_template('library/_partials/media_activity_tab.html',
                                 streaming_history=streaming_history,
                                 media_details=media_details,
                                 library=library,
                                 server=server,
                                 days_filter=days_filter)
    
    return render_template('library/media_detail.html',
                         title=f"{media_details.get('title', 'Media')} - {library.name}",
                         media_details=media_details,
                         media_item=media_item,
                         library=library,
                         server=server,
                         episodes_content=episodes_content,
                         episodes_cached=episodes_cached,
                         issues_content=issues_content,
                         streaming_history=streaming_history,
                         tab=tab,
                         active_tab=tab,
                         days_filter=request.args.get('days', 30, type=int),
                         format_media_duration=format_media_duration)


@libraries_bp.route('/library/<server_nickname>/<library_name>')
@login_required
@setup_required
@permission_required('view_libraries')
def library_detail(server_nickname, library_name):
    """Display detailed library information and statistics"""
    # URL decode the parameters to handle special characters
    try:
        server_nickname = urllib.parse.unquote(server_nickname)
        library_name = urllib.parse.unquote(library_name)
        
        # Decode URL component back to original name for lookup
        library_name_for_lookup = decode_url_component(library_name)
        
        # If the URL contains spaces or other special characters, redirect to the proper format
        from flask import redirect, url_for
        proper_library_name = encode_url_component(library_name)
        if library_name != proper_library_name:
            return redirect(url_for('libraries.library_detail', 
                                  server_nickname=server_nickname,
                                  library_name=proper_library_name,
                                  **request.args))
        
    except Exception as e:
        current_app.logger.warning(f"Error decoding URL parameters: {e}")
        abort(400)
    
    # Validate parameters
    if not server_nickname or not library_name:
        abort(400)
    
    # Find the server by nickname
    server = MediaServer.query.filter_by(server_nickname=server_nickname).first_or_404()
    
    # Find the library by name and server - try multiple variations for library name
    library = None
    library_name_variations = decode_url_component_variations(library_name)
    
    for variation in library_name_variations:
        library = MediaLibrary.query.filter_by(
            server_id=server.id,
            name=variation
        ).first()
        if library:
            # Store the actual library name that worked
            library_name_for_lookup = variation
            break
    
    if not library:
        abort(404)
    
    # Get the active tab from the URL query, default to 'overview'
    tab = request.args.get('tab', 'overview')
    
    # Get library statistics
    library_stats = get_library_statistics(library)
    
    # Get chart data for stats tab
    chart_data = None
    user_stats = None
    if tab == 'stats':
        days_param = request.args.get('days', '30')
        try:
            if days_param == 'all':
                days = -1
            else:
                days = int(days_param)
                # Validate days parameter
                if days not in [7, 30, 90, 365]:
                    days = 30
        except (ValueError, TypeError):
            days = 30
        
        chart_data = generate_library_chart_data(library, days)
        user_stats = get_library_user_stats(library, days)
    
    # Get media content for media tab
    media_content = None
    if tab == 'media':
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 24, type=int)
        search_query = request.args.get('search', '').strip()
        sort_by = request.args.get('sort_by', 'title').strip()
        
        # Validate per_page parameter
        if per_page not in [12, 24, 48, 96]:
            per_page = 24
            
        # Validate sort_by parameter
        valid_sorts = [
            'title_asc', 'title_desc', 'year_asc', 'year_desc', 
            'added_at_asc', 'added_at_desc', 'rating_asc', 'rating_desc',
            'total_streams_asc', 'total_streams_desc'
        ]
        if sort_by not in valid_sorts:
            sort_by = 'title_asc'
            
        media_content = get_library_media_content(library, page, per_page, search_query, sort_by)
    
    # Get collections for Plex libraries  
    collections_content = None
    if tab == 'collections' and server.service_type.value.lower() == 'plex':
        try:
            # Create service instance to get collections
            service = MediaServiceFactory.create_service_from_db(server)
            if service and hasattr(service, 'get_library_collections'):
                # Use the external_id (library UUID) to get collections
                library_uuid = library.external_id
                current_app.logger.info(f"Fetching collections for Plex library {library_uuid}")
                
                collections_data = service.get_library_collections(library_uuid)
                if collections_data.get('success'):
                    collections_content = {
                        'collections': collections_data.get('collections', []),
                        'library_name': collections_data.get('library_name', library.name),
                        'library_type': collections_data.get('library_type', 'unknown')
                    }
                else:
                    current_app.logger.error(f"Failed to fetch collections: {collections_data.get('error', 'Unknown error')}")
                    collections_content = {'collections': [], 'error': collections_data.get('error')}
            else:
                current_app.logger.error("Plex service does not support get_library_collections method")
                collections_content = {'collections': [], 'error': 'Service does not support collections retrieval'}
        except Exception as e:
            current_app.logger.error(f"Error fetching collections for library {library.external_id}: {e}")
            collections_content = {'collections': [], 'error': str(e)}

    # Get recent activity for this library
    recent_activity = []
    if tab == 'activity':
        page = request.args.get('page', 1, type=int)
        days_filter = int(request.args.get('days', 30))
        
        # Calculate date range
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days_filter)
        
        # Get streaming history for this library
        current_app.logger.info(f"ACTIVITY DEBUG: Looking for activity in library '{library_name}' on server {server.id} ({server.server_nickname})")
        current_app.logger.info(f"ACTIVITY DEBUG: Date range: {start_date} to {end_date} ({days_filter} days)")
        
        # Check what library names exist in the database for this server
        existing_library_names = db.session.query(MediaStreamHistory.library_name).filter(
            MediaStreamHistory.server_id == server.id
        ).distinct().all()
        current_app.logger.info(f"ACTIVITY DEBUG: Existing library names in DB for server {server.id}: {[name[0] for name in existing_library_names]}")
        
        # Use the actual library name from the database object, not the URL parameter
        actual_library_name = library.name
        current_app.logger.info(f"ACTIVITY DEBUG: Using actual library name from DB: '{actual_library_name}'")
        
        activity_query = MediaStreamHistory.query.filter(
            MediaStreamHistory.server_id == server.id,
            MediaStreamHistory.library_name == actual_library_name,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date,
            MediaStreamHistory.user_uuid.isnot(None)  # Show all user activity
        ).order_by(MediaStreamHistory.started_at.desc())
        
        # Check the total count before pagination
        total_activity_count = activity_query.count()
        current_app.logger.info(f"ACTIVITY DEBUG: Found {total_activity_count} activity records matching criteria")
        
        # Paginate the results
        activity_pagination = activity_query.paginate(
            page=page, per_page=20, error_out=False
        )
        
        # Enhance activity entries with user info and poster images
        for entry in activity_pagination.items:
            # Add poster information by looking up MediaItem
            from app.models_media_services import MediaItem
            entry.thumb_path = None
            entry.grandparent_thumb_path = None  
            entry.parent_thumb_path = None
            
            # Try to find the media item for this activity
            if entry.media_title:
                # For episodes, try to find by episode title and show (grandparent)
                if entry.grandparent_title and entry.media_type == 'episode':
                    episode_item = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.title == entry.media_title,
                        MediaItem.item_type == 'episode'
                    ).first()
                    if episode_item and episode_item.thumb_path:
                        entry.thumb_path = episode_item.thumb_path
                    
                    # Also get the show poster for fallback
                    show_item = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.title == entry.grandparent_title,
                        MediaItem.item_type == 'show'
                    ).first()
                    if show_item and show_item.thumb_path:
                        entry.grandparent_thumb_path = show_item.thumb_path
                        
                # For movies and other content, find by direct title match
                else:
                    media_item = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.title == entry.media_title
                    ).first()
                    if media_item and media_item.thumb_path:
                        entry.thumb_path = media_item.thumb_path
                        
                # For season-level content (if parent_title exists)
                if entry.parent_title:
                    parent_item = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.title == entry.parent_title
                    ).first()
                    if parent_item and parent_item.thumb_path:
                        entry.parent_thumb_path = parent_item.thumb_path
            
            # Convert thumb paths to proper URLs
            if entry.thumb_path:
                if entry.thumb_path.startswith('/api/'):
                    # Already a proxy URL
                    pass
                elif entry.thumb_path.startswith('http'):
                    # Full URL - use as-is
                    pass
                else:
                    # Convert to proxy URL
                    entry.thumb_path = f"/admin/api/v2/media/{server.service_type.value}/images/proxy?path={entry.thumb_path.lstrip('/')}"
            
            if entry.grandparent_thumb_path:
                if entry.grandparent_thumb_path.startswith('/api/'):
                    pass
                elif entry.grandparent_thumb_path.startswith('http'):
                    pass
                else:
                    entry.grandparent_thumb_path = f"/admin/api/v2/media/{server.service_type.value}/images/proxy?path={entry.grandparent_thumb_path.lstrip('/')}"
            
            if entry.parent_thumb_path:
                if entry.parent_thumb_path.startswith('/api/'):
                    pass
                elif entry.parent_thumb_path.startswith('http'):
                    pass
                else:
                    entry.parent_thumb_path = f"/admin/api/v2/media/{server.service_type.value}/images/proxy?path={entry.parent_thumb_path.lstrip('/')}"
            
            # Add media item for clickable links
            entry.linked_media_item = None
            entry.linked_show_item = None
            entry.is_episode = False
            
            if entry.media_title:
                # For episodes, try to find both the episode and the show
                if entry.grandparent_title and entry.media_type == 'episode':
                    entry.is_episode = True
                    
                    # Find the specific episode
                    episode_item = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.title == entry.media_title,
                        MediaItem.item_type == 'episode'
                    ).first()
                    if episode_item:
                        entry.linked_media_item = episode_item
                    
                    # Find the show for URL generation
                    show_item = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.title == entry.grandparent_title,
                        MediaItem.item_type == 'show'
                    ).first()
                    if show_item:
                        entry.linked_show_item = show_item
                
                # For movies and other content, find by direct title match
                else:
                    media_item = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.title == entry.media_title
                    ).first()
                    if media_item:
                        entry.linked_media_item = media_item
            
            # Add user info using unified user_uuid
            user = User.query.filter_by(uuid=entry.user_uuid).first()
            if user:
                entry.user_display_name = user.get_display_name()
                entry.user_type = 'service' if user.userType == UserType.SERVICE else 'local'
                
                # Get avatar URL for users
                entry.user_avatar_url = user.external_avatar_url if user.userType == UserType.SERVICE else None
                
                # Fallback to legacy avatar lookup if external_avatar_url is not set
                if not entry.user_avatar_url:
                    if server.service_type.value.lower() == 'plex':
                        # For Plex, check multiple possible locations for the thumb URL
                        thumb_url = None
                        
                        # First try service_settings
                        if user.service_settings and user.service_settings.get('thumb'):
                            thumb_url = user.service_settings['thumb']
                        # Then try raw_data from the user sync
                        elif user.user_raw_data and user.user_raw_data.get('thumb'):
                            thumb_url = user.user_raw_data['thumb']
                        # Also check nested raw data structure
                        elif (user.user_raw_data and 
                              user.user_raw_data.get('plex_user_obj_attrs') and 
                              user.user_raw_data['plex_user_obj_attrs'].get('thumb')):
                            thumb_url = user.user_raw_data['plex_user_obj_attrs']['thumb']
                        
                        if thumb_url:
                            # Check if it's already a full URL (plex.tv avatars) or needs proxy
                            if thumb_url.startswith('https://plex.tv/') or thumb_url.startswith('http://plex.tv/'):
                                entry.user_avatar_url = thumb_url
                            else:
                                entry.user_avatar_url = f"/api/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
                    
                    elif server.service_type.value.lower() == 'jellyfin':
                        # For Jellyfin, use the external_user_id to get avatar
                        if user.external_user_id:
                            entry.user_avatar_url = f"/api/media/jellyfin/users/avatar?user_id={user.external_user_id}"
                
                # Check if this service user is linked to a local account for clickable username
                # Get linked local user if this is a service user
                entry.linked_local_user = None
                if user and user.linkedUserId:
                    entry.linked_local_user = User.query.filter_by(userType=UserType.LOCAL, uuid=user.linkedUserId).first()
            else:
                entry.user_display_name = 'Unknown User'
                entry.user_type = 'unknown'
                entry.user_avatar_url = None
                entry.linked_local_user = None
        
        recent_activity = activity_pagination
    
    # Handle HTMX requests for tab content
    if request.headers.get('HX-Request'):
        if tab == 'activity':
            return render_template('library/_partials/library_activity_tab.html',
                                 library=library,
                                 server=server,
                                 recent_activity=recent_activity,
                                 days_filter=request.args.get('days', 30))
        elif tab == 'collections':
            return render_template('library/_partials/library_collections_tab.html',
                                 library=library,
                                 server=server,
                                 collections_content=collections_content)
    
    return render_template('library/index.html',
                         title=f"Library: {library_name}",
                         library=library,
                         server=server,
                         library_stats=library_stats,
                         recent_activity=recent_activity,
                         chart_data=chart_data,
                         user_stats=user_stats,
                         media_content=media_content,
                         collections_content=collections_content,
                         active_tab=tab,
                         selected_days=request.args.get('days', 30) if tab == 'stats' else None,
                         days_filter=request.args.get('days', 30) if tab == 'activity' else None,
                         current_sort_by=request.args.get('sort_by', 'title_asc') if tab == 'media' else None,
                         User=User,
                         UserType=UserType)
