"""DEPRECATED: SSR statistics and analytics for libraries (use React + v2)."""

from flask import current_app
from app.models_media_services import MediaLibrary, MediaServer, MediaStreamHistory
from app.models import User, UserType
from app.extensions import db
from datetime import datetime, timezone, timedelta


def get_library_media_content(library, page=1, per_page=24, search_query='', sort_by='title_asc'):
    """Get media content from the library using cached data or live API"""
    try:
        from app.services.media_sync_service import MediaSyncService
        
        # Check if we have cached data that's recent enough
        if MediaSyncService.is_library_synced(library.id, max_age_hours=24):
            current_app.logger.debug(f"Using cached data for library {library.name}")
            return MediaSyncService.get_cached_library_content(library.id, page, per_page, search_query, sort_by)
        
        # Check if we have any cached data at all (regardless of age)
        cached_content = MediaSyncService.get_cached_library_content(library.id, page, per_page, search_query, sort_by)
        if cached_content and cached_content.get('items'):
            current_app.logger.debug(f"Using older cached data for library {library.name}")
            return cached_content
        
        # Return empty result - no cached data available, user needs to sync first
        current_app.logger.info(f"No cached data for library {library.name}, returning empty result. User needs to sync first.")
        return {
            'items': [],
            'total': 0,
            'page': page,
            'per_page': per_page,
            'pages': 0,
            'has_prev': False,
            'has_next': False,
            'needs_sync': True  # Flag to indicate sync is needed
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


def get_advanced_library_statistics(library, days=30):
    """Get advanced statistics for a library including trending content"""
    try:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        
        # Get streaming statistics for this library
        library_streams = db.session.query(MediaStreamHistory).filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date
        ).all()
        
        # Calculate advanced metrics
        stats = {
            'total_streams': len(library_streams),
            'unique_users': len(set(stream.user_uuid for stream in library_streams if stream.user_uuid)),
            'total_duration': sum(stream.duration_seconds or 0 for stream in library_streams),
            'average_session_length': 0,
            'peak_hours': {},
            'trending_content': [],
            'completion_rates': {}
        }
        
        # Calculate average session length
        if stats['total_streams'] > 0:
            stats['average_session_length'] = stats['total_duration'] / stats['total_streams']
        
        # Calculate peak viewing hours
        hour_counts = {}
        for stream in library_streams:
            hour = stream.started_at.hour
            hour_counts[hour] = hour_counts.get(hour, 0) + 1
        
        stats['peak_hours'] = dict(sorted(hour_counts.items(), key=lambda x: x[1], reverse=True)[:5])
        
        # Get trending content (most watched in the period)
        content_counts = {}
        for stream in library_streams:
            title = stream.media_title or 'Unknown'
            content_counts[title] = content_counts.get(title, 0) + 1
        
        stats['trending_content'] = [
            {'title': title, 'streams': count}
            for title, count in sorted(content_counts.items(), key=lambda x: x[1], reverse=True)[:10]
        ]
        
        return stats
        
    except Exception as e:
        current_app.logger.error(f"Error getting advanced library statistics: {e}")
        return {
            'total_streams': 0,
            'unique_users': 0,
            'total_duration': 0,
            'average_session_length': 0,
            'peak_hours': {},
            'trending_content': [],
            'completion_rates': {},
            'error': str(e)
        }


def generate_library_activity_heatmap(library, days=30):
    """Generate heatmap data for library activity by day and hour"""
    try:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        
        # Get all streams for the library in the time period
        streams = db.session.query(MediaStreamHistory).filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date
        ).all()
        
        # Initialize heatmap data structure
        heatmap_data = {}
        for day in range(7):  # 0 = Monday, 6 = Sunday
            heatmap_data[day] = {}
            for hour in range(24):
                heatmap_data[day][hour] = 0
        
        # Populate heatmap with stream counts
        for stream in streams:
            day_of_week = stream.started_at.weekday()  # 0 = Monday
            hour = stream.started_at.hour
            heatmap_data[day_of_week][hour] += 1
        
        # Convert to format suitable for frontend visualization
        heatmap_array = []
        day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        
        for day in range(7):
            for hour in range(24):
                heatmap_array.append({
                    'day': day_names[day],
                    'hour': hour,
                    'value': heatmap_data[day][hour]
                })
        
        return {
            'heatmap_data': heatmap_array,
            'max_value': max(item['value'] for item in heatmap_array) if heatmap_array else 0,
            'total_streams': len(streams)
        }
        
    except Exception as e:
        current_app.logger.error(f"Error generating library activity heatmap: {e}")
        return {
            'heatmap_data': [],
            'max_value': 0,
            'total_streams': 0,
            'error': str(e)
        }


