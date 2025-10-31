"""DEPRECATED: Helper functions for SSR library management.
Use v2 endpoints and service-layer utilities instead.
"""

from flask import current_app
from app.models_media_services import MediaLibrary, MediaServer, MediaStreamHistory
from app.models import User, UserType
from app.extensions import db
from datetime import datetime, timezone, timedelta


def get_library_statistics(library):
    """Get statistics for a library"""
    try:
        # Get streaming statistics for this library
        total_streams = MediaStreamHistory.query.filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name
        ).count()
        
        # Get unique users who have accessed this library
        unique_users = db.session.query(MediaStreamHistory.user_uuid)\
            .filter(
                MediaStreamHistory.server_id == library.server_id,
                MediaStreamHistory.library_name == library.name,
                MediaStreamHistory.user_uuid.isnot(None)
            ).distinct().count()
        
        # Get total watch time (in seconds)
        total_watch_time = db.session.query(db.func.sum(MediaStreamHistory.duration_seconds))\
            .filter(
                MediaStreamHistory.server_id == library.server_id,
                MediaStreamHistory.library_name == library.name,
                MediaStreamHistory.duration_seconds.isnot(None)
            ).scalar() or 0
        
        # Get most popular content
        popular_content = db.session.query(
            MediaStreamHistory.media_title,
            db.func.count(MediaStreamHistory.id).label('play_count')
        ).filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name
        ).group_by(MediaStreamHistory.media_title)\
         .order_by(db.func.count(MediaStreamHistory.id).desc())\
         .limit(5).all()
        
        # Format watch time
        def format_duration(seconds):
            if not seconds:
                return "0m"
            hours = seconds // 3600
            minutes = (seconds % 3600) // 60
            if hours > 0:
                return f"{hours}h {minutes}m"
            else:
                return f"{minutes}m"
        
        return {
            'total_streams': total_streams,
            'unique_users': unique_users,
            'total_watch_time': total_watch_time,
            'total_watch_time_formatted': format_duration(total_watch_time),
            'popular_content': popular_content,
            'item_count': library.item_count or 0,
            'library_type': library.library_type or 'Unknown'
        }
    except Exception as e:
        current_app.logger.error(f"Error getting library statistics: {e}")
        return {
            'total_streams': 0,
            'unique_users': 0,
            'total_watch_time': 0,
            'total_watch_time_formatted': '0m',
            'popular_content': [],
            'item_count': library.item_count or 0,
            'library_type': library.library_type or 'Unknown'
        }


