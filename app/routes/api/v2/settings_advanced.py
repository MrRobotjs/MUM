from __future__ import annotations

from uuid import uuid4
from datetime import datetime, timezone
import platform
import sys
import os
from flask import jsonify, request, current_app
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2
from app.models import Setting, SettingValueType, User
from app.models_media_services import MediaServer, ServiceType
from app.extensions import scheduler, db


settings_tag = Tag(name="Settings", description="Application settings")


class AdvancedSettingsData(BaseModel):
    api_timeout_seconds: int


class AdvancedSettingsResponse(BaseModel):
    data: AdvancedSettingsData
    meta: dict


def _serialize_advanced_settings() -> dict:
    api_timeout_seconds = int(Setting.get('API_TIMEOUT_SECONDS', 3) or 3)
    return {
        "api_timeout_seconds": api_timeout_seconds,
    }


@api_v2.get(
    "/settings/advanced",
    tags=[settings_tag],
    summary="Get advanced settings",
    responses={200: AdvancedSettingsResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_advanced_settings(current_user):
    request_id = uuid4().hex
    return jsonify({"data": _serialize_advanced_settings(), "meta": {"request_id": request_id}})


class UpdateAdvancedBody(BaseModel):
    api_timeout_seconds: int = Field(..., ge=3, le=30, description="API request timeout in seconds (3-30)")


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    meta: dict


@api_v2.patch(
    "/settings/advanced",
    tags=[settings_tag],
    summary="Update advanced settings",
    responses={200: AdvancedSettingsResponse, 400: ErrorResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def update_advanced_settings(body: UpdateAdvancedBody, current_user):
    request_id = uuid4().hex
    # Persist settings
    Setting.set('API_TIMEOUT_SECONDS', int(body.api_timeout_seconds), SettingValueType.INTEGER, "API Request Timeout (seconds)")
    # Apply to app config if relevant
    current_app.config['API_TIMEOUT_SECONDS'] = int(body.api_timeout_seconds)

    return jsonify({"data": _serialize_advanced_settings(), "meta": {"request_id": request_id}}), 200


class ScheduledTaskItem(BaseModel):
    id: str
    name: str
    type: str
    state: str
    side: str  # "Server" or "Client"
    next_run_time: str | None
    interval_seconds: int | None
    channels: list[str] | None = None
    misfire_grace_time: int | None = None
    coalesce: bool | None = None


class ScheduledTasksResponse(BaseModel):
    data: list[ScheduledTaskItem]
    meta: dict


@api_v2.get(
    "/settings/scheduled-tasks",
    tags=[settings_tag],
    summary="Get scheduled tasks",
    responses={200: ScheduledTasksResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_scheduled_tasks(current_user):
    request_id = uuid4().hex
    tasks = []

    # Get all scheduled jobs from APScheduler
    jobs = scheduler.get_jobs()

    for job in jobs:
        # Determine task type based on job ID
        task_name = job.id.replace('_', ' ').title()
        task_type = "Monitoring"

        if "session" in job.id.lower() or "monitor" in job.id.lower():
            task_type = "Session Monitoring"
        elif "expir" in job.id.lower():
            task_type = "User Management"
        elif "sync" in job.id.lower():
            task_type = "Synchronization"

        # Get interval from trigger
        interval_seconds = None
        if hasattr(job.trigger, 'interval'):
            interval_seconds = int(job.trigger.interval.total_seconds())

        tasks.append({
            "id": job.id,
            "name": task_name,
            "type": task_type,
            "state": "Active",
            "side": "Server",
            "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None,
            "interval_seconds": interval_seconds,
            "misfire_grace_time": getattr(job, "misfire_grace_time", None),
            "coalesce": getattr(job, "coalesce", None),
        })

    # Add server-side WebSocket connections (Plex WebSocket monitor)
    try:
        from app.services import plex_websocket_monitor
        monitor = plex_websocket_monitor._MONITOR_INSTANCE

        if monitor:
            # Get all Plex servers
            plex_servers = MediaServer.query.filter_by(service_type=ServiceType.PLEX, is_active=True).all()

            for server in plex_servers:
                # Check if there's an active thread for this server
                is_connected = False
                if server.id in monitor.threads:
                    thread = monitor.threads[server.id]
                    is_connected = thread.is_alive() if thread else False

                tasks.append({
                    "id": f"plex_websocket_{server.id}",
                    "name": f"Plex WebSocket - {server.server_nickname}",
                    "type": "WebSocket",
                    "state": "Connected" if is_connected else "Disconnected",
                    "side": "Server",
                    "next_run_time": None,
                    "interval_seconds": None,
                })
    except Exception as e:
        current_app.logger.warning(f"Failed to get Plex WebSocket status: {e}")

    # Add client-side WebSocket connections (Frontend -> Backend)
    try:
        from app.routes.websockets import _ws_clients, _ws_subscriptions

        # List each connection separately with room details
        for sid, client_info in _ws_clients.items():
            user_uuid = client_info.get('uuid')

            # Try to get user display name
            user = User.query.filter_by(uuid=user_uuid).first()
            display_name = "Unknown User"
            if user:
                display_name = (
                    user.localUsername or
                    getattr(user, 'external_username', None) or
                    getattr(user, 'discord_username', None) or
                    user.email or
                    user_uuid[:8]
                )

            subscribed_channels = sorted(_ws_subscriptions.get(sid, set()))
            if subscribed_channels:
                name_suffix = f" ({', '.join(subscribed_channels)})"
            else:
                name_suffix = " (No subscriptions)"

            tasks.append({
                "id": f"client_websocket_{sid}",
                "name": f"Client WebSocket - {display_name}{name_suffix}",
                "type": "WebSocket",
                "state": "Connected",
                "side": "Client",
                "next_run_time": None,
                "interval_seconds": None,
                "channels": subscribed_channels,
            })
    except Exception as e:
        current_app.logger.warning(f"Failed to get client WebSocket status: {e}")

    return jsonify({
        "data": tasks,
        "meta": {
            "request_id": request_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
        }
    }), 200


class SystemConfigResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/settings/system-config",
    tags=[settings_tag],
    summary="Get system configuration",
    responses={200: SystemConfigResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def get_system_config(current_user):
    request_id = uuid4().hex

    # Get database file location
    db_uri = current_app.config.get('SQLALCHEMY_DATABASE_URI', '')
    if db_uri.startswith('sqlite:///'):
        db_file = db_uri.replace('sqlite:///', '')
    else:
        db_file = db_uri

    # Get instance path for various directories
    instance_path = current_app.instance_path

    # Get SQLite version
    try:
        result = db.session.execute(db.text("SELECT sqlite_version()")).scalar()
        sqlite_version = result if result else "Unknown"
    except Exception:
        sqlite_version = "Unknown"

    # Detect if running in Docker
    is_docker = os.path.exists('/.dockerenv') or os.path.exists('/run/.containerenv')
    platform_info = f"[Docker] {platform.system()} {platform.release()}" if is_docker else f"{platform.system()} {platform.release()}"

    # Get timezone
    try:
        import time
        timezone_name = time.tzname[0]
    except Exception:
        timezone_name = "UTC"

    config = {
        "git_branch": os.getenv('GIT_BRANCH', 'Unknown'),
        "git_commit": os.getenv('GIT_COMMIT', 'Unknown'),
        "database_file": db_file,
        "log_directory": os.path.join(instance_path, 'logs'),
        "instance_directory": instance_path,
        "platform": platform_info,
        "system_timezone": timezone_name,
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "sqlite_version": sqlite_version,
    }

    return jsonify({
        "data": config,
        "meta": {
            "request_id": request_id,
            "generated_at": datetime.utcnow().isoformat() + "Z",
        }
    }), 200