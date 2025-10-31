# File: app/routes/user_modules/helpers_deprecated.py
"""DEPRECATED: Legacy SSR user helper utilities (replaced by SPA at /user)."""

from datetime import datetime, timezone, timedelta
from collections import defaultdict
from flask import current_app
from app.models_media_services import MediaStreamHistory
from app.models import User, UserType
from app.extensions import db
from app.utils.helpers import format_duration
import calendar


def _generate_streaming_chart_data(user, days=30, group_by='library_type'):
    """Generate streaming history chart data for the specified number of days"""
    from datetime import datetime, timezone, timedelta
    from collections import defaultdict
    from app.utils.helpers import format_duration
    import calendar
    
    # Calculate date range based on days parameter
    end_date = datetime.now(timezone.utc)
    if days == -1:  # All time
        # Get the earliest stream date for this user
        earliest_stream = MediaStreamHistory.query.filter(
            MediaStreamHistory.user_uuid == user.uuid
        ).order_by(MediaStreamHistory.started_at.asc()).first()
        
        if earliest_stream:
            start_date = earliest_stream.started_at
        else:
            start_date = end_date - timedelta(days=30)  # Fallback to 30 days
    else:
        # For daily periods, we want exactly 'days' number of days including today
        # So if days=7, we want 7 days total: today + 6 previous days
        start_date = end_date - timedelta(days=days-1)
    
    # Get streaming history for this user
    current_app.logger.info(f"CHART DATA DEBUG: Querying MediaStreamHistory for user_uuid={user.uuid}")
    current_app.logger.info(f"CHART DATA DEBUG: Date range: {start_date} to {end_date}")
    
    # For local users, we need to include both local and linked service account history
    if user.userType == UserType.LOCAL:
        # Get all linked service accounts for this local user
        linked_service_accounts = User.query.filter_by(userType=UserType.SERVICE).filter_by(
            linkedUserId=user.uuid
        ).all()
        
        current_app.logger.info(f"CHART DATA DEBUG: Found {len(linked_service_accounts)} linked service accounts")
        for sa in linked_service_accounts:
            current_app.logger.info(f"CHART DATA DEBUG: Linked account: {sa.server.server_nickname} - {sa.external_username} (uuid: {sa.uuid})")
        
        # Build query to include both direct and linked account history
        if linked_service_accounts:
            linked_uuids = [sa.uuid for sa in linked_service_accounts]
            all_user_uuids = [user.uuid] + linked_uuids
            history_query = MediaStreamHistory.query.filter(
                MediaStreamHistory.user_uuid.in_(all_user_uuids),
                MediaStreamHistory.started_at >= start_date,
                MediaStreamHistory.started_at <= end_date
            )
        else:
            # No linked accounts, use direct history only
            history_query = MediaStreamHistory.query.filter(
                MediaStreamHistory.user_uuid == user.uuid,
                MediaStreamHistory.started_at >= start_date,
                MediaStreamHistory.started_at <= end_date
            )
    else:
        # For service users, use the unified user_uuid
        history_query = MediaStreamHistory.query.filter(
            MediaStreamHistory.user_uuid == user.uuid,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date
        )
    
    streaming_history = history_query.all()
    
    current_app.logger.info(f"CHART DATA DEBUG: Found {len(streaming_history)} streaming history records")
    
    # Log sample records for debugging
    if streaming_history:
        current_app.logger.info(f"CHART DATA DEBUG: Sample records (first 3):")
        for i, record in enumerate(streaming_history[:3]):
            current_app.logger.info(f"CHART DATA DEBUG: Record {i+1}: {record.media_title} at {record.started_at}")
            current_app.logger.info(f"CHART DATA DEBUG:   - Duration: {record.duration_seconds}s, Media Type: {record.media_type}")
            current_app.logger.info(f"CHART DATA DEBUG:   - User UUID: {record.user_uuid}")
    
    if not streaming_history:
        current_app.logger.info("CHART DATA DEBUG: No streaming history found, returning empty chart data")
        # Return empty chart data structure instead of None
        return {
            'chart_data': [],
            'services': [],
            'service_content_combinations': [],
            'content_colors': {},
            'total_streams': 0,
            'total_duration': '0m',
            'most_active_service': 'None',
            'date_range_days': days
        }
    
    # Service color mapping
    service_colors = {
        'plex': 'var(--color-plex)',
        'jellyfin': 'var(--color-jellyfin)', 
        'emby': 'var(--color-emby)',
        'kavita': 'var(--color-kavita)',
        'audiobookshelf': 'var(--color-audiobookshelf)',
        'komga': 'var(--color-komga)',
        'romm': 'var(--color-romm)'
    }
    
    # Determine grouping strategy based on days parameter
    if days == 7:
        # Last 7 days: Show daily
        grouping_type = 'daily'
    elif days in [30, 90]:
        # Last 30/90 days: Group into 7-day periods
        grouping_type = 'weekly'
    elif days == 365 or days == -1:
        # Last year or all time: Group by months
        grouping_type = 'monthly'
    else:
        # Default to daily for any other values
        grouping_type = 'daily'
    
    # Group data by appropriate time period, service, and content type
    if grouping_type == 'monthly':
        grouped_data = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # [year_month][service][content_type]
    elif grouping_type == 'weekly':
        grouped_data = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # [week_start_date][service][content_type]
    else:  # daily
        grouped_data = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # [date][service][content_type]
    
    service_content_totals = defaultdict(lambda: defaultdict(int))  # [service][content_type]
    service_totals = defaultdict(int)  # Total watch time per service
    service_counts = defaultdict(int)  # Stream counts per service
    total_duration_seconds = 0
    
    current_app.logger.info(f"CHART DATA DEBUG: Processing {len(streaming_history)} streaming records...")
    
    for i, entry in enumerate(streaming_history):
        # Get the date (without time)
        entry_date = entry.started_at.date()
        
        # Determine the grouping key based on grouping type
        if grouping_type == 'monthly':
            # Group by year-month (e.g., "2024-01")
            group_key = entry_date.strftime('%Y-%m')
        elif grouping_type == 'weekly':
            # Group by week start date (Monday of the week)
            days_since_monday = entry_date.weekday()
            week_start = entry_date - timedelta(days=days_since_monday)
            group_key = week_start.isoformat()
        else:  # daily
            group_key = entry_date.isoformat()
        
        # Get service type from the server
        service_type = 'unknown'
        if entry.user_uuid:
            user_access = User.query.filter_by(uuid=entry.user_uuid).first()
            if user_access and user_access.server:
                service_type = user_access.server.service_type.value
                if i < 5:  # Only log first 5 records to avoid spam
                    current_app.logger.info(f"CHART DATA DEBUG: Record {i+1} - Found service: {service_type} ({user_access.server.server_nickname})")
            else:
                if i < 5:
                    current_app.logger.info(f"CHART DATA DEBUG: Record {i+1} - No service found for user_uuid: {entry.user_uuid}")
        else:
            if i < 5:
                current_app.logger.info(f"CHART DATA DEBUG: Record {i+1} - No user_uuid")
        
        # Determine grouping category based on group_by parameter
        if group_by == 'library_name':
            # Group by library name
            grouping_category = entry.library_name or 'Unknown Library'
        else:
            # Group by library type (content type) - default behavior
            content_type = 'mixed'
            if entry.media_type:
                media_type = entry.media_type.lower()
                if media_type in ['movie', 'film']:
                    content_type = 'movies'
                elif media_type in ['episode', 'show', 'series']:
                    content_type = 'tv_shows'
                elif media_type in ['track', 'song', 'album']:
                    content_type = 'music'
                elif media_type in ['book', 'audiobook']:
                    content_type = 'books'
                elif media_type in ['comic', 'manga']:
                    content_type = 'comics'
                else:
                    content_type = media_type
            else:
                # Fallback to service-based categorization
                if service_type == 'kavita':
                    content_type = 'comics'
                elif service_type == 'audiobookshelf':
                    content_type = 'books'
                elif service_type == 'komga':
                    content_type = 'comics'
                elif service_type == 'romm':
                    content_type = 'games'
                else:
                    content_type = 'mixed'
            grouping_category = content_type
        
        # Get duration in minutes for the chart
        duration_minutes = 0
        if entry.duration_seconds and entry.duration_seconds > 0:
            # Completed session - use real final duration
            duration_minutes = entry.duration_seconds / 60  # Convert to minutes
            total_duration_seconds += entry.duration_seconds
            if i < 5:
                current_app.logger.info(f"CHART DATA DEBUG: Record {i+1} - Completed session duration: {entry.duration_seconds}s ({duration_minutes:.1f}m)")
        elif entry.view_offset_at_end_seconds and entry.view_offset_at_end_seconds > 0:
            # Active/recent session - use current progress as estimated duration
            duration_minutes = entry.view_offset_at_end_seconds / 60  # Convert to minutes
            total_duration_seconds += entry.view_offset_at_end_seconds  # Add estimated time to total
            if i < 5:
                current_app.logger.info(f"CHART DATA DEBUG: Record {i+1} - Active session estimated duration: {entry.view_offset_at_end_seconds}s ({duration_minutes:.1f}m)")
        else:
            # No data available - use small default value so streams show up on the chart
            duration_minutes = 1  # 1 minute minimum to show activity
            if i < 5:
                current_app.logger.info(f"CHART DATA DEBUG: Record {i+1} - No duration or progress data, using 1m default")
        
        if i < 5:
            current_app.logger.info(f"CHART DATA DEBUG: Record {i+1} - Final: {service_type}_{grouping_category} = {duration_minutes:.1f}m on {group_key}")
        
        # Add watch time per group per service per grouping category (in minutes)
        grouped_data[group_key][service_type][grouping_category] += duration_minutes
        service_content_totals[service_type][grouping_category] += duration_minutes
        service_totals[service_type] += duration_minutes
        service_counts[service_type] += 1
    
    # Generate chart data for the date range (including periods with no activity)
    chart_data_list = []
    
    # Create datasets for each service-grouping combination
    service_content_combinations = []
    for service_type in service_totals.keys():
        for grouping_category in service_content_totals[service_type].keys():
            service_content_combinations.append(f"{service_type}_{grouping_category}")
    
    # Generate time periods based on grouping type
    if grouping_type == 'monthly':
        # Generate monthly periods
        # Ensure both dates are timezone-aware and normalized to month boundaries
        if start_date.tzinfo is None:
            # If start_date is naive, make it timezone-aware
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date.tzinfo is None:
            # If end_date is naive, make it timezone-aware  
            end_date = end_date.replace(tzinfo=timezone.utc)
            
        # Normalize to first day of month with same timezone
        current_date = start_date.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end_date_month = end_date.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        
        while current_date <= end_date_month:
            month_key = current_date.strftime('%Y-%m')
            month_label = current_date.strftime('%b %Y')
            
            period_data = {'date': month_key, 'label': month_label}
            
            # Add service-grouping watch times for this month (in minutes)
            for service_type in service_totals.keys():
                for grouping_category in service_content_totals[service_type].keys():
                    combination_key = f"{service_type}_{grouping_category}"
                    period_data[combination_key] = round(grouped_data[month_key][service_type].get(grouping_category, 0), 1)
            
            chart_data_list.append(period_data)
            
            # Move to next month
            if current_date.month == 12:
                current_date = current_date.replace(year=current_date.year + 1, month=1)
            else:
                current_date = current_date.replace(month=current_date.month + 1)
                
    elif grouping_type == 'weekly':
        # Generate weekly periods
        # Start from the Monday of the week containing start_date
        # Ensure we're working with date objects consistently
        start_date_only = start_date.date() if hasattr(start_date, 'date') else start_date
        end_date_only = end_date.date() if hasattr(end_date, 'date') else end_date
        
        days_since_monday = start_date_only.weekday()
        current_week_start = start_date_only - timedelta(days=days_since_monday)
        
        while current_week_start <= end_date_only:
            week_key = current_week_start.isoformat()
            week_end = current_week_start + timedelta(days=6)
            
            # Create label for the week
            if current_week_start.month == week_end.month:
                week_label = f"{current_week_start.strftime('%b %d')}-{week_end.day}"
            else:
                week_label = f"{current_week_start.strftime('%b %d')}-{week_end.strftime('%b %d')}"
            
            period_data = {'date': week_key, 'label': week_label}
            
            # Add service-grouping watch times for this week (in minutes)
            for service_type in service_totals.keys():
                for grouping_category in service_content_totals[service_type].keys():
                    combination_key = f"{service_type}_{grouping_category}"
                    period_data[combination_key] = round(grouped_data[week_key][service_type].get(grouping_category, 0), 1)
            
            chart_data_list.append(period_data)
            current_week_start += timedelta(days=7)
            
    else:  # daily
        # Generate daily periods (existing logic)
        # Ensure we're working with date objects consistently
        start_date_only = start_date.date() if hasattr(start_date, 'date') else start_date
        end_date_only = end_date.date() if hasattr(end_date, 'date') else end_date
        
        current_date = start_date_only
        while current_date <= end_date_only:
            day_key = current_date.isoformat()
            day_label = current_date.strftime('%b %d')
            
            period_data = {'date': day_key, 'label': day_label}
            
            # Add service-grouping watch times for this day (in minutes)
            for service_type in service_totals.keys():
                for grouping_category in service_content_totals[service_type].keys():
                    combination_key = f"{service_type}_{grouping_category}"
                    period_data[combination_key] = round(grouped_data[day_key][service_type].get(grouping_category, 0), 1)
            
            chart_data_list.append(period_data)
            current_date += timedelta(days=1)
    
    # Generate colors for grouping categories
    if group_by == 'library_name':
        # For library names, generate colors dynamically
        content_colors = {}
        library_names = set()
        for service_type in service_content_totals.keys():
            library_names.update(service_content_totals[service_type].keys())
        
        # Predefined colors for common library names
        predefined_colors = [
            '#ef4444',  # Red
            '#3b82f6',  # Blue  
            '#10b981',  # Green
            '#f59e0b',  # Amber
            '#8b5cf6',  # Purple
            '#06b6d4',  # Cyan
            '#ec4899',  # Pink
            '#84cc16',  # Lime
            '#f97316',  # Orange
            '#6366f1',  # Indigo
            '#14b8a6',  # Teal
            '#f43f5e',  # Rose
        ]
        
        for i, library_name in enumerate(sorted(library_names)):
            content_colors[library_name] = predefined_colors[i % len(predefined_colors)]
    else:
        # Content type color mapping (default)
        content_colors = {
            'movies': '#ef4444',      # Red
            'tv_shows': '#3b82f6',    # Blue  
            'music': '#10b981',       # Green
            'books': '#f59e0b',       # Amber
            'comics': '#8b5cf6',      # Purple
            'games': '#06b6d4',       # Cyan
            'mixed': '#6b7280',       # Gray
            'unknown': '#64748b'      # Slate
        }
    
    # Prepare service information for legend (with content breakdown)
    services = []
    for service_type, total_minutes in service_totals.items():
        # Get service colors from the original mapping
        service_color = service_colors.get(service_type, '#64748b')
        
        services.append({
            'type': service_type,
            'name': service_type.title(),
            'watch_time': format_duration(total_minutes * 60),  # Convert back to seconds for formatting
            'count': service_counts[service_type],
            'color': service_color,
            'content_breakdown': service_content_totals[service_type]
        })
    
    # Sort services by watch time (descending)
    services.sort(key=lambda x: service_totals[x['type']], reverse=True)
    
    # Calculate summary stats
    total_streams = sum(service_counts.values())
    most_active_service = services[0]['name'] if services else 'None'
    total_duration_formatted = format_duration(total_duration_seconds)
    
    # Final debugging output
    current_app.logger.info(f"CHART DATA DEBUG: === FINAL AGGREGATED DATA ===")
    current_app.logger.info(f"CHART DATA DEBUG: Service totals: {dict(service_totals)}")
    current_app.logger.info(f"CHART DATA DEBUG: Service counts: {dict(service_counts)}")
    current_app.logger.info(f"CHART DATA DEBUG: Total duration seconds: {total_duration_seconds}")
    current_app.logger.info(f"CHART DATA DEBUG: Total streams: {total_streams}")
    current_app.logger.info(f"CHART DATA DEBUG: Chart data points generated: {len(chart_data_list)}")
    
    # Count different types of sessions for debugging
    completed_sessions = sum(1 for entry in streaming_history if entry.duration_seconds and entry.duration_seconds > 0)
    active_sessions = sum(1 for entry in streaming_history if not (entry.duration_seconds and entry.duration_seconds > 0) and entry.view_offset_at_end_seconds and entry.view_offset_at_end_seconds > 0)
    fallback_sessions = len(streaming_history) - completed_sessions - active_sessions
    
    current_app.logger.info(f"CHART DATA DEBUG: Session breakdown:")
    current_app.logger.info(f"CHART DATA DEBUG: - Completed sessions (final duration): {completed_sessions}")
    current_app.logger.info(f"CHART DATA DEBUG: - Active sessions (estimated duration): {active_sessions}")
    current_app.logger.info(f"CHART DATA DEBUG: - Fallback sessions (1m default): {fallback_sessions}")
    
    # Log grouped data summary
    current_app.logger.info(f"CHART DATA DEBUG: Grouped data summary:")
    for date_key, services_data in list(grouped_data.items())[:3]:  # First 3 dates
        current_app.logger.info(f"CHART DATA DEBUG: Date {date_key}: {dict(services_data)}")
    
    current_app.logger.info(f"CHART DATA DEBUG: === END FINAL DATA ===")
    
    return {
        'chart_data': chart_data_list,
        'services': services,
        'service_content_combinations': service_content_combinations,
        'content_colors': content_colors,
        'total_streams': total_streams,
        'total_duration': total_duration_formatted,
        'most_active_service': most_active_service,
        'date_range_days': days
    }


