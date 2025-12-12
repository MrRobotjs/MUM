"""In-memory cache for latest realtime session payloads per service/server."""
from __future__ import annotations

from typing import Dict, List, Tuple
from threading import RLock

_cache: Dict[Tuple[str, int], List[dict]] = {}
_lock = RLock()


def set_sessions(service: str, server_id: int, sessions: List[dict]) -> None:
    with _lock:
        _cache[(service.lower(), int(server_id))] = sessions or []


def get_sessions(service: str, server_id: int) -> List[dict]:
    with _lock:
        return list(_cache.get((service.lower(), int(server_id)), []))


def clear() -> None:
    with _lock:
        _cache.clear()
