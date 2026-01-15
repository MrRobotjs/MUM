"""Helpers to normalize real-time events into a unified shape."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Iterable, List, Optional

from flask import current_app

from app.models import User
from app.models_media_services import MediaServer


class MessageType(str, Enum):
    """Known websocket message types used by the frontend."""

    SESSION_START = "SessionStart"
    SESSION_UPDATE = "SessionUpdate"
    SESSION_STOP = "SessionStop"
    MEDIA_ADDED = "MediaAdded"
    MEDIA_UPDATED = "MediaUpdated"
    MEDIA_REMOVED = "MediaRemoved"
    LIBRARY_SCAN_STARTED = "LibraryScanStarted"
    LIBRARY_SCAN_COMPLETED = "LibraryScanCompleted"
    TASK_STARTED = "TaskStarted"
    TASK_PROGRESS = "TaskProgress"
    TASK_COMPLETED = "TaskCompleted"
    SERVER_STATUS = "ServerStatus"
    ERROR = "Error"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_seconds(value: Any) -> Optional[float]:
    """Best-effort conversion of duration strings or numbers to seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        # Handle HH:MM:SS and MM:SS
        parts = value.strip().split(":")
        try:
            parts = [float(p) for p in parts]
        except ValueError:
            try:
                return float(value)
            except ValueError:
                return None
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return hours * 3600 + minutes * 60 + seconds
        if len(parts) == 2:
            minutes, seconds = parts
            return minutes * 60 + seconds
        if len(parts) == 1:
            return parts[0]
    return None


def _resolve_user_uuid(session: Dict[str, Any], cache: Dict[Any, Optional[str]]) -> Optional[str]:
    """Extract or resolve a user UUID from a formatted session dict."""
    for key in ("user_uuid", "linked_user_uuid", "mum_user_uuid"):
        if session.get(key):
            return str(session[key])

    # Some formatters only provide a local id; cache lookups to avoid N+1 hits.
    for key in ("mum_user_id", "user_id"):
        user_id = session.get(key)
        if user_id is None:
            continue
        if user_id in cache:
            return cache[user_id]
        user = User.query.get(user_id)
        cache[user_id] = getattr(user, "uuid", None) if user else None
        if cache[user_id]:
            return cache[user_id]

    return None


def normalize_session(
    session: Dict[str, Any],
    *,
    source: str,
    server: Optional[MediaServer] = None,
    user_cache: Optional[Dict[Any, Optional[str]]] = None,
) -> Dict[str, Any]:
    """Normalize a service-specific formatted session into the unified schema."""
    cache = user_cache if user_cache is not None else {}

    session_id = str(
        session.get("session_key")
        or session.get("session_id")
        or session.get("Id")
        or session.get("id")
        or session.get("uuid")
        or ""
    )
    user_uuid = _resolve_user_uuid(session, cache)

    user_name = session.get("user") or session.get("UserName") or session.get("username") or "Unknown User"
    user_avatar = session.get("user_avatar_url") or session.get("avatar")

    client_name = (
        session.get("player_title")
        or session.get("client")
        or session.get("device_name")
        or session.get("DeviceName")
        or session.get("player_platform")
    )
    client_platform = session.get("player_platform") or session.get("product") or session.get("platform")
    client_product = session.get("product")

    media_title = (
        session.get("media_title")
        or session.get("title")
        or session.get("item_title")
        or session.get("NowPlayingItem", {}).get("Name")
        or "Unknown Title"
    )
    media_type = (session.get("media_type") or session.get("type") or "unknown").lower()
    library_name = session.get("library_name")
    year = session.get("year")
    edition = session.get("edition")
    thumb_url = session.get("thumb_url")
    grandparent_title = session.get("grandparent_title")
    parent_title = session.get("parent_title")

    state = (session.get("state") or session.get("Status") or session.get("playback_state") or "unknown").lower()

    progress = session.get("progress")
    progress_val = float(progress) if isinstance(progress, (int, float)) else None
    current_time_seconds = _parse_seconds(session.get("current_time") or session.get("view_offset") or None)
    duration_seconds = _parse_seconds(session.get("duration") or session.get("media_duration") or None)

    quality = {
        "detail": session.get("quality_detail"),
        "stream": session.get("stream_detail"),
        "container": session.get("container_detail"),
        "video": session.get("video_detail"),
        "audio": session.get("audio_detail"),
        "subtitle": session.get("subtitle_detail"),
        "transcode_reason": session.get("transcode_reason"),
        "bitrate": session.get("bitrate_calc"),
        "is_transcode": session.get("is_transcode_calc"),
    }

    network_location = session.get("location_type_calc")
    if not network_location and isinstance(session.get("location_detail"), str):
        # location_detail often looks like "LAN: 10.0.0.1"
        prefix = session["location_detail"].split(":")[0].strip()
        if prefix:
            network_location = prefix

    network = {
        "location": network_location,
        "ip": session.get("location_ip"),
        "is_public_ip": session.get("is_public_ip"),
        "bandwidth": session.get("bandwidth_detail"),
    }

    server_name = session.get("server_name") or (server.server_nickname if server else None)
    server_id = session.get("server_id") or (server.id if server else None)

    normalized = {
        "session_id": session_id,
        "user": {
            "name": user_name,
            "uuid": user_uuid,
            "avatar": user_avatar,
        },
        "client": {
            "name": client_name,
            "platform": client_platform,
            "product": client_product,
        },
        "item": {
            "title": media_title,
            "type": media_type,
            "library": library_name,
            "year": year,
            "edition": edition,
            "thumb": thumb_url,
            "grandparent_title": grandparent_title,
            "parent_title": parent_title,
        },
        "server": {
            "id": server_id,
            "name": server_name,
            "service": source,
        },
        "state": state,
        "playback": {
            "progress": progress_val if progress_val is not None else 0.0,
            "position_seconds": current_time_seconds,
            "duration_seconds": duration_seconds,
            "position_text": session.get("current_time"),
            "duration_text": session.get("duration"),
        },
        "quality": quality,
        "network": network,
        "raw": session.get("raw_data_json"),
        # Retain the original formatted session for developers when debugging new services.
        "original": deepcopy(session),
    }

    return normalized


def build_session_update_event(
    *,
    source: str,
    server: Optional[MediaServer],
    sessions: Iterable[Dict[str, Any]],
    live_services: Optional[Iterable[str]] = None,
    summary: Optional[Dict[str, Any]] = None,
    timestamp: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a SessionUpdate envelope with normalized sessions."""
    ts = timestamp or _now_iso()
    user_cache: Dict[Any, Optional[str]] = {}

    normalized_sessions: List[Dict[str, Any]] = []
    for session in sessions:
        try:
            normalized_sessions.append(
                normalize_session(
                    session,
                    source=source,
                    server=server,
                    user_cache=user_cache,
                )
            )
        except Exception as err:
            current_app.logger.warning("EventNormalizer: failed to normalize session for %s: %s", source, err)

    payload: Dict[str, Any] = {
        "active_count": len(normalized_sessions),
        "sessions": normalized_sessions,
    }
    if live_services:
        payload["live_services"] = sorted({svc.lower() for svc in live_services})
    if summary:
        payload["summary"] = summary

    return {
        "type": MessageType.SESSION_UPDATE.value,
        "source": source,
        "server_id": getattr(server, "id", None),
        "payload": payload,
        "timestamp": ts,
    }
