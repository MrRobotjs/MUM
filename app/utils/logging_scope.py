from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def normalize_service_type_label(service_type: Any) -> str:
    raw_value = getattr(service_type, "value", service_type)
    if raw_value is None:
        return "UNKNOWN"
    label = str(raw_value).strip()
    return label.upper() if label else "UNKNOWN"


def normalize_server_name(server_nickname: Any) -> str:
    if server_nickname is None:
        return "UnknownServer"
    name = str(server_nickname).strip()
    return name if name else "UnknownServer"


def build_service_scope(service_type: Any, server_nickname: Any) -> str:
    return f"[{normalize_service_type_label(service_type)}:{normalize_server_name(server_nickname)}]"


def build_operation_source_label(
    service_type: Any,
    server_nickname: Any,
    server_id: Any | None = None,
) -> str:
    source = f"{normalize_service_type_label(service_type)}:{normalize_server_name(server_nickname)}"
    if server_id is None:
        return source
    return f"{source}:{server_id}"


def build_operation_banner(operation: str, source_label: str, phase: str) -> str:
    return f"=== {operation} ({source_label}) {phase} ==="


def format_scoped_message(scope: str, message: str) -> str:
    return f"{scope} {message}"


def elapsed_ms(started_at: datetime) -> int:
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    return int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