def generate_library_chart_data(library, days=30):
    """Generate chart data for library streaming activity by user"""
    from collections import defaultdict
    from app.utils.helpers import format_duration
    
    # Calculate date range based on days parameter
    end_date = datetime.now(timezone.utc)
    if days == -1:  # All time
        # Get the earliest stream date for this library
        earliest_stream = MediaStreamHistory.query.filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name
        ).order_by(MediaStreamHistory.started_at.asc()).first()
        
        if earliest_stream:
            start_date = earliest_stream.started_at
        else:
            start_date = end_date - timedelta(days=30)  # Fallback to 30 days
    else:
        start_date = end_date - timedelta(days=days-1)
    
    # Get streaming history for this library
    streaming_history = MediaStreamHistory.query.filter(
        MediaStreamHistory.server_id == library.server_id,
        MediaStreamHistory.library_name == library.name,
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    ).all()
    
    if not streaming_history:
        return {
            'chart_data': [],
            'users': [],
            'user_combinations': [],
            'user_colors': {},
            'total_streams': 0,
            'total_duration': '0m',
            'most_active_user': 'None',
            'date_range_days': days
        }
    
    # Determine grouping strategy based on days parameter
    if days == 7:
        grouping_type = 'daily'
    elif days in [30, 90]:
        grouping_type = 'weekly'
    elif days == 365 or days == -1:
        grouping_type = 'monthly'
    else:
        grouping_type = 'daily'
    
    # Group data by time period (total plays and total time)
    grouped_data = defaultdict(lambda: {'plays': 0, 'time': 0})
    total_duration_seconds = 0
    total_plays = 0
    
    for entry in streaming_history:
        # Get the date (without time)
        entry_date = entry.started_at.date()
        
        # Determine the grouping key based on grouping type
        if grouping_type == 'monthly':
            group_key = entry_date.strftime('%Y-%m')
        elif grouping_type == 'weekly':
            days_since_monday = entry_date.weekday()
            week_start = entry_date - timedelta(days=days_since_monday)
            group_key = week_start.isoformat()
        else:  # daily
            group_key = entry_date.isoformat()
        
        # Get duration in minutes for the chart
        duration_minutes = 0
        if entry.duration_seconds and entry.duration_seconds > 0:
            duration_minutes = entry.duration_seconds / 60
            total_duration_seconds += entry.duration_seconds
        elif entry.view_offset_at_end_seconds and entry.view_offset_at_end_seconds > 0:
            duration_minutes = entry.view_offset_at_end_seconds / 60
            total_duration_seconds += entry.view_offset_at_end_seconds
        else:
            duration_minutes = 1  # 1 minute minimum to show activity
        
        # Add plays and time per group
        grouped_data[group_key]['plays'] += 1
        grouped_data[group_key]['time'] += duration_minutes
        total_plays += 1
    
    # Generate chart data for the date range
    chart_data_list = []
    
    # Generate time periods based on grouping type
    if grouping_type == 'monthly':
        # Generate monthly periods
        if start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)
            
        current_date = start_date.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end_date_month = end_date.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        
        while current_date <= end_date_month:
            month_key = current_date.strftime('%Y-%m')
            month_label = current_date.strftime('%b %Y')
            
            period_data = {
                'date': month_key, 
                'label': month_label,
                'plays': grouped_data[month_key]['plays'],
                'time': round(grouped_data[month_key]['time'], 1)
            }
            
            chart_data_list.append(period_data)
            
            # Move to next month
            if current_date.month == 12:
                current_date = current_date.replace(year=current_date.year + 1, month=1)
            else:
                current_date = current_date.replace(month=current_date.month + 1)
                
    elif grouping_type == 'weekly':
        # Generate weekly periods
        start_date_only = start_date.date() if hasattr(start_date, 'date') else start_date
        end_date_only = end_date.date() if hasattr(end_date, 'date') else end_date
        
        days_since_monday = start_date_only.weekday()
        current_week_start = start_date_only - timedelta(days=days_since_monday)
        
        while current_week_start <= end_date_only:
            week_key = current_week_start.isoformat()
            week_end = current_week_start + timedelta(days=6)
            
            if current_week_start.month == week_end.month:
                week_label = f"{current_week_start.strftime('%b %d')}-{week_end.day}"
            else:
                week_label = f"{current_week_start.strftime('%b %d')}-{week_end.strftime('%b %d')}"
            
            period_data = {
                'date': week_key, 
                'label': week_label,
                'plays': grouped_data[week_key]['plays'],
                'time': round(grouped_data[week_key]['time'], 1)
            }
            
            chart_data_list.append(period_data)
            current_week_start += timedelta(days=7)
            
    else:  # daily
        # Generate daily periods
        start_date_only = start_date.date() if hasattr(start_date, 'date') else start_date
        end_date_only = end_date.date() if hasattr(end_date, 'date') else end_date
        
        current_date = start_date_only
        while current_date <= end_date_only:
            day_key = current_date.isoformat()
            day_label = current_date.strftime('%b %d')
            
            period_data = {
                'date': day_key, 
                'label': day_label,
                'plays': grouped_data[day_key]['plays'],
                'time': round(grouped_data[day_key]['time'], 1)
            }
            
            chart_data_list.append(period_data)
            current_date += timedelta(days=1)
    
    # Calculate summary stats
    total_duration_formatted = format_duration(total_duration_seconds)
    
    return {
        'chart_data': chart_data_list,
        'users': [],
        'user_combinations': [],
        'user_colors': {},
        'total_streams': total_plays,
        'total_duration': total_duration_formatted,
        'most_active_user': 'None',
        'date_range_days': days
    }


