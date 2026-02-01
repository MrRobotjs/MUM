from __future__ import annotations

from uuid import uuid4
from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import Notification, NotificationType
from app.extensions import db


notifications_tag = Tag(name="Notifications", description="User notifications")


class NotificationData(BaseModel):
    id: int
    timestamp: str
    notification_type: str
    title: str
    message: str
    read: bool
    details: dict | None = None


class MetaModel(BaseModel):
    request_id: str
    total: int | None = None
    unread_count: int | None = None


class SuccessData(BaseModel):
    success: bool
    deleted_id: int | None = None


class NotificationsListResponse(BaseModel):
    data: list[NotificationData]
    meta: MetaModel


class NotificationResponse(BaseModel):
    data: NotificationData
    meta: MetaModel


class SuccessResponse(BaseModel):
    data: SuccessData
    meta: MetaModel


class NotificationPath(BaseModel):
    notification_id: int


def _serialize_notification(notification: Notification) -> dict:
    return {
        "id": notification.id,
        "timestamp": notification.timestamp.isoformat() if notification.timestamp else None,
        "notification_type": notification.notification_type.value if notification.notification_type else None,
        "title": notification.title,
        "message": notification.message,
        "read": notification.read,
        "details": notification.details or {},
    }


@api_v2.get(
    "/notifications",
    tags=[notifications_tag],
    summary="Get all notifications for current admin",
    responses={200: NotificationsListResponse},
)
@jwt_required_with_user()
def get_notifications(current_user):
    """Get all notifications for the current admin user"""
    request_id = uuid4().hex

    # Get query parameters
    unread_only = request.args.get('unread_only', 'false').lower() == 'true'
    notification_type = request.args.get('type', None)
    limit = min(int(request.args.get('limit', 50)), 100)

    # Build query
    query = Notification.query.order_by(Notification.timestamp.desc())

    if unread_only:
        query = query.filter(Notification.read == False)

    if notification_type:
        try:
            type_enum = NotificationType[notification_type]
            query = query.filter(Notification.notification_type == type_enum)
        except KeyError:
            pass  # Invalid type, ignore filter

    notifications = query.limit(limit).all()

    return jsonify({
        "data": [_serialize_notification(n) for n in notifications],
        "meta": {
            "request_id": request_id,
            "total": len(notifications),
            "unread_count": Notification.query.filter(Notification.read == False).count(),
        }
    })


@api_v2.patch(
    "/notifications/<int:notification_id>/read",
    tags=[notifications_tag],
    summary="Mark notification as read",
    responses={200: NotificationResponse},
)
@jwt_required_with_user()
def mark_notification_read(path: NotificationPath, current_user):
    """Mark a specific notification as read"""
    request_id = uuid4().hex

    notification = Notification.query.get_or_404(path.notification_id)
    notification.read = True
    db.session.commit()

    return jsonify({
        "data": _serialize_notification(notification),
        "meta": {"request_id": request_id}
    })


@api_v2.post(
    "/notifications/mark-all-read",
    tags=[notifications_tag],
    summary="Mark all notifications as read",
    responses={200: SuccessResponse},
)
@jwt_required_with_user()
def mark_all_notifications_read(current_user):
    """Mark all notifications as read for the current admin"""
    request_id = uuid4().hex

    Notification.query.filter(Notification.read == False).update({"read": True})
    db.session.commit()

    return jsonify({
        "data": {"success": True},
        "meta": {"request_id": request_id}
    })


@api_v2.delete(
    "/notifications/<int:notification_id>",
    tags=[notifications_tag],
    summary="Delete a notification",
    responses={200: SuccessResponse},
)
@jwt_required_with_user()
def delete_notification(path: NotificationPath, current_user):
    """Delete a specific notification"""
    request_id = uuid4().hex

    notification = Notification.query.get_or_404(path.notification_id)
    db.session.delete(notification)
    db.session.commit()

    return jsonify({
        "data": {"success": True, "deleted_id": path.notification_id},
        "meta": {"request_id": request_id}
    })