def enhance_history_records_with_media_ids(history_records):
    """Enhance history records with MediaItem database IDs for clickable links"""
    from app.models_media_services import MediaItem, MediaLibrary
    
    for record in history_records:
        # Initialize the fields we'll add
        record.media_item_db_id = None
        record.show_media_item_db_id = None
        
        if not record.server or not record.library_name:
            continue
            
        # Find the library
        library = MediaLibrary.query.filter_by(
            server_id=record.server_id,
            name=record.library_name
        ).first()
        
        if not library:
            continue
        
        # For movies and episodes with external_media_item_id
        if record.external_media_item_id:
            media_item = MediaItem.query.filter_by(
                library_id=library.id,
                external_id=record.external_media_item_id
            ).first()
            if media_item:
                record.media_item_db_id = media_item.id
        
        # For TV shows (using rating_key when external_media_item_id is None)
        if record.grandparent_title and not record.external_media_item_id:
            # This is likely a show, use rating_key to find the show
            show_item = MediaItem.query.filter_by(
                library_id=library.id,
                external_id=record.rating_key
            ).first()
            if show_item:
                record.show_media_item_db_id = show_item.id
        
        # For episodes, also try to find the parent show using rating_key
        if record.grandparent_title and record.external_media_item_id:
            # This is an episode, try to find the parent show by title
            show_item = MediaItem.query.filter_by(
                library_id=library.id,
                title=record.grandparent_title,
                item_type='show'
            ).first()
            if show_item:
                record.show_media_item_db_id = show_item.id
    
    return history_records


