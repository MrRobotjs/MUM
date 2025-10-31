from flask import Blueprint, current_app, request, send_from_directory
from flask_login import login_required
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from app.models import User, UserType, Invite, HistoryLog
from app.models_media_services import MediaStreamHistory
from app.extensions import db
from app.utils.helpers import setup_required, permission_required, format_duration
from app.services.media_service_factory import MediaServiceFactory
from app.services.media_service_manager import MediaServiceManager
import os

bp = Blueprint('dashboard', __name__)

def _generate_watch_statistics_data(days=7, service_filters=None):
    """Generate comprehensive watch statistics data similar to Tautulli"""
    from datetime import datetime, timezone, timedelta
    from collections import defaultdict
    from sqlalchemy import func, desc
    
    # Calculate date range
    end_date = datetime.now(timezone.utc)
    if days == -1:  # All time
        earliest_stream = MediaStreamHistory.query.order_by(MediaStreamHistory.started_at.asc()).first()
        if earliest_stream:
            start_date = earliest_stream.started_at
        else:
            start_date = end_date - timedelta(days=7)  # Fallback to 7 days
    else:
        start_date = end_date - timedelta(days=days-1)
    
    # Base query for the time period
    base_query = MediaStreamHistory.query.filter(
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    )
    
    # Add service filtering if specified
    if service_filters and len(service_filters) > 0:
        from app.models_media_services import MediaServer, ServiceType
        # Join with MediaServer to filter by service type
        base_query = base_query.join(MediaServer, MediaStreamHistory.server_id == MediaServer.id)
        base_query = base_query.filter(MediaServer.service_type.in_([ServiceType(service) for service in service_filters]))
    
    # 1. Top Movies (by play count)
    top_movies = base_query.filter(
        MediaStreamHistory.media_type.in_(['movie', 'film'])
    ).with_entities(
        MediaStreamHistory.media_title,
        func.count(MediaStreamHistory.id).label('play_count'),
        func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration')
    ).group_by(MediaStreamHistory.media_title).order_by(desc('play_count')).limit(5).all()
    
    # 2. Top TV Shows (by play count)
    top_shows = base_query.filter(
        MediaStreamHistory.media_type.in_(['show', 'episode', 'tv', 'series'])
    ).with_entities(
        MediaStreamHistory.media_title,
        func.count(MediaStreamHistory.id).label('play_count'),
        func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration')
    ).group_by(MediaStreamHistory.media_title).order_by(desc('play_count')).limit(5).all()
    
    # 3. Top Platforms/Clients (by play count)
    top_platforms = base_query.with_entities(
        MediaStreamHistory.platform,
        func.count(MediaStreamHistory.id).label('play_count'),
        func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration')
    ).group_by(MediaStreamHistory.platform).order_by(desc('play_count')).limit(5).all()
    
    # 4. Overall Statistics
    total_stats = base_query.with_entities(
        func.count(MediaStreamHistory.id).label('total_plays'),
        func.sum(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('total_duration'),
        func.count(func.distinct(MediaStreamHistory.media_title)).label('unique_titles'),
        func.count(func.distinct(MediaStreamHistory.user_uuid)).label('unique_users')
    ).first()
    
    # 5. Most Concurrent Streams (approximate - count max streams per day)
    # This is a simplified version - for true concurrent streams you'd need more complex logic
    daily_stream_counts = base_query.with_entities(
        func.date(MediaStreamHistory.started_at).label('stream_date'),
        func.count(MediaStreamHistory.id).label('daily_count')
    ).group_by(func.date(MediaStreamHistory.started_at)).order_by(desc('daily_count')).first()
    
    # 6. Average Session Length
    avg_session = base_query.with_entities(
        func.avg(func.coalesce(MediaStreamHistory.duration_seconds, MediaStreamHistory.view_offset_at_end_seconds, 60)).label('avg_duration')
    ).first()
    
    # Format the data
    watch_stats = {
        'top_movies': [
            {
                'title': movie.media_title or 'Unknown Movie',
                'plays': movie.play_count,
                'duration': format_duration(int(movie.total_duration or 0))
            } for movie in top_movies
        ],
        'top_shows': [
            {
                'title': show.media_title or 'Unknown Show',
                'plays': show.play_count,
                'duration': format_duration(int(show.total_duration or 0))
            } for show in top_shows
        ],
        'top_platforms': [
            {
                'name': platform.platform or 'Unknown Platform',
                'plays': platform.play_count,
                'duration': format_duration(int(platform.total_duration or 0))
            } for platform in top_platforms
        ],
        'total_plays': total_stats.total_plays or 0,
        'total_duration': format_duration(int(total_stats.total_duration or 0)),
        'unique_titles': total_stats.unique_titles or 0,
        'unique_users': total_stats.unique_users or 0,
        'avg_session_length': format_duration(int(avg_session.avg_duration or 0)) if avg_session.avg_duration else '0 min',
        'peak_day_streams': daily_stream_counts.daily_count if daily_stream_counts else 0
    }
    
    return watch_stats

def _generate_top_users_data(days=7, limit=5):
    """Generate top users data for admin dashboard"""
    from datetime import datetime, timezone, timedelta
    from collections import defaultdict
    from sqlalchemy import func
    
    # Calculate date range
    end_date = datetime.now(timezone.utc)
    if days == -1:  # All time
        earliest_stream = MediaStreamHistory.query.order_by(MediaStreamHistory.started_at.asc()).first()
        if earliest_stream:
            start_date = earliest_stream.started_at
        else:
            start_date = end_date - timedelta(days=7)  # Fallback to 7 days
    else:
        start_date = end_date - timedelta(days=days-1)
    
    # Query to get top users by total watch time
    user_stats = db.session.query(
        MediaStreamHistory.user_uuid,
        func.count(MediaStreamHistory.id).label('stream_count'),
        func.sum(
            func.coalesce(
                MediaStreamHistory.duration_seconds,
                MediaStreamHistory.view_offset_at_end_seconds,
                60  # Default 1 minute for streams without duration
            )
        ).label('total_seconds')
    ).filter(
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    ).group_by(
        MediaStreamHistory.user_uuid
    ).order_by(
        func.sum(
            func.coalesce(
                MediaStreamHistory.duration_seconds,
                MediaStreamHistory.view_offset_at_end_seconds,
                60
            )
        ).desc()
    ).limit(limit).all()
    
    top_users = []
    for stat in user_stats:
        user_display_name = "Unknown User"
        user_avatar = None
        service_info = []
        
        # Get user info using unified user_uuid
        user = User.query.filter_by(uuid=stat.user_uuid).first()
        if user:
            user_display_name = user.get_display_name()
            user_avatar = user.get_avatar()
            
            if user.userType == UserType.LOCAL:
                # Get all services this user has access to
                linked_service_users = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=user.uuid).all()
                for service_user in linked_service_users:
                    if service_user.server:
                        service_info.append({
                            'type': service_user.server.service_type.value,
                            'name': service_user.server.server_nickname
                        })
            elif user.userType == UserType.SERVICE and user.server:
                service_info.append({
                    'type': user.server.service_type.value,
                    'name': user.server.server_nickname
                })
        
        # Remove duplicates from service_info
        unique_services = []
        seen_services = set()
        for service in service_info:
            service_key = f"{service['type']}_{service['name']}"
            if service_key not in seen_services:
                unique_services.append(service)
                seen_services.add(service_key)
        
        # Get category breakdown for this user (both duration and play count)
        category_query = db.session.query(
            MediaStreamHistory.media_type,
            func.sum(
                func.coalesce(
                    MediaStreamHistory.duration_seconds,
                    MediaStreamHistory.view_offset_at_end_seconds,
                    60
                )
            ).label('category_seconds'),
            func.count(MediaStreamHistory.id).label('category_plays')
        ).filter(
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date
        )
        
        # Add user filter using unified user_uuid
        category_query = category_query.filter(MediaStreamHistory.user_uuid == stat.user_uuid)
        
        category_stats = category_query.group_by(MediaStreamHistory.media_type).all()
        
        # Map media types to categories (both duration and plays)
        categories = {
            'tv': {'seconds': 0, 'plays': 0},
            'movies': {'seconds': 0, 'plays': 0},
            'music': {'seconds': 0, 'plays': 0},
            'photos': {'seconds': 0, 'plays': 0}
        }
        
        for category_stat in category_stats:
            media_type = (category_stat.media_type or '').lower()
            seconds = int(category_stat.category_seconds or 0)
            plays = int(category_stat.category_plays or 0)
            
            if media_type in ['show', 'episode', 'tv', 'series']:
                categories['tv']['seconds'] += seconds
                categories['tv']['plays'] += plays
            elif media_type in ['movie', 'film']:
                categories['movies']['seconds'] += seconds
                categories['movies']['plays'] += plays
            elif media_type in ['track', 'music', 'audio', 'song']:
                categories['music']['seconds'] += seconds
                categories['music']['plays'] += plays
            elif media_type in ['photo', 'image', 'picture']:
                categories['photos']['seconds'] += seconds
                categories['photos']['plays'] += plays
            else:
                # Default unknown types to TV
                categories['tv']['seconds'] += seconds
                categories['tv']['plays'] += plays
        
        # Format category durations and plays
        formatted_categories = {}
        for cat, data in categories.items():
            if data['seconds'] > 0:
                formatted_categories[cat] = f"{format_duration(data['seconds'])} ({data['plays']} plays)"
            else:
                formatted_categories[cat] = '0 min (0 plays)'
        
        total_seconds = int(stat.total_seconds or 0)
        
        # Get primary service type for CSS class
        primary_service_type = 'gray'  # Default fallback
        if unique_services:
            primary_service_type = unique_services[0]['type']
        
        # Get primary server info for linking
        primary_server_nickname = None
        primary_server_username = None
        if user and user.userType == UserType.SERVICE and user.server:
            primary_server_nickname = user.server.server_nickname
            primary_server_username = user.external_username
        
        top_users.append({
            'display_name': user_display_name,
            'avatar_url': user_avatar,
            'stream_count': stat.stream_count,
            'total_duration': format_duration(total_seconds),
            'total_seconds': total_seconds,
            'services': unique_services[:3],  # Show max 3 services to avoid clutter
            'categories': formatted_categories,
            'primary_service_type': primary_service_type,
            'server_nickname': primary_server_nickname,
            'server_username': primary_server_username
        })
    
    return top_users

