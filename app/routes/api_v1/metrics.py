
from uuid import uuid4
from datetime import datetime, timedelta

from flask import jsonify, request
from flask_login import login_required

from app.routes.api_v1 import bp
from app.models import User, UserType, Invite, HistoryLog, EventType
from app.models_media_services import MediaServer, MediaLibrary, MediaStreamHistory
from app.extensions import db


@bp.route('/metrics', methods=['GET'])
@login_required
def get_metrics():
    """
    Get aggregated metrics for dashboard KPIs.
    Returns counts for users, invites, servers, active sessions, and recent activity.
    """
    request_id = str(uuid4())

    # Time ranges for activity metrics
    now = datetime.utcnow()
    day_ago = now - timedelta(days=1)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    # User metrics
    total_users = User.query.filter(User.userType.in_([UserType.LOCAL, UserType.OWNER])).count()
    active_users = User.query.filter(
        User.userType.in_([UserType.LOCAL, UserType.OWNER]),
        User.is_active == True
    ).count()

    service_users = User.query.filter_by(userType=UserType.SERVICE).count()
    active_service_users = User.query.filter_by(
        userType=UserType.SERVICE,
        is_active=True
    ).count()

    # Recent user activity
    users_created_this_month = User.query.filter(
        User.userType.in_([UserType.LOCAL, UserType.OWNER]),
        User.created_at >= month_ago
    ).count()

    # Invite metrics
    total_invites = Invite.query.count()
    active_invites = Invite.query.filter_by(is_active=True).count()
    used_invites = Invite.query.filter(Invite.current_uses > 0).count()

    # Recent invite activity
    invites_used_this_week = HistoryLog.query.filter(
        HistoryLog.event_type.in_([
            EventType.INVITE_USED_SUCCESS_PLEX,
            EventType.INVITE_USED_SUCCESS_DISCORD,
            EventType.INVITE_USER_ACCEPTED_AND_SHARED
        ]),
        HistoryLog.timestamp >= week_ago
    ).count()

    # Server metrics
    total_servers = MediaServer.query.count()
    active_servers = MediaServer.query.filter_by(is_active=True).count()
    total_libraries = MediaLibrary.query.count()

    # Streaming metrics
    total_streams = MediaStreamHistory.query.count()
    streams_today = MediaStreamHistory.query.filter(
        MediaStreamHistory.started_at >= day_ago
    ).count()
    streams_this_week = MediaStreamHistory.query.filter(
        MediaStreamHistory.started_at >= week_ago
    ).count()

    # Active sessions (streams without stopped_at)
    active_sessions = MediaStreamHistory.query.filter(
        MediaStreamHistory.stopped_at.is_(None)
    ).count()

    # History/Activity metrics
    recent_events_today = HistoryLog.query.filter(
        HistoryLog.timestamp >= day_ago
    ).count()

    recent_events_week = HistoryLog.query.filter(
        HistoryLog.timestamp >= week_ago
    ).count()

    # Most active event types (last 7 days)
    from sqlalchemy import func
    top_events = db.session.query(
        HistoryLog.event_type,
        func.count(HistoryLog.id).label('count')
    ).filter(
        HistoryLog.timestamp >= week_ago
    ).group_by(HistoryLog.event_type).order_by(func.count(HistoryLog.id).desc()).limit(5).all()

    top_event_types = [{
        'event_type': event[0].value if event[0] else 'unknown',
        'count': event[1]
    } for event in top_events]

    # Build response
    metrics = {
        'users': {
            'total': total_users,
            'active': active_users,
            'service_accounts': service_users,
            'active_service_accounts': active_service_users,
            'created_this_month': users_created_this_month
        },
        'invites': {
            'total': total_invites,
            'active': active_invites,
            'used': used_invites,
            'used_this_week': invites_used_this_week
        },
        'servers': {
            'total': total_servers,
            'active': active_servers,
            'libraries': total_libraries
        },
        'streaming': {
            'total_streams': total_streams,
            'active_sessions': active_sessions,
            'streams_today': streams_today,
            'streams_this_week': streams_this_week
        },
        'activity': {
            'events_today': recent_events_today,
            'events_this_week': recent_events_week,
            'top_event_types': top_event_types
        },
        'generated_at': now.isoformat() + 'Z'
    }

    return jsonify({
        'data': metrics,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'time_ranges': {
                'day_ago': day_ago.isoformat() + 'Z',
                'week_ago': week_ago.isoformat() + 'Z',
                'month_ago': month_ago.isoformat() + 'Z'
            }
        }
    })


@bp.route('/metrics/users', methods=['GET'])
@login_required
def get_user_metrics():
    """Get detailed user metrics with breakdown by type and status"""
    request_id = str(uuid4())

    # Query user counts by type
    users_by_type = db.session.query(
        User.userType,
        func.count(User.id).label('count')
    ).group_by(User.userType).all()

    type_breakdown = {
        user_type[0].value: user_type[1]
        for user_type in users_by_type
    }

    # Active vs inactive
    active_count = User.query.filter_by(is_active=True).count()
    inactive_count = User.query.filter_by(is_active=False).count()

    # Users with expiration dates
    expired_count = User.query.filter(
        User.access_expires_at < datetime.utcnow()
    ).count()

    upcoming_expirations = User.query.filter(
        User.access_expires_at > datetime.utcnow(),
        User.access_expires_at < datetime.utcnow() + timedelta(days=7)
    ).count()

    return jsonify({
        'data': {
            'by_type': type_breakdown,
            'active': active_count,
            'inactive': inactive_count,
            'expired': expired_count,
            'expiring_soon': upcoming_expirations
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/metrics/streaming', methods=['GET'])
@login_required
def get_streaming_metrics():
    """Get detailed streaming metrics with time-series data"""
    request_id = str(uuid4())

    days = int(request.args.get('days', 7))
    days = min(days, 90)  # Max 90 days

    cutoff = datetime.utcnow() - timedelta(days=days)

    # Total streams in period
    total_streams = MediaStreamHistory.query.filter(
        MediaStreamHistory.started_at >= cutoff
    ).count()

    # Average session duration
    from sqlalchemy import func as sql_func
    avg_duration = db.session.query(
        sql_func.avg(MediaStreamHistory.duration_seconds)
    ).filter(
        MediaStreamHistory.started_at >= cutoff,
        MediaStreamHistory.duration_seconds.isnot(None)
    ).scalar()

    # Streams by server
    streams_by_server = db.session.query(
        MediaServer.server_nickname,
        sql_func.count(MediaStreamHistory.id).label('count')
    ).join(MediaStreamHistory).filter(
        MediaStreamHistory.started_at >= cutoff
    ).group_by(MediaServer.server_nickname).all()

    server_breakdown = [{
        'server': server[0],
        'count': server[1]
    } for server in streams_by_server]

    return jsonify({
        'data': {
            'total_streams': total_streams,
            'avg_duration_seconds': round(avg_duration, 2) if avg_duration else 0,
            'by_server': server_breakdown,
            'days': days
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })
