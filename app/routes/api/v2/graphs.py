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
SEPARATED_UNSUPPORTED_SERVICE_TYPES = {"kavita", "komga", "romm"}


class GraphAnalyticsQuery(BaseModel):
    days: int = Field(30, ge=1, le=365)
    server_id: str | None = Field(None, description="Server id or 'all'")
    server_mode: str | None = Field(None, description="'combined' (default) or 'separated'")


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


def _normalize_server_mode(server_mode_raw: str | None) -> str:
    value = str(server_mode_raw or "").strip().lower()
    return "separated" if value == "separated" else "combined"


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


def _zero_playback_health() -> list[dict]:
    return [
        {"name": "Direct Play", "value": 0, "color": "#10b981"},
        {"name": "Direct Stream", "value": 0, "color": "#3b82f6"},
        {"name": "Transcode", "value": 0, "color": "#ef4444"},
    ]


def _supported_separated_servers(effective_servers: list[MediaServer], scoped_server_ids: set[int]) -> list[MediaServer]:
    return [
        server
        for server in effective_servers
        if server.id in scoped_server_ids
        and str(server.service_type.value).lower() not in SEPARATED_UNSUPPORTED_SERVICE_TYPES
    ]


def _build_hourly_activity_separated(base_q, server_meta: list[dict]) -> list[dict]:
    hourly = [
        {"hour": hour, "label": f"{hour:02d}:00", "values": {server["key"]: 0 for server in server_meta}}
        for hour in range(24)
    ]
    if not server_meta:
        return hourly

    dialect_name = (db.engine.dialect.name or "").lower()
    if dialect_name == "sqlite":
        rows = (
            base_q.with_entities(
                MediaStreamHistory.server_id.label("server_id"),
                func.strftime("%H", MediaStreamHistory.started_at).label("hour"),
                func.count(MediaStreamHistory.id).label("count"),
            )
            .group_by(MediaStreamHistory.server_id, "hour")
            .all()
        )
    else:
        rows = (
            base_q.with_entities(
                MediaStreamHistory.server_id.label("server_id"),
                func.extract("hour", MediaStreamHistory.started_at).label("hour"),
                func.count(MediaStreamHistory.id).label("count"),
            )
            .group_by(MediaStreamHistory.server_id, "hour")
            .all()
        )

    server_key_by_id = {int(server["id"]): server["key"] for server in server_meta}
    for row in rows:
        try:
            server_id = int(getattr(row, "server_id", 0) or 0)
            hour_index = int(getattr(row, "hour", 0) or 0)
            count = int(getattr(row, "count", 0) or 0)
        except (TypeError, ValueError):
            continue
        server_key = server_key_by_id.get(server_id)
        if server_key is None or not (0 <= hour_index <= 23):
            continue
        hourly[hour_index]["values"][server_key] = count

    return hourly


def _build_device_mix_separated(base_q, server_meta: list[dict]) -> dict:
    if not server_meta:
        return {"categories": [], "rows": []}

    rows = (
        base_q.with_entities(
            MediaStreamHistory.server_id,
            MediaStreamHistory.platform,
            MediaStreamHistory.product,
            MediaStreamHistory.player,
            func.count(MediaStreamHistory.id).label("count"),
        )
        .group_by(
            MediaStreamHistory.server_id,
            MediaStreamHistory.platform,
            MediaStreamHistory.product,
            MediaStreamHistory.player,
        )
        .all()
    )

    per_server_counts: dict[int, dict[str, int]] = {int(server["id"]): {} for server in server_meta}
    global_counts: dict[str, int] = {}
    for row in rows:
        try:
            server_id = int(getattr(row, "server_id", 0) or 0)
            count = int(getattr(row, "count", 0) or 0)
        except (TypeError, ValueError):
            continue
        if server_id not in per_server_counts or count <= 0:
            continue
        bucket = _classify_device(
            getattr(row, "platform", None),
            getattr(row, "product", None),
            getattr(row, "player", None),
        )
        per_server_counts[server_id][bucket] = per_server_counts[server_id].get(bucket, 0) + count
        global_counts[bucket] = global_counts.get(bucket, 0) + count

    sorted_categories = sorted(global_counts.items(), key=lambda item: item[1], reverse=True)
    top_names = [name for name, _ in sorted_categories[:5]]
    include_others = any(name not in top_names for name in global_counts)
    category_names = top_names + (["Others"] if include_others else [])
    palette = ["#06b6d4", "#3b82f6", "#8b5cf6", "#64748b", "#f59e0b", "#ec4899"]
    categories = [
        {"key": name, "label": name, "color": palette[idx % len(palette)]}
        for idx, name in enumerate(category_names)
    ]

    rows_out: list[dict] = []
    for server in server_meta:
        server_id = int(server["id"])
        counts = per_server_counts.get(server_id, {})
        total = sum(counts.values())
        value_map: dict[str, int] = {}
        count_map: dict[str, int] = {}
        for category in category_names:
            if category == "Others":
                cat_count = sum(count for name, count in counts.items() if name not in top_names)
            else:
                cat_count = int(counts.get(category, 0) or 0)
            count_map[category] = cat_count
            value_map[category] = round((cat_count / total) * 100) if total > 0 else 0
        rows_out.append(
            {
                "server_id": server_id,
                "server_key": server["key"],
                "server_name": server["name"],
                "service_type": server["service_type"],
                "total": total,
                "values": value_map,
                "counts": count_map,
            }
        )
    return {"categories": categories, "rows": rows_out}