def check_if_user_is_admin(user):
    """Check if a local user is an admin by looking up their linked service accounts"""
    if not user.userType == UserType.LOCAL:
        return False
    
    # Get the user's linked service accounts for Plex servers
    from app.models_media_services import MediaServer, ServiceType
    plex_servers = MediaServer.query.filter_by(service_type=ServiceType.PLEX).all()
    
    for plex_server in plex_servers:
        access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
            linkedUserId=user.uuid,
            server_id=plex_server.id
        ).first()
        
        if access and access.external_user_alt_id:  # external_user_alt_id is the plex_uuid
            # Check if this plex_uuid belongs to an Owner
            owner = User.query.filter_by(userType=UserType.OWNER).filter_by(plex_uuid=access.external_user_alt_id).first()
            if owner:
                return True
    
    return False


def get_libraries_from_database(servers):
    """
    Get library data from database - NO API CALLS
    Returns: {server_id: {lib_id: lib_name}} where lib_id is internal_id for Kavita, external_id for others
    """
    from app.models_media_services import MediaLibrary
    
    libraries_by_server = {}
    
    for server in servers:
        # Get libraries from database for this server
        db_libraries = MediaLibrary.query.filter_by(server_id=server.id).all()
        server_lib_dict = {}
        
        for lib in db_libraries:
            if server.service_type.value == 'kavita':
                # For Kavita, we should use internal_id as the primary key
                # but we need to migrate users who have external_id stored
                internal_id = getattr(lib, 'internal_id', None)
                
                if internal_id:
                    server_lib_dict[str(internal_id)] = lib.name
                    current_app.logger.debug(f"KAVITA DEBUG: Using internal_id '{internal_id}' -> '{lib.name}'")
                else:
                    # Fallback to external_id if internal_id is missing
                    server_lib_dict[str(lib.external_id)] = lib.name
                    current_app.logger.error(f"KAVITA DEBUG: Library '{lib.name}' has NO internal_id! external_id: '{lib.external_id}'")
            else:
                # Use external_id for other services
                lib_key = lib.external_id
                lib_name = lib.name
                if lib_key:
                    server_lib_dict[str(lib_key)] = lib_name
        
        libraries_by_server[server.id] = server_lib_dict
    
    return libraries_by_server


