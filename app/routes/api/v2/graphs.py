from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4

from flask import jsonify
from flask_openapi3 import Tag
from pydantic import BaseModel, Field
from sqlalchemy import func

from app.extensions import db
from app.models_media_services import MediaServer, MediaStreamHistory
from app.routes.api.v2 import api_v2
from app.services.media_service_manager import MediaServiceManager
from app.utils.jwt_decorators import jwt_permission_required, jwt_required_with_user


graphs_tag = Tag(name="Graphs", description="Analytics graphs datasets")


class GraphAnalyticsQuery(BaseModel):
    days: int = Field(30, ge=1, le=365)
    server_id: str | None = Field(None, description="Server id or 'all'")


class GraphAnalyticsResponse(BaseModel):
    data: dict
    meta: dict


def _normalize_server_filter(server_id_raw: str | None) -> int | None:
    if server_id_raw is None:
        return None
    value = str(server_id_raw).strip().lower()
    if not value or value == "all":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


def _classify_device(platform: str | None, product: str | None, player: str | None) -> str:
    parts = [platform or "", product or "", player or ""]
    raw = " ".join(p.strip() for p in parts if p).strip()
    text = raw.lower()

    if not text:
        return "Unknown"

    tv_markers = [
        "android tv",
        "apple tv",
        "chromecast",
        "roku",
        "fire tv",
        "smart tv",
        "samsung",
        "lg ",
        "webos",
        "tizen",
        "shield",
        "tv",
    ]
    mobile_markers = ["iphone", "ipad", "ios", "android", "mobile", "phone", "tablet"]
    web_markers = ["web", "browser", "chrome", "firefox", "safari", "edge"]
    console_markers = ["xbox", "playstation", "ps4", "ps5", "nintendo", "switch"]
    desktop_markers = ["windows", "mac", "macos", "linux", "desktop", "htpc"]

    if any(marker in text for marker in tv_markers):
        return "TV / Streaming Device"
    if any(marker in text for marker in mobile_markers):
        return "Mobile"
    if any(marker in text for marker in web_markers):
        return "Web Browser"
    if any(marker in text for marker in console_markers):
        return "Console"
    if any(marker in text for marker in desktop_markers):
        return "Desktop App"

    # Fall back to a readable source name.
    return raw if len(raw) <= 32 else raw[:29] + "..."


def _normalize_playback_mode(value: str | None) -> str | None:
    if not value:
        return None
    normalized = str(value).strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in {"transcode", "transcoding"}:
        return "transcode"
    if normalized in {"direct_stream", "directstream"}:
        return "direct_stream"
    if normalized in {"direct_play", "directplay", "direct"}:
        return "direct_play"
    return None


def _playback_mode_from_service_data(service_data: dict | None) -> str | None:
    if not isinstance(service_data, dict) or not service_data:
        return None

    mode = _normalize_playback_mode(service_data.get("playback_mode"))
    if mode:
        return mode

    stream_detail = str(service_data.get("stream_detail") or "").lower()
    if "transcode" in stream_detail:
        return "transcode"
    if "direct stream" in stream_detail:
        return "direct_stream"
    if "direct play" in stream_detail:
        return "direct_play"

    if "is_transcode_calc" in service_data:
        return "transcode" if bool(service_data.get("is_transcode_calc")) else None

    return None


def _playback_health_from_history(base_q) -> tuple[list[dict], dict]:
    direct_play = 0
    direct_stream = 0
    transcode = 0
    total_rows = 0
    rows_with_mode = 0

    rows = base_q.with_entities(MediaStreamHistory.service_data).all()
    for row in rows:
        total_rows += 1
        mode = _playback_mode_from_service_data(getattr(row, "service_data", None))
        if not mode:
            continue
        rows_with_mode += 1
        if mode == "transcode":
            transcode += 1
        elif mode == "direct_stream":
            direct_stream += 1
        elif mode == "direct_play":
            direct_play += 1

    return (
        [
            {"name": "Direct Play", "value": direct_play, "color": "#10b981"},
            {"name": "Direct Stream", "value": direct_stream, "color": "#3b82f6"},
            {"name": "Transcode", "value": transcode, "color": "#ef4444"},
        ],
        {
            "total_rows_considered": total_rows,
            "rows_with_playback_mode": rows_with_mode,
        },
    )