def _build_playback_health_separated(base_q, server_meta: list[dict]) -> tuple[dict, dict]:
    categories = [
        {"key": "Direct Play", "label": "Direct Play", "color": "#10b981"},
        {"key": "Direct Stream", "label": "Direct Stream", "color": "#3b82f6"},
        {"key": "Transcode", "label": "Transcode", "color": "#ef4444"},
    ]
    if not server_meta:
        return {"categories": categories, "rows": []}, {"total_rows_considered": 0, "rows_with_playback_mode": 0}

    per_server = {int(server["id"]): {"Direct Play": 0, "Direct Stream": 0, "Transcode": 0} for server in server_meta}
    total_rows = 0
    rows_with_mode = 0
    rows = base_q.with_entities(MediaStreamHistory.server_id, MediaStreamHistory.service_data).all()
    for row in rows:
        try:
            server_id = int(getattr(row, "server_id", 0) or 0)
        except (TypeError, ValueError):
            continue
        if server_id not in per_server:
            continue
        total_rows += 1
        mode = _playback_mode_from_service_data(getattr(row, "service_data", None))
        if not mode:
            continue
        rows_with_mode += 1
        if mode == "direct_play":
            per_server[server_id]["Direct Play"] += 1
        elif mode == "direct_stream":
            per_server[server_id]["Direct Stream"] += 1
        elif mode == "transcode":
            per_server[server_id]["Transcode"] += 1

    rows_out: list[dict] = []
    for server in server_meta:
        server_id = int(server["id"])
        counts = per_server[server_id]
        total = sum(counts.values())
        rows_out.append(
            {
                "server_id": server_id,
                "server_key": server["key"],
                "server_name": server["name"],
                "service_type": server["service_type"],
                "total": total,
                "counts": counts,
                "values": {
                    key: (round((count / total) * 100) if total > 0 else 0)
                    for key, count in counts.items()
                },
            }
        )

    return (
        {"categories": categories, "rows": rows_out},
        {"total_rows_considered": total_rows, "rows_with_playback_mode": rows_with_mode},
    )


def _build_watch_time_activity(base_q, start_day, days: int) -> list[dict]:
    per_day: dict[str, float] = {}
    for i in range(days):
        day = start_day + timedelta(days=i)
        per_day[day.isoformat()] = 0.0

    rows = (
        base_q.with_entities(
            func.date(MediaStreamHistory.started_at).label("day"),
            func.coalesce(func.sum(MediaStreamHistory.duration_seconds), 0).label("seconds"),
        )
        .group_by("day")
        .all()
    )
    for row in rows:
        day = str(getattr(row, "day", "") or "")
        if day not in per_day:
            continue
        try:
            per_day[day] = float(getattr(row, "seconds", 0) or 0)
        except (TypeError, ValueError):
            per_day[day] = 0.0

    return [
        {
            "date": day,
            "label": day,
            "minutes": round(seconds / 60, 1),
        }
        for day, seconds in sorted(per_day.items())
    ]