def get_library_user_stats(library, days=30):
    """Get user statistics for a library"""
    
    try:
        # Calculate date range based on days parameter
        end_date = datetime.now(timezone.utc)
        if days == -1:  # All time
            # Get the earliest stream date for this library
            earliest_stream = MediaStreamHistory.query.filter(
                MediaStreamHistory.server_id == library.server_id,
                MediaStreamHistory.library_name == library.name
            ).order_by(MediaStreamHistory.started_at.asc()).first()
            
            if earliest_stream:
                start_date = earliest_stream.started_at
            else:
                start_date = end_date - timedelta(days=30)  # Fallback to 30 days
        else:
            start_date = end_date - timedelta(days=days-1)
        
        # Get user statistics for this library
        user_stats_query = db.session.query(
            MediaStreamHistory.user_uuid,
            User.external_username,
            User.external_email,
            User.external_avatar_url,
            db.func.count(MediaStreamHistory.id).label('play_count'),
            db.func.sum(MediaStreamHistory.duration_seconds).label('total_duration')
        ).join(
            User, 
            MediaStreamHistory.user_uuid == User.uuid
        ).filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date,
            MediaStreamHistory.user_uuid.isnot(None)
        ).group_by(
            MediaStreamHistory.user_uuid,
            User.external_username,
            User.external_email,
            User.external_avatar_url
        ).order_by(db.func.count(MediaStreamHistory.id).desc()).all()
        
        # Format user stats
        user_stats = []
        for stat in user_stats_query:
            # Get display name (prefer external_username, fallback to external_email)
            display_name = stat.external_username or stat.external_email or 'Unknown User'
            
            # Format duration
            total_seconds = stat.total_duration or 0
            hours = total_seconds // 3600
            minutes = (total_seconds % 3600) // 60
            
            if hours > 0:
                duration_formatted = f"{hours}h {minutes}m"
            else:
                duration_formatted = f"{minutes}m"
            
            # Determine avatar URL based on server type
            avatar_url = None
            if stat.external_avatar_url:
                # Use the stored external avatar URL directly
                avatar_url = stat.external_avatar_url
            elif stat.user_uuid:
                # Get the full user record to access raw_data and service_settings
                user_access = User.query.filter_by(uuid=stat.user_uuid).first()
                if user_access:
                    if library.server.service_type.value.lower() == 'plex':
                        # For Plex, check multiple possible locations for the thumb URL
                        thumb_url = None
                        
                        # First try service_settings
                        if user_access.service_settings and user_access.service_settings.get('thumb'):
                            thumb_url = user_access.service_settings['thumb']
                        # Then try raw_data from the user sync
                        elif user_access.user_raw_data and user_access.user_raw_data.get('thumb'):
                            thumb_url = user_access.user_raw_data['thumb']
                        # Also check nested raw data structure
                        elif (user_access.user_raw_data and 
                              user_access.user_raw_data.get('plex_user_obj_attrs') and 
                              user_access.user_raw_data['plex_user_obj_attrs'].get('thumb')):
                            thumb_url = user_access.user_raw_data['plex_user_obj_attrs']['thumb']
                        
                        if thumb_url:
                            # Check if it's already a full URL (plex.tv avatars) or needs proxy
                            if thumb_url.startswith('https://plex.tv/') or thumb_url.startswith('http://plex.tv/'):
                                avatar_url = thumb_url
                            else:
                                avatar_url = f"/api/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
                    
                    elif library.server.service_type.value.lower() == 'jellyfin':
                        # For Jellyfin, use the external_user_id to get avatar
                        if user_access.external_user_id:
                            avatar_url = f"/api/media/jellyfin/users/avatar?user_id={user_access.external_user_id}"
            
            user_stats.append({
                'uuid': stat.user_uuid,
                'display_name': display_name,
                'username': stat.external_username,
                'email': stat.external_email,
                'avatar_url': avatar_url,
                'play_count': stat.play_count,
                'total_duration_seconds': total_seconds,
                'total_duration_formatted': duration_formatted,
                'server_nickname': library.server.server_nickname
            })
        
        return user_stats
        
    except Exception as e:
        current_app.logger.error(f"Error getting library user stats: {e}")
        return []


def get_media_details_cached_only(server, library, content_name):
    """Get detailed information about a specific media item from database cache only"""
    try:
        from app.models_media_services import MediaItem
        
        current_app.logger.debug(f"get_media_details_cached_only: Looking for title='{content_name}' in library_id={library.id}")
        
        # Only check cached database, no API calls
        media_item = MediaItem.query.filter_by(
            library_id=library.id,
            title=content_name
        ).first()
        
        if media_item:
            current_app.logger.debug(f"Found media item in database cache: '{media_item.title}'")
            # Convert database item to dict format
            return {
                'id': media_item.external_id,
                'title': media_item.title,
                'sort_title': media_item.sort_title,
                'type': media_item.item_type,
                'summary': media_item.summary,
                'year': media_item.year,
                'rating': media_item.rating,
                'duration': media_item.duration,
                'thumb': media_item.thumb_path,
                'added_at': media_item.added_at,
                'last_synced': media_item.last_synced,
                'raw_data': media_item.extra_metadata or {}
            }
        
        current_app.logger.debug(f"No cached media item found for '{content_name}'")
        return None
        
    except Exception as e:
        current_app.logger.error(f"Error getting cached media details for '{content_name}': {e}")
        return None


