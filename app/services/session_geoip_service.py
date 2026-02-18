"""Session GeoIP enrichment helpers for streaming session payloads."""
from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any, Dict, Iterable, Optional
import xml.etree.ElementTree as ET

import requests
from flask import current_app

from app.utils.timeout_helper import get_api_timeout

_CACHE_TTL = timedelta(hours=12)
_GEOIP_CACHE: Dict[str, Dict[str, Any]] = {}
_CACHE_LOCK = Lock()


def get_first_available_plex_token(servers: Iterable[Any]) -> Optional[str]:
    """Return the first available Plex token from a server list."""
    for server in servers:
        service_type = getattr(getattr(server, "service_type", None), "value", None) or str(
            getattr(server, "service_type", "")
        ).lower()
        if service_type == "plex":
            token = getattr(server, "api_key", None)
            if token:
                return str(token)
    return None


def enrich_formatted_sessions_with_geo(
    sessions: Iterable[Dict[str, Any]],
    *,
    session_service_type: str,
    plex_primary_token: Optional[str],
    plex_fallback_token: Optional[str],
) -> list[Dict[str, Any]]:
    """
    Add `latitude` and `longitude` to formatted session dicts when possible.

    Routing order:
    - Plex sessions: Plex GeoIP -> ip-api fallback.
    - Non-Plex sessions: ip-api -> Plex GeoIP fallback.
    """
    service_type = (session_service_type or "").lower()
    enriched: list[Dict[str, Any]] = []

    for session in sessions:
        if not isinstance(session, dict):
            continue

        lat = _to_float(session.get("latitude"))
        lon = _to_float(session.get("longitude"))
        if lat is not None and lon is not None:
            session["latitude"] = lat
            session["longitude"] = lon
            enriched.append(session)
            continue

        ip = _extract_ip_address(session.get("location_ip"))
        if not ip or not _is_public_ip(ip):
            enriched.append(session)
            continue

        geo = _cache_get(ip)
        if not geo:
            if service_type == "plex":
                geo = _lookup_plex_geo(ip, plex_primary_token) or _lookup_ip_api_geo(ip)
            else:
                geo = _lookup_ip_api_geo(ip) or _lookup_plex_geo(ip, plex_fallback_token)
            if geo:
                _cache_set(ip, geo)

        if geo:
            session["latitude"] = geo["latitude"]
            session["longitude"] = geo["longitude"]
            if geo.get("city"):
                session.setdefault("location_city", geo["city"])
            if geo.get("country"):
                session.setdefault("location_country", geo["country"])

        enriched.append(session)

    return enriched


def _cache_get(ip: str) -> Optional[Dict[str, Any]]:
    now = datetime.now(timezone.utc)
    with _CACHE_LOCK:
        cached = _GEOIP_CACHE.get(ip)
        if not cached:
            return None
        if now - cached["updated_at"] > _CACHE_TTL:
            _GEOIP_CACHE.pop(ip, None)
            return None
        return dict(cached["data"])


def _cache_set(ip: str, geo: Dict[str, Any]) -> None:
    with _CACHE_LOCK:
        _GEOIP_CACHE[ip] = {
            "updated_at": datetime.now(timezone.utc),
            "data": dict(geo),
        }


def _to_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _extract_ip_address(raw_value: Any) -> Optional[str]:
    if raw_value is None:
        return None

    value = str(raw_value).strip()
    if not value:
        return None

    lowered = value.lower()
    if lowered in {"n/a", "na", "none", "unknown", "local"}:
        return None

    if value.startswith("::ffff:"):
        value = value[7:]

    if value.startswith("[") and "]" in value:
        value = value[1 : value.index("]")]
    elif value.count(":") == 1 and "." in value:
        host, _, port = value.partition(":")
        if host and port.isdigit():
            value = host

    if "%" in value:
        value = value.split("%", 1)[0]

    for candidate in (value, value.split(",")[0].strip()):
        try:
            ip_obj = ipaddress.ip_address(candidate)
            return str(ip_obj)
        except ValueError:
            continue
    return None


def _is_public_ip(ip: str) -> bool:
    try:
        ip_obj = ipaddress.ip_address(ip)
        return ip_obj.is_global
    except ValueError:
        return False


def _lookup_ip_api_geo(ip: str) -> Optional[Dict[str, Any]]:
    timeout = get_api_timeout()
    try:
        response = requests.get(
            f"http://ip-api.com/json/{ip}",
            params={
                "fields": "status,message,country,countryCode,regionName,city,lat,lon,timezone,query"
            },
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("status") != "success":
            return None

        lat = _to_float(data.get("lat"))
        lon = _to_float(data.get("lon"))
        if lat is None or lon is None:
            return None

        return {
            "latitude": lat,
            "longitude": lon,
            "city": data.get("city"),
            "country": data.get("country"),
            "provider": "ip-api",
        }
    except Exception:
        return None


def _lookup_plex_geo(ip: str, token: Optional[str]) -> Optional[Dict[str, Any]]:
    if not token:
        return None

    timeout = get_api_timeout()
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Plex-Token": token,
    }

    try:
        response = requests.get(
            "https://plex.tv/api/v2/geoip",
            params={"ip_address": ip},
            headers=headers,
            timeout=timeout,
        )
        response.raise_for_status()

        # Plex can return JSON or XML. Prefer JSON when possible.
        content_type = (response.headers.get("Content-Type") or "").lower()
        if "json" in content_type:
            data = response.json()
            return _parse_plex_json_geo(data)

        return _parse_plex_xml_geo(response.content)
    except Exception as exc:
        current_app.logger.debug("Plex GeoIP lookup failed for %s: %s", ip, exc)
        return None


def _parse_plex_json_geo(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    coordinates = str(data.get("coordinates") or "").strip()
    if not coordinates:
        return None

    parts = [part.strip() for part in coordinates.split(",")]
    if len(parts) != 2:
        return None

    lat = _to_float(parts[0])
    lon = _to_float(parts[1])
    if lat is None or lon is None:
        return None

    return {
        "latitude": lat,
        "longitude": lon,
        "city": data.get("city"),
        "country": data.get("country"),
        "provider": "plex",
    }


def _parse_plex_xml_geo(payload: bytes) -> Optional[Dict[str, Any]]:
    root = ET.fromstring(payload)
    coordinates = (root.attrib.get("coordinates") or "").strip()
    if not coordinates:
        return None

    parts = [part.strip() for part in coordinates.split(",")]
    if len(parts) != 2:
        return None

    lat = _to_float(parts[0])
    lon = _to_float(parts[1])
    if lat is None or lon is None:
        return None

    return {
        "latitude": lat,
        "longitude": lon,
        "city": root.attrib.get("city"),
        "country": root.attrib.get("country"),
        "provider": "plex",
    }
