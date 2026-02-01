from __future__ import annotations

from uuid import uuid4
from datetime import datetime, timedelta
from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import User, UserType, Invite
from app.models_media_services import MediaServer, MediaLibrary, MediaStreamHistory
from app.extensions import db


metrics_tag = Tag(name="Metrics", description="Dashboard metrics and KPIs")


class MetricsResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/metrics",
    tags=[metrics_tag],
    summary="Get aggregated metrics",
    responses={200: MetricsResponse},
)
@jwt_required_with_user()
def get_metrics(current_user):
    request_id = str(uuid4())

    now = datetime.utcnow()
    day_ago = now - timedelta(days=1)
    week_ago = now - timedelta(days=7)
    month_ago = now - timedelta(days=30)

    total_users = User.query.filter(User.userType.in_([UserType.LOCAL, UserType.OWNER])).count()
    active_users = User.query.filter(User.userType.in_([UserType.LOCAL, UserType.OWNER]), User.is_active == True).count()
    service_users = User.query.filter_by(userType=UserType.SERVICE).count()
    active_service_users = User.query.filter_by(userType=UserType.SERVICE, is_active=True).count()
    users_created_this_month = User.query.filter(User.userType.in_([UserType.LOCAL, UserType.OWNER]), User.created_at >= month_ago).count()

    total_invites = Invite.query.count()
    active_invites = Invite.query.filter_by(is_active=True).count()
    used_invites = Invite.query.filter(Invite.current_uses > 0).count()
    invites_used_this_week = 0

    total_servers = MediaServer.query.count()
    active_servers = MediaServer.query.filter_by(is_active=True).count()
    total_libraries = MediaLibrary.query.count()

    total_streams = MediaStreamHistory.query.count()
    streams_today = MediaStreamHistory.query.filter(MediaStreamHistory.started_at >= day_ago).count()
    streams_this_week = MediaStreamHistory.query.filter(MediaStreamHistory.started_at >= week_ago).count()
    active_sessions = MediaStreamHistory.query.filter(MediaStreamHistory.stopped_at.is_(None)).count()

    recent_events_today = 0
    recent_events_week = 0
    top_event_types = []

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

    return jsonify({'data': metrics, 'meta': {'request_id': request_id, 'deprecated': False, 'generated_at': datetime.utcnow().isoformat() + 'Z', 'time_ranges': {'day_ago': day_ago.isoformat() + 'Z', 'week_ago': week_ago.isoformat() + 'Z', 'month_ago': month_ago.isoformat() + 'Z'}}})


class UserMetricsResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/metrics/users",
    tags=[metrics_tag],
    summary="Get detailed user metrics",
    responses={200: UserMetricsResponse},
)
@jwt_required_with_user()
def get_user_metrics(current_user):
    request_id = str(uuid4())
    from sqlalchemy import func as sql_func
    users_by_type = db.session.query(User.userType, sql_func.count(User.id).label('count')).group_by(User.userType).all()
    type_breakdown = {ut[0].value: ut[1] for ut in users_by_type}
    active_count = User.query.filter_by(is_active=True).count()
    inactive_count = User.query.filter_by(is_active=False).count()
    expired_count = User.query.filter(User.access_expires_at < datetime.utcnow()).count()
    upcoming_expirations = User.query.filter(User.access_expires_at > datetime.utcnow(), User.access_expires_at < datetime.utcnow() + timedelta(days=7)).count()
    return jsonify({'data': {'by_type': type_breakdown, 'active': active_count, 'inactive': inactive_count, 'expired': expired_count, 'expiring_soon': upcoming_expirations}, 'meta': {'request_id': request_id, 'deprecated': False, 'generated_at': datetime.utcnow().isoformat() + 'Z'}})


class StreamingMetricsQuery(BaseModel):
    days: int = Field(7, ge=1, le=90)


class StreamingMetricsResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/metrics/streaming",
    tags=[metrics_tag],
    summary="Get detailed streaming metrics",
    responses={200: StreamingMetricsResponse},
)
@jwt_required_with_user()
def get_streaming_metrics(query: StreamingMetricsQuery, current_user):
    request_id = str(uuid4())
    cutoff = datetime.utcnow() - timedelta(days=query.days)
    total_streams = MediaStreamHistory.query.filter(MediaStreamHistory.started_at >= cutoff).count()
    from sqlalchemy import func as sql_func
    avg_duration = db.session.query(sql_func.avg(MediaStreamHistory.duration_seconds)).filter(MediaStreamHistory.started_at >= cutoff, MediaStreamHistory.duration_seconds.isnot(None)).scalar()
    streams_by_server = db.session.query(MediaServer.server_nickname, sql_func.count(MediaStreamHistory.id).label('count')).join(MediaStreamHistory).filter(MediaStreamHistory.started_at >= cutoff).group_by(MediaServer.server_nickname).all()
    server_breakdown = [{'server': s[0], 'count': s[1]} for s in streams_by_server]
    return jsonify({'data': {'total_streams': total_streams, 'avg_duration_seconds': round(avg_duration, 2) if avg_duration else 0, 'by_server': server_breakdown, 'days': query.days}, 'meta': {'request_id': request_id, 'deprecated': False, 'generated_at': datetime.utcnow().isoformat() + 'Z'}})