def get_media_details(server, library, content_name):
    """Get detailed information about a specific media item"""
    try:
        from app.services.media_service_factory import MediaServiceFactory
        from app.models_media_services import MediaItem
        
        current_app.logger.debug(f"get_media_details: Looking for title='{content_name}' in library_id={library.id}")
        
        # First try to get from cached database
        media_item = MediaItem.query.filter_by(
            library_id=library.id,
            title=content_name
        ).first()
        
        # Debug: Show what titles are actually in the database for this library
        all_titles = MediaItem.query.filter_by(library_id=library.id).with_entities(MediaItem.title).all()
        current_app.logger.debug(f"Available titles in library: {[t[0] for t in all_titles[:10]]}...")  # Show first 10
        
        if media_item:
            current_app.logger.debug(f"Found media item in database: '{media_item.title}'")
            # Convert database item to dict format
            return {
                'id': media_item.external_id,
                'title': media_item.title,
                'sort_title': media_item.sort_title,
                'type': media_item.item_type,
                'summary': media_item.summary,
                'year': media_item.year,
                'rating': media_item.rating,
                'duration': media_item.duration,
                'thumb': media_item.thumb_path,
                'added_at': media_item.added_at,
                'last_synced': media_item.last_synced,
                'raw_data': media_item.extra_metadata or {}
            }
        
        # If not in cache, try to get from service API
        service = MediaServiceFactory.create_service_from_db(server)
        if not service or not hasattr(service, 'get_library_content'):
            return None
        
        # Search for the content in the library
        try:
            content_data = service.get_library_content(library.external_id, page=1, per_page=100)
            items = content_data.get('items', [])
            
            # Find the specific content by title
            for item in items:
                if item.get('title') == content_name:
                    return item
            
            # If not found in first page, search more pages
            page = 2
            while page <= 10:  # Limit search to 10 pages
                content_data = service.get_library_content(library.external_id, page=page, per_page=100)
                items = content_data.get('items', [])
                
                if not items:
                    break
                    
                for item in items:
                    if item.get('title') == content_name:
                        return item
                        
                page += 1
                
        except Exception as e:
            current_app.logger.error(f"Error searching for media content: {e}")
        
        return None
        
    except Exception as e:
        current_app.logger.error(f"Error getting media details: {e}")
        return None