def _build_watch_time_activity_separated(base_q, server_meta: list[dict], start_day, days: int) -> list[dict]:
    daily = [
        {
            "date": (start_day + timedelta(days=i)).isoformat(),
            "label": (start_day + timedelta(days=i)).isoformat(),
            "values": {server["key"]: 0.0 for server in server_meta},
        }
        for i in range(days)
    ]
    if not server_meta:
        return daily

    by_date = {row["date"]: row for row in daily}
    server_key_by_id = {int(server["id"]): server["key"] for server in server_meta}

    rows = (
        base_q.with_entities(
            MediaStreamHistory.server_id.label("server_id"),
            func.date(MediaStreamHistory.started_at).label("day"),
            func.coalesce(func.sum(MediaStreamHistory.duration_seconds), 0).label("seconds"),
        )
        .group_by(MediaStreamHistory.server_id, "day")
        .all()
    )
    for row in rows:
        try:
            server_id = int(getattr(row, "server_id", 0) or 0)
            seconds = float(getattr(row, "seconds", 0) or 0)
        except (TypeError, ValueError):
            continue
        day = str(getattr(row, "day", "") or "")
        server_key = server_key_by_id.get(server_id)
        day_row = by_date.get(day)
        if not server_key or day_row is None:
            continue
        day_row["values"][server_key] = round(seconds / 60, 1)

    return daily


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
    start_day = (generated_at.date() - timedelta(days=max(query.days - 1, 0)))
    server_mode = _normalize_server_mode(query.server_mode)

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
    watch_time_activity: list[dict] = []
    device_preferences: list[dict] = []
    separated_payload: dict | None = None

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

        watch_time_activity = _build_watch_time_activity(base_q, start_day, query.days)
        playback_health, playback_health_meta = _playback_health_from_history(base_q)

        if server_mode == "separated" and selected_server_id is None:
            separated_servers = _supported_separated_servers(effective_servers, scoped_server_ids)
            separated_server_meta = [
                {
                    "id": server.id,
                    "key": f"s{server.id}",
                    "name": server.server_nickname,
                    "service_type": server.service_type.value,
                }
                for server in separated_servers
            ]
            separated_server_ids = {server.id for server in separated_servers}
            separated_base_q = base_q.filter(MediaStreamHistory.server_id.in_(separated_server_ids)) if separated_server_ids else None

            separated_device = (
                _build_device_mix_separated(separated_base_q, separated_server_meta)
                if separated_base_q is not None
                else {"categories": [], "rows": []}
            )
            separated_playback, separated_playback_meta = (
                _build_playback_health_separated(separated_base_q, separated_server_meta)
                if separated_base_q is not None
                else (
                    {"categories": [], "rows": []},
                    {"total_rows_considered": 0, "rows_with_playback_mode": 0},
                )
            )

            separated_payload = {
                "enabled": True,
                "servers": separated_server_meta,
                "hourly_activity": (
                    _build_hourly_activity_separated(separated_base_q, separated_server_meta)
                    if separated_base_q is not None
                    else _build_hourly_activity_separated(base_q.filter(MediaStreamHistory.id == -1), [])
                ),
                "watch_time_activity": (
                    _build_watch_time_activity_separated(separated_base_q, separated_server_meta, start_day, query.days)
                    if separated_base_q is not None
                    else []
                ),
                "device_preferences": separated_device,
                "playback_health": separated_playback,
                "excluded_service_types": sorted(SEPARATED_UNSUPPORTED_SERVICE_TYPES),
                "playback_health_meta": separated_playback_meta,
            }
    else:
        playback_health = _zero_playback_health()

    payload = {
        "hourly_activity": hourly_activity,
        "watch_time_activity": watch_time_activity,
        "device_preferences": device_preferences,
        "playback_health": playback_health,
    }
    if separated_payload is not None:
        payload["separated"] = separated_payload
    meta = {
        "request_id": request_id,
        "generated_at": generated_at.isoformat() + "Z",
        "filters": {
            "days": query.days,
            "server_id": query.server_id or "all",
            "server_mode": server_mode,
            "effective_server_count": len(effective_server_ids),
            "scoped_server_count": len(scoped_server_ids),
        },
        "sources": {
            "hourly_activity": "media_stream_history",
            "watch_time_activity": "media_stream_history.duration_seconds",
            "device_preferences": "media_stream_history",
            "playback_health": "media_stream_history.service_data",
        },
        "notes": [
            "Playback Health is calculated from historical stream records (media_stream_history.service_data.playback_mode). Older rows recorded before playback mode persistence may not appear in this chart.",
        ],
        "playback_health": playback_health_meta,
    }
    if server_mode == "separated":
        meta["notes"].append(
            "All Servers (Separated) excludes kavita, komga, and romm because they do not provide compatible stream-history analytics for these charts."
        )

    return jsonify({"data": payload, "meta": meta}), 200