def _generate_admin_streaming_chart_data(days=7):
    """Generate streaming chart data for admin dashboard - stacked by service within each period"""
    from datetime import datetime, timezone, timedelta
    from collections import defaultdict
    
    # Calculate date range
    end_date = datetime.now(timezone.utc)
    if days == -1:  # All time
        earliest_stream = MediaStreamHistory.query.order_by(MediaStreamHistory.started_at.asc()).first()
        if earliest_stream:
            start_date = earliest_stream.started_at
        else:
            start_date = end_date - timedelta(days=7)  # Fallback to 7 days
    else:
        start_date = end_date - timedelta(days=days-1)
    
    # Get all streaming history for the date range
    streaming_history = MediaStreamHistory.query.filter(
        MediaStreamHistory.started_at >= start_date,
        MediaStreamHistory.started_at <= end_date
    ).all()
    
    if not streaming_history:
        return {
            'chart_data': [],
            'services': [],
            'total_streams': 0,
            'total_duration': '0m',
            'most_active_service': 'None',
            'date_range_days': days
        }
    
    # Service color mapping
    service_colors = {
        'plex': '#e5a00d',
        'jellyfin': '#a855f7', 
        'emby': '#22c55e',
        'kavita': '#06b6d4',
        'audiobookshelf': '#8b5cf6',
        'komga': '#f97316',
        'romm': '#8b5cf6'
    }
    
    # Determine grouping strategy based on days
    group_by_week = days in [30, 90]
    
    # Group data by period and service
    grouped_data = defaultdict(lambda: defaultdict(float))  # [period_key][service] = minutes
    service_totals = defaultdict(float)  # Total watch time per service
    service_counts = defaultdict(int)  # Stream counts per service
    total_duration_seconds = 0
    
    for entry in streaming_history:
        entry_date = entry.started_at.date()
        
        # Determine period key based on grouping strategy
        if group_by_week:
            # Group by week - find the Monday of the week containing this date
            days_since_monday = entry_date.weekday()
            week_start = entry_date - timedelta(days=days_since_monday)
            period_key = week_start.isoformat()
        else:
            # Group by day
            period_key = entry_date.isoformat()
        
        # Get service type from the server
        service_type = 'unknown'
        if entry.user_uuid:
            user = User.query.filter_by(uuid=entry.user_uuid).first()
            if user and user.server:
                service_type = user.server.service_type.value
        
        # Get duration in minutes
        duration_minutes = 0
        if entry.duration_seconds and entry.duration_seconds > 0:
            duration_minutes = entry.duration_seconds / 60
            total_duration_seconds += entry.duration_seconds
        elif entry.view_offset_at_end_seconds and entry.view_offset_at_end_seconds > 0:
            duration_minutes = entry.view_offset_at_end_seconds / 60
            total_duration_seconds += entry.view_offset_at_end_seconds
        else:
            duration_minutes = 1  # 1 minute minimum to show activity
        
        # Add to grouped data
        grouped_data[period_key][service_type] += duration_minutes
        service_totals[service_type] += duration_minutes
        service_counts[service_type] += 1
    
    # Generate chart data for the date range
    chart_data_list = []
    start_date_only = start_date.date() if hasattr(start_date, 'date') else start_date
    end_date_only = end_date.date() if hasattr(end_date, 'date') else end_date
    
    if group_by_week:
        # Generate week periods
        # Start from the Monday of the week containing start_date
        days_since_monday = start_date_only.weekday()
        current_week_start = start_date_only - timedelta(days=days_since_monday)
        
        while current_week_start <= end_date_only:
            week_end = current_week_start + timedelta(days=6)
            period_key = current_week_start.isoformat()
            
            # Create label for the week
            if current_week_start.month == week_end.month:
                week_label = f"{current_week_start.strftime('%b %d')}-{week_end.strftime('%d')}"
            else:
                week_label = f"{current_week_start.strftime('%b %d')}-{week_end.strftime('%b %d')}"
            
            period_data = {'date': period_key, 'label': week_label}
            
            # Add service watch times for this week (in minutes)
            for service_type in service_totals.keys():
                period_data[service_type] = round(grouped_data[period_key].get(service_type, 0), 1)
            
            chart_data_list.append(period_data)
            current_week_start += timedelta(days=7)
    else:
        # Generate daily periods
        current_date = start_date_only
        while current_date <= end_date_only:
            day_key = current_date.isoformat()
            day_label = current_date.strftime('%b %d')
            
            period_data = {'date': day_key, 'label': day_label}
            
            # Add service watch times for this day (in minutes)
            for service_type in service_totals.keys():
                period_data[service_type] = round(grouped_data[day_key].get(service_type, 0), 1)
            
            chart_data_list.append(period_data)
            current_date += timedelta(days=1)
    
    # Prepare service information for legend
    services = []
    for service_type, total_minutes in service_totals.items():
        service_color = service_colors.get(service_type, '#64748b')
        
        services.append({
            'type': service_type,
            'name': service_type.title(),
            'watch_time': format_duration(total_minutes * 60),  # Convert back to seconds
            'count': service_counts[service_type],
            'color': service_color
        })
    
    # Sort services by watch time (descending)
    services.sort(key=lambda x: service_totals[x['type']], reverse=True)
    
    # Calculate summary stats
    total_streams = sum(service_counts.values())
    most_active_service = services[0]['name'] if services else 'None'
    total_duration_formatted = format_duration(total_duration_seconds)
    
    return {
        'chart_data': chart_data_list,
        'services': services,
        'total_streams': total_streams,
        'total_duration': total_duration_formatted,
        'most_active_service': most_active_service,
        'date_range_days': days
    }

def _render_react_spa(sub_path: str = 'dashboard'):
    """Serve the compiled React SPA instead of legacy templates."""
    dist_path = os.path.join(current_app.root_path, 'static', 'dist')
    index_path = os.path.join(dist_path, 'index.html')

    if not os.path.exists(index_path):
        current_app.logger.error("React SPA build not found at %s", index_path)
        current_app.logger.error("Please run: cd frontend && npm run build")
        return (
            "<h1>React App Not Built</h1>"
            "<p>The React admin interface has not been built yet.</p>"
            "<p>Please run: <code>cd frontend && npm run build</code></p>"
        ), 500

    current_app.logger.debug("Routing admin %s view to React SPA", sub_path)
    return send_from_directory(dist_path, 'index.html')


@bp.route('/')
@bp.route('/dashboard')
@login_required
@setup_required
@permission_required('view_dashboard')
def index():
    return _render_react_spa('dashboard')

@bp.route('/account', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('manage_general_settings')
def account():
    return _render_react_spa('account')
# DEPRECATED: Legacy Flask SSR route file. Replaced by React SPA.