def get_show_episodes_by_item(server, library, media_item, page=1, per_page=24, search_query='', sort_by='title_asc'):
    """Get episodes for a specific TV show using the media item object"""
    try:
        from app.models_media_services import MediaStreamHistory, MediaItem
        from sqlalchemy import or_
        
        # First try to get episodes from database (much faster!)
        # Check multiple possible parent_id patterns for better compatibility
        query = MediaItem.query.filter(
            MediaItem.library_id == library.id,
            MediaItem.item_type == 'episode',
            or_(
                MediaItem.parent_id == media_item.external_id,
                MediaItem.parent_id == media_item.rating_key
            )
        )
        
        # Apply search filter if provided
        if search_query:
            search_term = f"%{search_query.lower()}%"
            query = query.filter(
                or_(
                    MediaItem.title.ilike(search_term),
                    MediaItem.summary.ilike(search_term)
                )
            )
        
        # Check if we have episodes in database
        total_episodes = query.count()
        
        current_app.logger.debug(f"Found {total_episodes} cached episodes for show: {media_item.title} (external_id: {media_item.external_id}, rating_key: {media_item.rating_key})")
        
        if total_episodes > 0:
            # We have episodes in database - use them!
            current_app.logger.debug(f"Using cached episodes for show: {media_item.title} ({total_episodes} episodes)")
            
            # Check if episodes need syncing (older than 24 hours)
            needs_sync = False
            if media_item.last_synced:
                sync_age = datetime.utcnow() - media_item.last_synced
                needs_sync = sync_age > timedelta(hours=24)
            else:
                needs_sync = True
            
            # Apply sorting (database level for cached episodes)
            current_app.logger.debug(f"Applying sort_by: {sort_by} to cached episodes query")
            if sort_by.startswith('season_episode'):
                # For season/episode sorting, we'll sort manually after getting the data
                query = query.order_by(MediaItem.sort_title.asc())  # Default order first
            elif sort_by == 'title_desc':
                query = query.order_by(MediaItem.sort_title.desc())
            elif sort_by == 'year_asc':
                query = query.order_by(MediaItem.year.asc().nullsfirst(), MediaItem.sort_title.asc())
            elif sort_by == 'year_desc':
                query = query.order_by(MediaItem.year.desc().nullslast(), MediaItem.sort_title.asc())
            elif sort_by == 'added_at_asc':
                query = query.order_by(MediaItem.added_at.asc().nullsfirst(), MediaItem.sort_title.asc())
            elif sort_by == 'added_at_desc':
                query = query.order_by(MediaItem.added_at.desc().nullslast(), MediaItem.sort_title.asc())
            elif sort_by.startswith('total_streams'):
                # For stream sorting, we'll sort manually after getting stream counts
                query = query.order_by(MediaItem.sort_title.asc())  # Default order first
            else:  # Default to season_episode_asc
                query = query.order_by(MediaItem.sort_title.asc())
            
            # Get all episodes for stream count calculation
            all_episodes = query.all()
            
            # Convert to dict format and add stream counts
            episodes_data = []
            for episode in all_episodes:
                episode_dict = episode.to_dict()
                
                # Get stream count for this episode
                stream_count = MediaStreamHistory.query.filter(
                    MediaStreamHistory.server_id == server.id,
                    MediaStreamHistory.library_name == library.name,
                    MediaStreamHistory.media_title == episode.title,
                    MediaStreamHistory.grandparent_title == media_item.title
                ).count()
                episode_dict['stream_count'] = stream_count
                episodes_data.append(episode_dict)
            
            # Apply manual sorting for ALL episodes (for proper cross-page sorting)
            current_app.logger.debug(f"Applying manual sorting for cached episodes: {sort_by}")
            if sort_by.startswith('season_episode'):
                reverse = sort_by.endswith('_desc')
                def season_episode_sort_key(episode):
                    season = episode.get('season_number', 0) or 0
                    episode_num = episode.get('episode_number', 0) or 0
                    return (season, episode_num)
                episodes_data.sort(key=season_episode_sort_key, reverse=reverse)
                if episodes_data:
                    first_ep = episodes_data[0]
                    season_num = first_ep.get('season_number', 0) or 0
                    episode_num = first_ep.get('episode_number', 0) or 0
                    current_app.logger.debug(f"Sorted ALL episodes by season/episode, first episode: '{first_ep.get('title')}' S{season_num:02d}E{episode_num:02d}")
            elif sort_by.startswith('total_streams'):
                reverse = sort_by.endswith('_desc')
                episodes_data.sort(key=lambda x: x.get('stream_count', 0), reverse=reverse)
                current_app.logger.debug(f"Sorted ALL episodes by streams, first episode: '{episodes_data[0].get('title')}' with {episodes_data[0].get('stream_count', 0)} streams")
            elif sort_by.startswith('title'):
                reverse = sort_by.endswith('_desc')
                episodes_data.sort(key=lambda x: x.get('title', '').lower(), reverse=reverse)
                current_app.logger.debug(f"Sorted ALL episodes by title, first episode: '{episodes_data[0].get('title')}'")
            elif sort_by.startswith('year'):
                reverse = sort_by.endswith('_desc')
                episodes_data.sort(key=lambda x: x.get('year') or (0 if not reverse else 9999), reverse=reverse)
                current_app.logger.debug(f"Sorted ALL episodes by year, first episode: '{episodes_data[0].get('title')}' ({episodes_data[0].get('year')})")
            elif sort_by.startswith('added_at'):
                reverse = sort_by.endswith('_desc')
                episodes_data.sort(key=lambda x: x.get('added_at') or ('1900-01-01' if not reverse else '9999-12-31'), reverse=reverse)
                current_app.logger.debug(f"Sorted ALL episodes by added_at, first episode: '{episodes_data[0].get('title')}'")
            
            # Apply manual pagination
            start_idx = (page - 1) * per_page
            end_idx = start_idx + per_page
            paginated_episodes = episodes_data[start_idx:end_idx]
            
            # Calculate pagination info
            total_pages = (total_episodes + per_page - 1) // per_page
            
            return {
                'items': paginated_episodes,
                'total': total_episodes,
                'page': page,
                'per_page': per_page,
                'pages': total_pages,
                'has_prev': page > 1,
                'has_next': page < total_pages,
                'needs_sync': needs_sync,
                'last_synced': media_item.last_synced.isoformat() if media_item.last_synced else None,
                'show_id': media_item.id
            }
        
        else:
            # No episodes in database - trigger automatic sync first
            current_app.logger.info(f"No cached episodes found for show: {media_item.title}, triggering automatic sync")
            
            # Trigger episode sync automatically
            from app.services.media_sync_service import MediaSyncService
            sync_result = MediaSyncService.sync_show_episodes(media_item.id)
            
            if sync_result['success']:
                current_app.logger.info(f"Auto-sync completed for {media_item.title}: {sync_result['added']} episodes added")
                
                # Now try to get episodes from database again
                query = MediaItem.query.filter_by(
                    library_id=library.id,
                    item_type='episode',
                    parent_id=media_item.external_id
                )
                
                # Apply search filter if provided
                if search_query:
                    search_term = f"%{search_query.lower()}%"
                    query = query.filter(
                        or_(
                            MediaItem.title.ilike(search_term),
                            MediaItem.summary.ilike(search_term)
                        )
                    )
                
                total_episodes = query.count()
                
                if total_episodes > 0:
                    # Apply sorting
                    if sort_by == 'title_desc':
                        query = query.order_by(MediaItem.sort_title.desc())
                    elif sort_by == 'year_asc':
                        query = query.order_by(MediaItem.year.asc().nullsfirst(), MediaItem.sort_title.asc())
                    elif sort_by == 'year_desc':
                        query = query.order_by(MediaItem.year.desc().nullslast(), MediaItem.sort_title.asc())
                    elif sort_by == 'added_at_asc':
                        query = query.order_by(MediaItem.added_at.asc().nullsfirst(), MediaItem.sort_title.asc())
                    elif sort_by == 'added_at_desc':
                        query = query.order_by(MediaItem.added_at.desc().nullslast(), MediaItem.sort_title.asc())
                    else:  # Default to title_asc
                        query = query.order_by(MediaItem.sort_title.asc())
                    
                    # Get all episodes for stream count calculation
                    all_episodes = query.all()
                    
                    # Convert to dict format and add stream counts
                    episodes_data = []
                    for episode in all_episodes:
                        episode_dict = episode.to_dict()
                        
                        # Get stream count for this episode
                        stream_count = MediaStreamHistory.query.filter(
                            MediaStreamHistory.server_id == server.id,
                            MediaStreamHistory.library_name == library.name,
                            MediaStreamHistory.media_title == episode.title,
                            MediaStreamHistory.grandparent_title == media_item.title
                        ).count()
                        episode_dict['stream_count'] = stream_count
                        episodes_data.append(episode_dict)
                    
                    # Apply manual pagination
                    start_idx = (page - 1) * per_page
                    end_idx = start_idx + per_page
                    paginated_episodes = episodes_data[start_idx:end_idx]
                    
                    # Calculate pagination info
                    total_pages = (total_episodes + per_page - 1) // per_page
                    
                    return {
                        'items': paginated_episodes,
                        'total': total_episodes,
                        'page': page,
                        'per_page': per_page,
                        'pages': total_pages,
                        'has_prev': page > 1,
                        'has_next': page < total_pages,
                        'needs_sync': False,  # Just synced
                        'last_synced': media_item.last_synced.isoformat() if media_item.last_synced else None,
                        'show_id': media_item.id,
                        'auto_synced': True  # Flag to indicate this was auto-synced
                    }
            
            # If auto-sync failed, fall back to API call
            current_app.logger.warning(f"Auto-sync failed for {media_item.title}, falling back to API: {sync_result.get('error', 'Unknown error')}")
            
            from app.services.media_service_factory import MediaServiceFactory
            
            # Create service instance
            service = MediaServiceFactory.create_service_from_db(server)
            if not service:
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': 'Could not create service instance'
                }
            
            # Use the media item's rating_key directly
            show_id = media_item.rating_key if media_item.rating_key else media_item.external_id
            if not show_id:
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': 'No show ID available'
                }
            
            # Get ALL episodes from the service first (for proper sorting)
            if hasattr(service, 'get_show_episodes'):
                # Get all episodes first, then we'll handle pagination after sorting
                episodes_data = service.get_show_episodes(show_id, page=1, per_page=1000, search_query=search_query)
            elif hasattr(service, 'get_library_content'):
                # Fallback: try to get episodes by searching for the show in the library
                episodes_data = service.get_library_content(library.external_id, page=1, per_page=1000, parent_id=show_id)
            else:
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': 'Service does not support episode retrieval'
                }
        
        # Add stream counts to episodes
        if episodes_data and episodes_data.get('items'):
            for episode in episodes_data['items']:
                # Filter by both episode title AND show title to avoid conflicts with episodes from other shows
                stream_count = MediaStreamHistory.query.filter(
                    MediaStreamHistory.server_id == server.id,
                    MediaStreamHistory.library_name == library.name,
                    MediaStreamHistory.media_title == episode.get('title', ''),
                    MediaStreamHistory.grandparent_title == media_item.title
                ).count()
                episode['stream_count'] = stream_count
        
        # Apply sorting if needed (some services might not support server-side sorting)
        # Note: This must happen AFTER stream counts are added above
        current_app.logger.debug(f"API fallback sorting: sort_by={sort_by}, episodes_data exists: {episodes_data is not None}")
        if episodes_data and episodes_data.get('items') and sort_by != 'season_episode_asc':
            items = episodes_data['items']
            reverse = sort_by.endswith('_desc')
            current_app.logger.debug(f"Applying API fallback sorting to {len(items)} episodes")
            
            if sort_by.startswith('season_episode'):
                def season_episode_sort_key(episode):
                    season = episode.get('season_number', 0) or 0
                    episode_num = episode.get('episode_number', 0) or 0
                    return (season, episode_num)
                items.sort(key=season_episode_sort_key, reverse=reverse)
                if items:
                    first_ep = items[0]
                    season_num = first_ep.get('season_number', 0) or 0
                    episode_num = first_ep.get('episode_number', 0) or 0
                    current_app.logger.debug(f"Sorted API episodes by season/episode, first episode: '{first_ep.get('title')}' S{season_num:02d}E{episode_num:02d}")
            elif sort_by.startswith('title'):
                items.sort(key=lambda x: x.get('title', '').lower(), reverse=reverse)
                current_app.logger.debug(f"Sorted API episodes by title, first episode: '{items[0].get('title')}'")
            elif sort_by.startswith('year'):
                items.sort(key=lambda x: x.get('year', 0) or 0, reverse=reverse)
                current_app.logger.debug(f"Sorted API episodes by year, first episode: '{items[0].get('title')}' ({items[0].get('year')})")
            elif sort_by.startswith('added_at'):
                items.sort(key=lambda x: x.get('added_at', ''), reverse=reverse)
                current_app.logger.debug(f"Sorted API episodes by added_at, first episode: '{items[0].get('title')}' ({items[0].get('added_at')})")
            elif sort_by.startswith('total_streams'):
                items.sort(key=lambda x: x.get('stream_count', 0), reverse=reverse)
                current_app.logger.debug(f"Sorted API episodes by streams, first episode: '{items[0].get('title')}' with {items[0].get('stream_count', 0)} streams")
            
            episodes_data['items'] = items
        
        # Apply manual pagination after sorting (since we got all episodes)
        if episodes_data and episodes_data.get('items'):
            all_items = episodes_data['items']
            total_items = len(all_items)
            
            # Calculate pagination
            total_pages = (total_items + per_page - 1) // per_page
            start_idx = (page - 1) * per_page
            end_idx = start_idx + per_page
            paginated_items = all_items[start_idx:end_idx]
            
            # Update episodes_data with paginated results
            episodes_data.update({
                'items': paginated_items,
                'total': total_items,
                'page': page,
                'per_page': per_page,
                'pages': total_pages,
                'has_prev': page > 1,
                'has_next': page < total_pages
            })
            
            current_app.logger.debug(f"Manual pagination - showing {len(paginated_items)} episodes (page {page}/{total_pages})")
        
        return episodes_data
        
    except Exception as e:
        current_app.logger.error(f"Error getting episodes for show '{media_item.title}': {e}")
        return {
            'items': [],
            'total': 0,
            'page': page,
            'per_page': per_page,
            'pages': 0,
            'has_prev': False,
            'has_next': False,
            'error': str(e)
        }


