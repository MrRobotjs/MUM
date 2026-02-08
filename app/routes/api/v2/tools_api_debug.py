from __future__ import annotations

from typing import List, Optional
from urllib.parse import urlparse, urlunparse

import requests
from flask import jsonify
from flask_openapi3 import Tag
from pydantic import BaseModel

from app.routes.api.v2 import api_v2
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required


tools_tag = Tag(name="Tools", description="Developer tools and diagnostics")


def _looks_like_jwt(token: str) -> bool:
    if not token:
        return False
    parts = token.split(".")
    return len(parts) == 3 and all(parts)


def _get_kavita_jwt_token(base_url: str, api_key: str) -> str | None:
    if not base_url or not api_key:
        return None
    if _looks_like_jwt(api_key):
        return api_key

    auth_url = f"{base_url.rstrip('/')}/api/Plugin/authenticate"
    headers = {"accept": "text/plain"}
    params = {"apiKey": api_key, "pluginName": "MUM"}
    try:
        resp = requests.post(auth_url, headers=headers, params=params, timeout=30, verify=False)
        resp.raise_for_status()
        try:
            data = resp.json()
            token = (data.get("token") or "").strip()
        except ValueError:
            token = resp.text.strip()
        return token or None
    except requests.exceptions.RequestException:
        return None


class QueryParam(BaseModel):
    key: str
    value: str


class ApiDebugExecuteBody(BaseModel):
    method: str
    endpoint: str
    response_format: str = "json"  # "json" | "xml"
    parameters: Optional[List[QueryParam]] = None
    server_id: str | int
    protocol: Optional[str] = None  # "http" | "https"


class ApiDebugExecuteResponse(BaseModel):
    success: bool
    status_code: int | None = None
    status_text: str | None = None
    headers: dict | None = None
    url: str | None = None
    method: str | None = None
    response_text: str | None = None
    response_json: dict | list | None = None
    response_xml: str | None = None
    response_format: str | None = None
    elapsed_ms: int | None = None
    error: str | None = None


@api_v2.post(
    "/tools/api-debug/execute",
    tags=[tools_tag],
    summary="Execute an arbitrary API request against a configured media server",
    responses={200: ApiDebugExecuteResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def api_debug_execute(body: ApiDebugExecuteBody, current_user):
    from app.models_media_services import MediaServer

    try:
        # Validate server (accept numeric ID or nickname)
        server = None
        server_identifier = str(body.server_id)
        try:
            sid_int = int(server_identifier)
            server = MediaServer.query.get(sid_int)
        except Exception:
            server = MediaServer.query.filter_by(server_nickname=server_identifier).first()

        server_url = None
        service_type = ""
        api_key = None
        username = None
        password = None

        if not server:
            if server_identifier == "plex.tv":
                server_url = "https://plex.tv"
                service_type = "plex"
            else:
                return jsonify({"error": {"code": "SERVER_NOT_FOUND", "message": "Server not found"}}), 404
        else:
            server_url = server.url
            service_type = server.service_type.value if server.service_type else ""
            api_key = server.api_key
            username = server.username
            password = server.password

        # Build base URL with optional protocol override
        base_url = (server_url or "").strip()
        protocol = body.protocol if body.protocol in ("http", "https") else None
        if protocol:
            sanitized = base_url or ""
            if sanitized:
                try:
                    parsed = urlparse(sanitized)
                    if not parsed.scheme:
                        parsed = urlparse(f"{protocol}://{sanitized.lstrip('/')}")
                    parsed = parsed._replace(scheme=protocol)
                    if not parsed.netloc and parsed.path:
                        parsed = parsed._replace(netloc=parsed.path, path="")
                    base_url = urlunparse(parsed)
                except ValueError:
                    without_scheme = sanitized.replace("://", "").lstrip("/")
                    base_url = f"{protocol}://{without_scheme}"
            else:
                base_url = f"{protocol}://"

        base_url = base_url.rstrip("/")
        endpoint = body.endpoint if body.endpoint.startswith("/") else f"/{body.endpoint}"
        full_url = base_url + endpoint

        # Append query params
        params = []
        for p in (body.parameters or []):
            if p.key and p.value:
                params.append((p.key, p.value))

        if params:
            from urllib.parse import urlencode
            sep = '&' if '?' in full_url else '?'
            full_url = f"{full_url}{sep}{urlencode(params)}"

        # Prepare headers/auth
        headers = {}
        if body.response_format == "xml":
            headers["Accept"] = "application/xml, text/xml"
        else:
            headers["Accept"] = "application/json"
        headers["Content-Type"] = "application/json"

        auth = None
        if service_type == "plex" and api_key:
            headers["X-Plex-Token"] = api_key
        elif service_type in ("jellyfin", "emby") and api_key:
            headers["X-Emby-Token"] = api_key
        elif service_type == "kavita" and api_key:
            jwt_token = _get_kavita_jwt_token(base_url, api_key)
            headers["Authorization"] = f"Bearer {jwt_token or api_key}"
        elif service_type in ("audiobookshelf", "komga", "romm") and api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        if username and password:
            auth = (username, password)

        # Execute request
        method = (body.method or "GET").upper()
        timeout = 30
        try:
            if method == "GET":
                resp = requests.get(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
            elif method == "POST":
                resp = requests.post(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
            elif method == "PUT":
                resp = requests.put(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
            elif method == "PATCH":
                resp = requests.patch(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
            elif method == "DELETE":
                resp = requests.delete(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
            elif method == "HEAD":
                resp = requests.head(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
            elif method == "OPTIONS":
                resp = requests.options(full_url, headers=headers, auth=auth, timeout=timeout, verify=False)
            else:
                return jsonify({"error": {"code": "BAD_REQUEST", "message": f"Unsupported method: {method}"}}), 400
        except requests.exceptions.Timeout:
            return jsonify({"error": {"code": "TIMEOUT", "message": "Request timed out"}}), 408
        except requests.exceptions.ConnectionError:
            return jsonify({"error": {"code": "UNREACHABLE", "message": "Connection error - could not reach server"}}), 502
        except requests.exceptions.RequestException as e:
            return jsonify({"error": {"code": "REQUEST_ERROR", "message": str(e)}}), 500

        # Parse response
        response_json = None
        response_xml = None
        try:
            ctype = resp.headers.get("content-type", "").lower()
            if body.response_format == "xml" or "xml" in ctype:
                response_xml = resp.text
                try:
                    response_json = resp.json()
                except Exception:
                    pass
            else:
                response_json = resp.json()
        except Exception:
            # leave as text
            pass

        result = {
            "success": True,
            "status_code": resp.status_code,
            "status_text": resp.reason,
            "headers": dict(resp.headers),
            "url": full_url,
            "method": method,
            "response_text": resp.text,
            "response_json": response_json,
            "response_xml": response_xml,
            "response_format": body.response_format,
            "elapsed_ms": int(getattr(resp, "elapsed", 0).total_seconds() * 1000) if hasattr(resp, "elapsed") else None,
        }

        return jsonify(result)

    except Exception as e:
        return jsonify({"error": {"code": "INTERNAL_ERROR", "message": str(e)}}), 500