def _get_local_user_avatar_url(app_user):
    """Get avatar URL for local users by checking their linked media access accounts"""
    # Get all media access records for this local user
    access_records = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=app_user.uuid).all()
    
    for access in access_records:
        # First check for external avatar URL
        if access.external_avatar_url:
            return access.external_avatar_url
        elif access.server.service_type.value.lower() == 'plex':
            # For Plex, check multiple possible locations for the thumb URL
            thumb_url = None
            
            # First try service_settings
            if access.service_settings and access.service_settings.get('thumb'):
                thumb_url = access.service_settings['thumb']
            # Then try raw_data from the user sync
            elif access.user_raw_data and access.user_raw_data.get('thumb'):
                thumb_url = access.user_raw_data['thumb']
            # Also check nested raw data structure
            elif (access.user_raw_data and 
                  access.user_raw_data.get('plex_user_obj_attrs') and 
                  access.user_raw_data['plex_user_obj_attrs'].get('thumb')):
                thumb_url = access.user_raw_data['plex_user_obj_attrs']['thumb']
            
            if thumb_url:
                # Check if it's already a full URL (plex.tv avatars) or needs proxy
                if thumb_url.startswith('https://plex.tv/') or thumb_url.startswith('http://plex.tv/'):
                    return thumb_url
                else:
                    return f"/api/media/plex/images/proxy?path={thumb_url.lstrip('/')}"
        
        elif access.server.service_type.value.lower() == 'jellyfin':
            # For Jellyfin, use the external_user_id to get avatar
            if access.external_user_id:
                return f"/api/media/jellyfin/users/avatar?user_id={access.external_user_id}"
    
    # No avatar found
    return None


# MassEditMockUser class removed - now using unified User model directly (duplicate from users_modules/helpers.py)