def get_library_media_content(library, page=1, per_page=24, search_query='', sort_by='title_asc'):
    """Get media content from the library using cached data or live API"""
    try:
        from app.models_media_services import MediaItem
        from sqlalchemy import or_
        
        # Query MediaItem table directly for this library
        current_app.logger.debug(f"Querying MediaItem for library_id={library.id}, library_name='{library.name}', library_type='{library.library_type}'")
        query = MediaItem.query.filter_by(library_id=library.id)
        
        # Filter by appropriate item type based on library type
        if library.library_type:
            library_type_lower = library.library_type.lower()
            if library_type_lower in ['tv', 'tv shows', 'show', 'shows']:
                # For TV libraries, only show TV shows (not episodes)
                query = query.filter(MediaItem.item_type == 'show')
                current_app.logger.debug(f"Filtering TV library to show only 'show' items")
            elif library_type_lower in ['movie', 'movies', 'film', 'films']:
                # For movie libraries, only show movies
                query = query.filter(MediaItem.item_type == 'movie')
                current_app.logger.debug(f"Filtering movie library to show only 'movie' items")
            elif library_type_lower in ['music', 'audio', 'artist']:
                # For music libraries, only show artists or albums (not tracks)
                query = query.filter(MediaItem.item_type.in_(['artist', 'album']))
                current_app.logger.debug(f"Filtering music library to show only 'artist' and 'album' items")
            elif library_type_lower in ['photo', 'photos']:
                # For photo libraries, filter as needed
                query = query.filter(MediaItem.item_type == 'photo')
                current_app.logger.debug(f"Filtering photo library to show only 'photo' items")
            # For other library types (books, comics, etc.), show all items
        
        # Debug: Check total items in MediaItem table for this library
        total_in_library = query.count()
        current_app.logger.debug(f"Found {total_in_library} total MediaItem records for library_id={library.id}")
        
        # Debug: Check if there are any MediaItem records at all
        total_all_items = MediaItem.query.count()
        current_app.logger.debug(f"Total MediaItem records in database: {total_all_items}")
        
        # Apply search filter if provided
        if search_query:
            search_term = f"%{search_query}%"
            query = query.filter(
                or_(
                    MediaItem.title.ilike(search_term),
                    MediaItem.summary.ilike(search_term)
                )
            )
        
        # Apply sorting (except for stream-based sorting which needs to be done after stream counts are calculated)
        if sort_by == 'title_desc':
            query = query.order_by(MediaItem.title.desc())
        elif sort_by == 'year_asc':
            query = query.order_by(MediaItem.year.asc().nullsfirst())
        elif sort_by == 'year_desc':
            query = query.order_by(MediaItem.year.desc().nullslast())
        elif sort_by == 'added_at_asc':
            query = query.order_by(MediaItem.added_at.asc().nullsfirst())
        elif sort_by == 'added_at_desc':
            query = query.order_by(MediaItem.added_at.desc().nullslast())
        elif sort_by.startswith('total_streams'):
            # For stream-based sorting, use default order first, then sort after stream counts are calculated
            query = query.order_by(MediaItem.title.asc())
        else:  # Default to title_asc
            query = query.order_by(MediaItem.title.asc())
        
        # For stream-based sorting, we need to get ALL items first, then sort and paginate
        if sort_by.startswith('total_streams'):
            current_app.logger.debug(f"Stream-based sorting detected, getting ALL items first")
            
            # Get ALL items (without pagination) for stream-based sorting
            all_media_items = query.all()
            total_items = len(all_media_items)
            
            # Convert ALL MediaItem objects to dict format and add stream counts
            all_items = []
            for media_item in all_media_items:
                item_dict = media_item.to_dict()
                
                # Get stream count for this media item
                if media_item.item_type == 'show':
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == library.server_id,
                        MediaStreamHistory.library_name == library.name,
                        MediaStreamHistory.grandparent_title == media_item.title
                    ).count()
                elif media_item.item_type == 'movie':
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == library.server_id,
                        MediaStreamHistory.library_name == library.name,
                        MediaStreamHistory.media_title == media_item.title
                    ).count()
                elif media_item.item_type in ['artist', 'album']:
                    if media_item.item_type == 'artist':
                        stream_count = MediaStreamHistory.query.filter(
                            MediaStreamHistory.server_id == library.server_id,
                            MediaStreamHistory.library_name == library.name,
                            MediaStreamHistory.grandparent_title == media_item.title
                        ).count()
                    else:  # album
                        stream_count = MediaStreamHistory.query.filter(
                            MediaStreamHistory.server_id == library.server_id,
                            MediaStreamHistory.library_name == library.name,
                            MediaStreamHistory.parent_title == media_item.title
                        ).count()
                else:
                    # For other media types, try exact title match
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == library.server_id,
                        MediaStreamHistory.library_name == library.name,
                        MediaStreamHistory.media_title == media_item.title
                    ).count()
                
                item_dict['stream_count'] = stream_count
                all_items.append(item_dict)
            
            # Sort ALL items by stream count
            reverse_order = sort_by.endswith('_desc')
            all_items.sort(key=lambda x: x.get('stream_count', 0), reverse=reverse_order)
            current_app.logger.debug(f"Sorted ALL {len(all_items)} items by stream count ({'descending' if reverse_order else 'ascending'})")
            if all_items:
                current_app.logger.debug(f"Top item after sorting: '{all_items[0].get('title')}' with {all_items[0].get('stream_count', 0)} streams")
            
            # Apply manual pagination to the sorted results
            start_idx = (page - 1) * per_page
            end_idx = start_idx + per_page
            items = all_items[start_idx:end_idx]
            
            # Calculate pagination info
            total_pages = (total_items + per_page - 1) // per_page
            
            return {
                'items': items,
                'total': total_items,
                'page': page,
                'per_page': per_page,
                'pages': total_pages,
                'has_prev': page > 1,
                'has_next': page < total_pages,
                'needs_sync': total_items == 0
            }
        
        else:
            # For non-stream sorting, use normal database-level sorting and pagination
            # Get total count for pagination
            total_items = query.count()
            
            # Apply pagination
            paginated_query = query.paginate(
                page=page, per_page=per_page, error_out=False
            )
            
            # Convert MediaItem objects to dict format and add stream counts
            items = []
            for media_item in paginated_query.items:
                item_dict = media_item.to_dict()
                
                # Get stream count for this media item
                if media_item.item_type == 'show':
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == library.server_id,
                        MediaStreamHistory.library_name == library.name,
                        MediaStreamHistory.grandparent_title == media_item.title
                    ).count()
                elif media_item.item_type == 'movie':
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == library.server_id,
                        MediaStreamHistory.library_name == library.name,
                        MediaStreamHistory.media_title == media_item.title
                    ).count()
                elif media_item.item_type in ['artist', 'album']:
                    if media_item.item_type == 'artist':
                        stream_count = MediaStreamHistory.query.filter(
                            MediaStreamHistory.server_id == library.server_id,
                            MediaStreamHistory.library_name == library.name,
                            MediaStreamHistory.grandparent_title == media_item.title
                        ).count()
                    else:  # album
                        stream_count = MediaStreamHistory.query.filter(
                            MediaStreamHistory.server_id == library.server_id,
                            MediaStreamHistory.library_name == library.name,
                            MediaStreamHistory.parent_title == media_item.title
                        ).count()
                else:
                    # For other media types, try exact title match
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == library.server_id,
                        MediaStreamHistory.library_name == library.name,
                        MediaStreamHistory.media_title == media_item.title
                    ).count()
                
                item_dict['stream_count'] = stream_count
                items.append(item_dict)
            
            return {
                'items': items,
                'total': total_items,
                'page': page,
                'per_page': per_page,
                'pages': paginated_query.pages,
                'has_prev': paginated_query.has_prev,
                'has_next': paginated_query.has_next,
                'needs_sync': total_items == 0  # Only needs sync if no items at all
            }
        
    except Exception as e:
        current_app.logger.error(f"Error fetching media content for library {library.name}: {e}")
        return {
            'items': [],
            'total': 0,
            'page': page,
            'per_page': per_page,
            'pages': 0,
            'has_prev': False,
            'has_next': False,
            'error': str(e)
        }