@api_v2.get(
    "/graphs/analytics",
    tags=[graphs_tag],
    summary="Analytics graph datasets (hourly activity, device preferences, playback health)",
    responses={200: GraphAnalyticsResponse},
)
@jwt_required_with_user()
@jwt_permission_required("administrator")
def get_graph_analytics(query: GraphAnalyticsQuery, current_user):
    request_id = uuid4().hex
    generated_at = datetime.utcnow()
    cutoff = generated_at - timedelta(days=query.days)

    effective_servers = MediaServiceManager.get_effective_servers(active_only=True)
    effective_server_ids = {s.id for s in effective_servers}
    selected_server_id = _normalize_server_filter(query.server_id)

    if selected_server_id is None:
        scoped_server_ids = effective_server_ids
    elif selected_server_id == -1:
        scoped_server_ids = set()
    else:
        scoped_server_ids = {selected_server_id} if selected_server_id in effective_server_ids else set()

    hourly_activity = [{"hour": hour, "plays": 0} for hour in range(24)]
    device_preferences: list[dict] = []

    playback_health_meta = {"total_rows_considered": 0, "rows_with_playback_mode": 0}

    if scoped_server_ids:
        base_q = MediaStreamHistory.query.filter(
            MediaStreamHistory.started_at >= cutoff,
            MediaStreamHistory.server_id.in_(scoped_server_ids),
        )

        dialect_name = (db.engine.dialect.name or "").lower()
        if dialect_name == "sqlite":
            hour_rows = (
                base_q.with_entities(
                    func.strftime("%H", MediaStreamHistory.started_at).label("hour"),
                    func.count(MediaStreamHistory.id).label("count"),
                )
                .group_by("hour")
                .all()
            )
            for row in hour_rows:
                try:
                    hour_index = int(getattr(row, "hour", "0") or 0)
                except (TypeError, ValueError):
                    continue
                if 0 <= hour_index <= 23:
                    hourly_activity[hour_index]["plays"] = int(getattr(row, "count", 0) or 0)
        else:
            hour_rows = (
                base_q.with_entities(
                    func.extract("hour", MediaStreamHistory.started_at).label("hour"),
                    func.count(MediaStreamHistory.id).label("count"),
                )
                .group_by("hour")
                .all()
            )
            for row in hour_rows:
                try:
                    hour_index = int(getattr(row, "hour", 0) or 0)
                except (TypeError, ValueError):
                    continue
                if 0 <= hour_index <= 23:
                    hourly_activity[hour_index]["plays"] = int(getattr(row, "count", 0) or 0)

        device_rows = (
            base_q.with_entities(
                MediaStreamHistory.platform,
                MediaStreamHistory.product,
                MediaStreamHistory.player,
                func.count(MediaStreamHistory.id).label("count"),
            )
            .group_by(MediaStreamHistory.platform, MediaStreamHistory.product, MediaStreamHistory.player)
            .all()
        )

        device_counts: dict[str, int] = {}
        total_device_plays = 0
        for row in device_rows:
            count = int(getattr(row, "count", 0) or 0)
            if count <= 0:
                continue
            bucket = _classify_device(
                getattr(row, "platform", None),
                getattr(row, "product", None),
                getattr(row, "player", None),
            )
            device_counts[bucket] = device_counts.get(bucket, 0) + count
            total_device_plays += count

        sorted_devices = sorted(device_counts.items(), key=lambda item: item[1], reverse=True)
        top_devices = sorted_devices[:4]
        other_total = sum(count for _, count in sorted_devices[4:])

        if total_device_plays > 0:
            device_preferences = [
                {"name": name, "value": round((count / total_device_plays) * 100)}
                for name, count in top_devices
            ]
            if other_total > 0:
                device_preferences.append(
                    {"name": "Others", "value": round((other_total / total_device_plays) * 100)}
                )

        playback_health, playback_health_meta = _playback_health_from_history(base_q)
    else:
        playback_health = [
            {"name": "Direct Play", "value": 0, "color": "#10b981"},
            {"name": "Direct Stream", "value": 0, "color": "#3b82f6"},
            {"name": "Transcode", "value": 0, "color": "#ef4444"},
        ]

    payload = {
        "hourly_activity": hourly_activity,
        "device_preferences": device_preferences,
        "playback_health": playback_health,
    }
    meta = {
        "request_id": request_id,
        "generated_at": generated_at.isoformat() + "Z",
        "filters": {
            "days": query.days,
            "server_id": query.server_id or "all",
            "effective_server_count": len(effective_server_ids),
            "scoped_server_count": len(scoped_server_ids),
        },
        "sources": {
            "hourly_activity": "media_stream_history",
            "device_preferences": "media_stream_history",
            "playback_health": "media_stream_history.service_data",
        },
        "notes": [
            "Playback Health is calculated from historical stream records (media_stream_history.service_data.playback_mode). Older rows recorded before playback mode persistence may not appear in this chart.",
        ],
        "playback_health": playback_health_meta,
    }

    return jsonify({"data": payload, "meta": meta}), 200
