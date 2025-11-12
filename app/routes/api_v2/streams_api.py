from __future__ import annotations

from uuid import uuid4
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models_media_services import MediaStreamHistory, MediaServer, ServiceType
from app.models import User, EventType
# JWT permission checking handled by jwt_permission_required, log_event
from app.services.media_service_factory import MediaServiceFactory
from sqlalchemy import desc, func


streams_tag = Tag(name="Streaming", description="Active and historical streaming data")


class StreamsQuery(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=100)
    user_uuid: Optional[str] = None
    service_type: Optional[str] = None
    status: Optional[str] = Field(None, description="active|completed")
    start: Optional[str] = None
    end: Optional[str] = None


class StreamItem(BaseModel):
    id: int
    user_uuid: Optional[str] = None
    media_title: Optional[str] = None
    media_type: Optional[str] = None
    server_id: Optional[int] = None
    server_name: Optional[str] = None
    started_at: Optional[str] = None
    stopped_at: Optional[str] = None
    duration_seconds: Optional[int] = None
    platform: Optional[str] = None
    grandparent_title: Optional[str] = None
    parent_title: Optional[str] = None
    library_name: Optional[str] = None


class StreamsListResponse(BaseModel):
    data: list[StreamItem]
    meta: dict


def _serialize_stream(stream: MediaStreamHistory) -> dict:
    return {
        "id": stream.id,
        "user_uuid": stream.user_uuid,
        "media_title": stream.media_title,
        "media_type": stream.media_type,
        "server_id": stream.server_id,
        "server_name": stream.server.server_nickname if stream.server else None,
        "started_at": stream.started_at.isoformat() if stream.started_at else None,
        "stopped_at": stream.stopped_at.isoformat() if stream.stopped_at else None,
        "duration_seconds": stream.duration_seconds,
        "platform": stream.platform,
        "grandparent_title": stream.grandparent_title,
        "parent_title": stream.parent_title,
        "library_name": stream.library_name,
    }


def _apply_filters(query, user_uuid=None, service_type=None, status=None, start_date=None, end_date=None):
    if user_uuid:
        query = query.filter(MediaStreamHistory.user_uuid == user_uuid)
    if service_type:
        try:
            service_enum = ServiceType(service_type)
            query = query.filter(MediaStreamHistory.server.has(service_type=service_enum))
        except ValueError:
            query = query.filter(False)
    if status == "active":
        query = query.filter(MediaStreamHistory.stopped_at.is_(None))
    elif status == "completed":
        query = query.filter(MediaStreamHistory.stopped_at.isnot(None))
    if start_date:
        query = query.filter(MediaStreamHistory.started_at >= start_date)
    if end_date:
        query = query.filter(MediaStreamHistory.started_at <= end_date)
    return query