def get_library_user_engagement_metrics(library, days=30):
    """Get detailed user engagement metrics for a library"""
    try:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        
        # Get user engagement data
        user_metrics = db.session.query(
            MediaStreamHistory.user_uuid,
            db.func.count(MediaStreamHistory.id).label('session_count'),
            db.func.sum(MediaStreamHistory.duration_seconds).label('total_watch_time'),
            db.func.avg(MediaStreamHistory.duration_seconds).label('avg_session_length'),
            db.func.count(db.func.distinct(MediaStreamHistory.media_title)).label('unique_content_watched'),
            db.func.max(MediaStreamHistory.started_at).label('last_activity')
        ).filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date,
            MediaStreamHistory.user_uuid.isnot(None)
        ).group_by(MediaStreamHistory.user_uuid).all()
        
        # Process metrics
        engagement_data = []
        for metric in user_metrics:
            # Get user info
            user = User.query.filter_by(uuid=metric.user_uuid).first()
            
            engagement_data.append({
                'user_uuid': metric.user_uuid,
                'username': user.localUsername if user else 'Unknown User',
                'session_count': metric.session_count,
                'total_watch_time': metric.total_watch_time or 0,
                'avg_session_length': metric.avg_session_length or 0,
                'unique_content_watched': metric.unique_content_watched,
                'last_activity': metric.last_activity,
                'engagement_score': calculate_engagement_score(
                    metric.session_count,
                    metric.total_watch_time or 0,
                    metric.unique_content_watched,
                    days
                )
            })
        
        # Sort by engagement score
        engagement_data.sort(key=lambda x: x['engagement_score'], reverse=True)
        
        return {
            'user_metrics': engagement_data,
            'total_active_users': len(engagement_data),
            'avg_sessions_per_user': sum(u['session_count'] for u in engagement_data) / len(engagement_data) if engagement_data else 0,
            'avg_watch_time_per_user': sum(u['total_watch_time'] for u in engagement_data) / len(engagement_data) if engagement_data else 0
        }
        
    except Exception as e:
        current_app.logger.error(f"Error getting user engagement metrics: {e}")
        return {
            'user_metrics': [],
            'total_active_users': 0,
            'avg_sessions_per_user': 0,
            'avg_watch_time_per_user': 0,
            'error': str(e)
        }


def calculate_engagement_score(session_count, total_watch_time, unique_content, days):
    """Calculate a user engagement score based on various factors"""
    try:
        # Normalize metrics
        sessions_per_day = session_count / days
        hours_per_day = (total_watch_time / 3600) / days
        content_diversity = unique_content
        
        # Weight different factors
        score = (
            sessions_per_day * 10 +  # Frequency weight
            hours_per_day * 5 +      # Duration weight
            content_diversity * 2    # Diversity weight
        )
        
        return round(score, 2)
        
    except Exception:
        return 0.0


def get_content_performance_metrics(library, days=30):
    """Get performance metrics for individual content items"""
    try:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        
        # Get content performance data
        content_metrics = db.session.query(
            MediaStreamHistory.media_title,
            MediaStreamHistory.media_type,
            db.func.count(MediaStreamHistory.id).label('total_streams'),
            db.func.count(db.func.distinct(MediaStreamHistory.user_uuid)).label('unique_viewers'),
            db.func.sum(MediaStreamHistory.duration_seconds).label('total_watch_time'),
            db.func.avg(MediaStreamHistory.duration_seconds).label('avg_watch_time'),
            db.func.max(MediaStreamHistory.started_at).label('last_watched')
        ).filter(
            MediaStreamHistory.server_id == library.server_id,
            MediaStreamHistory.library_name == library.name,
            MediaStreamHistory.started_at >= start_date,
            MediaStreamHistory.started_at <= end_date,
            MediaStreamHistory.media_title.isnot(None)
        ).group_by(
            MediaStreamHistory.media_title,
            MediaStreamHistory.media_type
        ).order_by(db.func.count(MediaStreamHistory.id).desc()).limit(50).all()
        
        # Process content metrics
        content_data = []
        for metric in content_metrics:
            content_data.append({
                'title': metric.media_title,
                'type': metric.media_type,
                'total_streams': metric.total_streams,
                'unique_viewers': metric.unique_viewers,
                'total_watch_time': metric.total_watch_time or 0,
                'avg_watch_time': metric.avg_watch_time or 0,
                'last_watched': metric.last_watched,
                'popularity_score': calculate_popularity_score(
                    metric.total_streams,
                    metric.unique_viewers,
                    metric.total_watch_time or 0
                )
            })
        
        return {
            'content_metrics': content_data,
            'total_content_items': len(content_data)
        }
        
    except Exception as e:
        current_app.logger.error(f"Error getting content performance metrics: {e}")
        return {
            'content_metrics': [],
            'total_content_items': 0,
            'error': str(e)
        }


def calculate_popularity_score(total_streams, unique_viewers, total_watch_time):
    """Calculate a popularity score for content"""
    try:
        # Normalize and weight different factors
        stream_score = total_streams * 1.0
        viewer_score = unique_viewers * 2.0  # Unique viewers weighted more
        time_score = (total_watch_time / 3600) * 0.5  # Hours watched
        
        return round(stream_score + viewer_score + time_score, 2)
        
    except Exception:
        return 0.0