@api_v2.get(
    "/streams",
    tags=[streams_tag],
    summary="List streams",
    responses={200: StreamsListResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def list_streams(query: StreamsQuery, current_user):
    request_id = uuid4().hex

    start_dt = None
    end_dt = None
    if query.start:
        try:
            start_dt = datetime.fromisoformat(query.start)
        except ValueError:
            pass
    if query.end:
        try:
            end_dt = datetime.fromisoformat(query.end)
            if end_dt.time().isoformat() == "00:00:00":
                end_dt = end_dt + timedelta(days=1)
        except ValueError:
            pass

    q = MediaStreamHistory.query.order_by(desc(MediaStreamHistory.started_at))
    q = _apply_filters(q, query.user_uuid, query.service_type, query.status, start_dt, end_dt)

    pagination = q.paginate(page=query.page, per_page=query.page_size, error_out=False)

    return jsonify(
        {
            "data": [_serialize_stream(s) for s in pagination.items],
            "meta": {
                "request_id": request_id,
                "pagination": {
                    "page": pagination.page,
                    "page_size": pagination.per_page,
                    "total_items": pagination.total,
                    "total_pages": pagination.pages or 1,
                },
                "filters": {
                    "user_uuid": query.user_uuid,
                    "service_type": query.service_type,
                    "status": query.status,
                    "start": query.start,
                    "end": query.end,
                },
            },
        }
    )


class StreamPath(BaseModel):
    stream_id: int


class StreamResponse(BaseModel):
    data: StreamItem
    meta: dict


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.get(
    "/streams/<stream_id>",
    tags=[streams_tag],
    summary="Get stream details",
    responses={200: StreamResponse, 404: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_stream(path: StreamPath, current_user):
    request_id = uuid4().hex
    stream = MediaStreamHistory.query.get(path.stream_id)
    if not stream:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Stream not found"}, "meta": {"request_id": request_id}}), 404
    return jsonify({"data": _serialize_stream(stream), "meta": {"request_id": request_id, "deprecated": False}})


class StreamsSummaryQuery(BaseModel):
    start: Optional[str] = None
    end: Optional[str] = None
    user_uuid: Optional[str] = None
    service_type: Optional[str] = None


class StreamsSummaryResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/streams/summary",
    tags=[streams_tag],
    summary="Streams summary",
    responses={200: StreamsSummaryResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def streams_summary(query: StreamsSummaryQuery, current_user):
    request_id = uuid4().hex
    start_date_str = query.start
    end_date_str = query.end
    user_uuid = query.user_uuid
    service_type = query.service_type

    start_dt = None
    end_dt = None
    if start_date_str:
        try:
            start_dt = datetime.fromisoformat(start_date_str)
        except ValueError:
            pass
    if end_date_str:
        try:
            end_dt = datetime.fromisoformat(end_date_str)
            if end_dt.time().isoformat() == "00:00:00":
                end_dt = end_dt + timedelta(days=1)
        except ValueError:
            pass

    # Build filtered base query similar to v1 semantics
    base_q = _apply_filters(MediaStreamHistory.query, user_uuid, service_type, None, start_dt, end_dt)

    total_streams = base_q.count()
    active_streams = _apply_filters(MediaStreamHistory.query, user_uuid, service_type, "active", start_dt, end_dt).count()
    completed_streams = _apply_filters(MediaStreamHistory.query, user_uuid, service_type, "completed", start_dt, end_dt).count()

    total_duration = base_q.with_entities(func.coalesce(func.sum(MediaStreamHistory.duration_seconds), 0)).scalar()
    average_duration = base_q.with_entities(func.coalesce(func.avg(MediaStreamHistory.duration_seconds), 0)).scalar()

    def _to_int_safe(value) -> int:
        if value is None:
            return 0
        try:
            if isinstance(value, Decimal):
                return int(value)
            return int(value)
        except Exception:
            try:
                return int(float(value))
            except Exception:
                return 0

    from sqlalchemy import cast, Date
    daily_counts = (
        _apply_filters(MediaStreamHistory.query, user_uuid, service_type, None, start_dt, end_dt)
        .with_entities(func.date(MediaStreamHistory.started_at).label("day"), func.count(MediaStreamHistory.id))
        .group_by("day")
        .order_by("day")
        .all()
    )
    per_service = (
        _apply_filters(MediaStreamHistory.query.join(MediaServer), user_uuid, service_type, None, start_dt, end_dt)
        .with_entities(MediaServer.service_type, func.count(MediaStreamHistory.id))
        .group_by(MediaServer.service_type)
        .order_by(MediaServer.service_type)
        .all()
    )

    return jsonify(
        {
            "data": {
                "counts": {"total": total_streams, "active": active_streams, "completed": completed_streams},
                "duration": {"total_seconds": _to_int_safe(total_duration), "average_seconds": _to_int_safe(average_duration)},
                "daily": [
                    {"date": (getattr(day, "isoformat", lambda: str(day))()), "count": _to_int_safe(count)}
                    for day, count in daily_counts
                ],
                "by_service": [
                    {"service_type": (getattr(svc, "value", None) or str(svc)), "count": _to_int_safe(count)}
                    for svc, count in per_service
                ],
            },
            "meta": {
                "request_id": request_id,
                "filters": {"start": start_date_str, "end": end_date_str, "service_type": service_type, "user_uuid": user_uuid},
                "generated_at": datetime.utcnow().isoformat() + "Z",
            },
        }
    )


class TerminateBody(BaseModel):
    message: Optional[str] = None


class TerminateResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/streams/<stream_id>/terminate",
    tags=[streams_tag],
    summary="Terminate a stream on the media server",
    responses={200: TerminateResponse, 400: ErrorResponse, 500: ErrorResponse, 502: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def terminate_stream(path: StreamPath, body: TerminateBody, current_user):
    request_id = uuid4().hex
    message = body.message
    stream = MediaStreamHistory.query.get(path.stream_id)
    if not stream:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "Stream not found"}, "meta": {"request_id": request_id}}), 404

    if stream.stopped_at:
        return jsonify({"error": {"code": "STREAM_NOT_ACTIVE", "message": "The stream has already ended."}, "meta": {"request_id": request_id}}), 400

    session_key = stream.session_key or stream.external_session_id
    if not session_key:
        return jsonify({"error": {"code": "SESSION_KEY_MISSING", "message": "No session key is stored for this stream; it cannot be terminated."}, "meta": {"request_id": request_id}}), 400

    server = stream.server
    service = MediaServiceFactory.create_service_from_db(server)
    if not service or not hasattr(service, "terminate_session"):
        return jsonify({"error": {"code": "SERVICE_NOT_SUPPORTED", "message": f"{server.service_type.value.capitalize()} does not support remote termination."}, "meta": {"request_id": request_id}}), 400

    try:
        success = service.terminate_session(session_key, message)
    except Exception as exc:
        return jsonify({"error": {"code": "TERMINATION_FAILED", "message": f"Failed to terminate session: {exc}"}, "meta": {"request_id": request_id}}), 500

    if not success:
        return jsonify({"error": {"code": "TERMINATION_FAILED", "message": "The media server did not accept the termination command."}, "meta": {"request_id": request_id}}), 502

    log_event(
        EventType.SETTING_CHANGE,
        f"Terminated {server.service_type.value} session {session_key} on {server.server_nickname}",
        admin_id=getattr(current_user, "id", None),
        server_id=server.id,
    )

    return jsonify({"data": {"success": True, "message": f"Termination command sent for session {session_key}."}, "meta": {"request_id": request_id}})
