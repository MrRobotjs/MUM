from __future__ import annotations

from flask import jsonify, request, abort, Response, current_app
from app.utils.jwt_decorators import jwt_header_or_cookie as jwt_required_with_user, jwt_permission_required
from flask_openapi3 import Tag
from pydantic import BaseModel

from app.routes.api_v2 import api_v2
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.models_media_services import ServiceType, MediaServer
from app.utils.timeout_helper import get_api_timeout

import requests


media_tag = Tag(name="Media", description="Media asset proxy endpoints")


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


def _get_conditional_headers() -> dict:
    headers: dict[str, str] = {}
    if_none_match = request.headers.get('If-None-Match')
    if if_none_match:
        headers['If-None-Match'] = if_none_match
    if_modified_since = request.headers.get('If-Modified-Since')
    if if_modified_since:
        headers['If-Modified-Since'] = if_modified_since
    return headers


def _build_image_response(img_response: requests.Response) -> Response:
    if img_response.status_code == 304:
        return Response(status=304)
    img_response.raise_for_status()
    content_type = img_response.headers.get('Content-Type', 'image/jpeg')
    resp = Response(img_response.iter_content(chunk_size=1024 * 8), content_type=content_type)
    etag = img_response.headers.get('ETag')
    last_mod = img_response.headers.get('Last-Modified')
    if etag:
        resp.headers['ETag'] = etag
    if last_mod:
        resp.headers['Last-Modified'] = last_mod
    content_len = img_response.headers.get('Content-Length')
    if content_len:
        resp.headers['Content-Length'] = content_len
    resp.headers['Cache-Control'] = 'private, max-age=3600'
    return resp


@api_v2.get(
    "/media/plex/images/proxy",
    tags=[media_tag],
    summary="Proxy Plex images",
)
@jwt_required_with_user()
def plex_image_proxy_v2(current_user):
    image_path_on_plex = request.args.get("path")
    if not image_path_on_plex:
        current_app.logger.warning("API v2 plex_image_proxy: 'path' parameter is missing.")
        abort(400)

    plex_servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX)
    if not plex_servers:
        current_app.logger.error("API v2 plex_image_proxy: No Plex servers found.")
        abort(503)

    plex_service = MediaServiceFactory.create_service_from_db(plex_servers[0])
    if not plex_service:
        current_app.logger.error("API v2 plex_image_proxy: Could not get Plex instance to proxy image.")
        abort(503)

    try:
        path_for_plexapi = image_path_on_plex
        if not path_for_plexapi.startswith('/'):
            path_for_plexapi = '/' + path_for_plexapi

        plex = plex_service._get_server_instance()
        full_authed_plex_image_url = plex.url(path_for_plexapi, includeToken=True)

        plex_timeout = current_app.config.get('PLEX_TIMEOUT', 10)
        img_response = plex._session.get(
            full_authed_plex_image_url,
            stream=True,
            timeout=plex_timeout,
            headers=_get_conditional_headers() or None,
        )
        return _build_image_response(img_response)
    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(
            f"API v2 plex_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Plex: {e_http} for path {image_path_on_plex}"
        )
        abort(e_http.response.status_code)
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API v2 plex_image_proxy: RequestException fetching from Plex: {e_req} for path {image_path_on_plex}")
        abort(500)
    except Exception as e:
        current_app.logger.error(f"API v2 plex_image_proxy: Unexpected error for path {image_path_on_plex}: {e}", exc_info=True)
        abort(500)


@api_v2.get(
    "/media/jellyfin/images/proxy",
    tags=[media_tag],
    summary="Proxy Jellyfin images",
)
@jwt_required_with_user()
def jellyfin_image_proxy_v2(current_user):
    item_id = request.args.get('item_id')
    image_type = request.args.get('image_type', 'Primary')
    image_tag = request.args.get('image_tag')

    if not item_id:
        current_app.logger.warning("API v2 jellyfin_image_proxy: 'item_id' parameter is missing.")
        return "Missing item_id parameter", 400

    try:
        jellyfin_servers = MediaServiceManager.get_servers_by_type(ServiceType.JELLYFIN, active_only=True)
        if not jellyfin_servers:
            current_app.logger.error("API v2 jellyfin_image_proxy: No Jellyfin servers found.")
            return "No Jellyfin servers available", 404

        jellyfin_server = jellyfin_servers[0]
        jellyfin_service = MediaServiceFactory.create_service_from_db(jellyfin_server)
        if not jellyfin_service:
            current_app.logger.error("API v2 jellyfin_image_proxy: Could not get Jellyfin instance to proxy image.")
            return "Could not connect to Jellyfin", 500

        jellyfin_image_url = f"{jellyfin_server.url.rstrip('/')}/Items/{item_id}/Images/{image_type}"
        if image_tag:
            jellyfin_image_url = f"{jellyfin_image_url}?tag={image_tag}"

        headers = {
            'X-Emby-Token': jellyfin_server.api_key,
            **_get_conditional_headers()
        }
        # Match v1 behavior for request timeouts
        timeout = get_api_timeout()
        img_response = requests.get(jellyfin_image_url, headers=headers, stream=True, timeout=timeout)
        return _build_image_response(img_response)
    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(
            f"API v2 jellyfin_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Jellyfin: {e_http} for item {item_id}"
        )
        return f"HTTP error fetching image: {e_http.response.status_code}", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API v2 jellyfin_image_proxy: RequestException fetching from Jellyfin: {e_req} for item {item_id}")
        return "Network error fetching image", 500
    except Exception as e:
        current_app.logger.error(f"API v2 jellyfin_image_proxy: Unexpected error for item {item_id}: {e}", exc_info=True)
        return "Error fetching image", 500


@api_v2.get(
    "/media/emby/images/proxy",
    tags=[media_tag],
    summary="Proxy Emby images",
)
@jwt_required_with_user()
def emby_image_proxy_v2(current_user):
    item_id = request.args.get('item_id')
    image_type = request.args.get('image_type', 'Primary')
    image_tag = request.args.get('image_tag')

    if not item_id:
        current_app.logger.warning("API v2 emby_image_proxy: 'item_id' parameter is missing.")
        return "Missing item_id parameter", 400

    try:
        emby_servers = MediaServiceManager.get_servers_by_type(ServiceType.EMBY, active_only=True)
        if not emby_servers:
            current_app.logger.error("API v2 emby_image_proxy: No Emby servers found.")
            return "No Emby servers available", 404

        emby_server = emby_servers[0]
        emby_service = MediaServiceFactory.create_service_from_db(emby_server)
        if not emby_service:
            current_app.logger.error("API v2 emby_image_proxy: Could not get Emby instance to proxy image.")
            return "Could not connect to Emby", 500

        emby_image_url = f"{emby_server.url.rstrip('/')}/Items/{item_id}/Images/{image_type}"
        if image_tag:
            emby_image_url = f"{emby_image_url}?tag={image_tag}"

        headers = {
            'X-Emby-Token': emby_server.api_key,
            **_get_conditional_headers()
        }
        timeout = get_api_timeout()
        img_response = requests.get(emby_image_url, headers=headers, stream=True, timeout=timeout)
        return _build_image_response(img_response)
    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(
            f"API v2 emby_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Emby: {e_http} for item {item_id}"
        )
        return f"HTTP error fetching image: {e_http.response.status_code}", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API v2 emby_image_proxy: RequestException fetching from Emby: {e_req} for item {item_id}")
        return "Network error fetching image", 500
    except Exception as e:
        current_app.logger.error(f"API v2 emby_image_proxy: Unexpected error for item {item_id}: {e}", exc_info=True)
        return "Error fetching image", 500


@api_v2.get(
    "/media/jellyfin/users/avatar",
    tags=[media_tag],
    summary="Proxy Jellyfin user avatar",
)
@jwt_required_with_user()
def jellyfin_user_avatar_proxy_v2(current_user):
    user_id = request.args.get('user_id')
    if not user_id:
        current_app.logger.warning("API v2 jellyfin_user_avatar_proxy: 'user_id' parameter is missing.")
        abort(400)

    try:
        jellyfin_servers = MediaServiceManager.get_servers_by_type(ServiceType.JELLYFIN, active_only=True)
        if not jellyfin_servers:
            current_app.logger.error("API v2 jellyfin_user_avatar_proxy: No Jellyfin servers found.")
            abort(404)

        jellyfin_server = jellyfin_servers[0]
        headers = {'X-Emby-Token': jellyfin_server.api_key}

        user_info_url = f"{jellyfin_server.url.rstrip('/')}/Users/{user_id}"
        # Match v1 behavior for request timeouts
        timeout = get_api_timeout()
        user_response = requests.get(user_info_url, headers=headers, timeout=timeout)
        user_response.raise_for_status()
        user_data = user_response.json()

        primary_image_tag = user_data.get('PrimaryImageTag')
        if not primary_image_tag:
            current_app.logger.debug(
                f"API v2 jellyfin_user_avatar_proxy: User {user_id} has no PrimaryImageTag, no avatar available"
            )
            return '', 404

        avatar_url = f"{jellyfin_server.url.rstrip('/')}/Users/{user_id}/Images/Primary?tag={primary_image_tag}&width=64&quality=90"
        img_response = requests.get(avatar_url, headers=headers, stream=True, timeout=timeout)
        img_response.raise_for_status()
        content_type = img_response.headers.get('Content-Type', 'image/jpeg')
        return Response(img_response.content, content_type=content_type)
    except requests.exceptions.HTTPError as e_http:
        if e_http.response and e_http.response.status_code == 404:
            current_app.logger.debug(
                f"API v2 jellyfin_user_avatar_proxy: User {user_id} avatar not found (404)"
            )
        else:
            current_app.logger.error(
                f"API v2 jellyfin_user_avatar_proxy: HTTPError ({getattr(e_http.response,'status_code', 'n/a')}) fetching avatar for user {user_id}: {e_http}"
            )
        abort(getattr(e_http.response, 'status_code', 500))
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(
            f"API v2 jellyfin_user_avatar_proxy: RequestException fetching avatar for user {user_id}: {e_req}"
        )
        abort(500)
    except Exception as e:
        current_app.logger.error(
            f"API v2 jellyfin_user_avatar_proxy: Unexpected error for user {user_id}: {e}",
            exc_info=True,
        )
        abort(500)


@api_v2.get(
    "/media/romm/images/proxy",
    tags=[media_tag],
    summary="Proxy RomM images",
)
@jwt_required_with_user()
def romm_image_proxy_v2(current_user):
    image_path = request.args.get('path')
    server_id = request.args.get('server_id')
    if not image_path:
        current_app.logger.warning("API v2 romm_image_proxy: 'path' parameter is missing.")
        return "Missing path parameter", 400
    if not server_id:
        current_app.logger.warning("API v2 romm_image_proxy: 'server_id' parameter is missing.")
        return "Missing server_id parameter", 400

    try:
        romm_server = MediaServer.query.filter_by(id=server_id, service_type=ServiceType.ROMM).first()
        if not romm_server:
            current_app.logger.error("API v2 romm_image_proxy: RomM server not found.")
            return "RomM server not found", 404

        romm_service = MediaServiceFactory.create_service_from_db(romm_server)
        if not romm_service:
            current_app.logger.error("API v2 romm_image_proxy: Could not get RomM instance to proxy image.")
            return "Could not connect to RomM", 500

        if not romm_service._setup_auth_headers():
            current_app.logger.error("API v2 romm_image_proxy: Failed to setup authentication.")
            return "Authentication failed", 500

        full_image_url = f"{romm_server.url.rstrip('/')}{image_path}"
        response = romm_service.session.get(full_image_url)
        response.raise_for_status()
        content_type = response.headers.get('content-type', 'image/jpeg')
        return Response(response.content, content_type=content_type)
    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(
            f"API v2 romm_image_proxy: HTTPError ({e_http.response.status_code}) fetching from RomM: {e_http} for path {image_path}"
        )
        return "Error fetching image from RomM", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(
            f"API v2 romm_image_proxy: RequestException fetching from RomM: {e_req} for path {image_path}"
        )
        return "Error connecting to RomM", 500
    except Exception as e:
        current_app.logger.error(
            f"API v2 romm_image_proxy: Unexpected error for path {image_path}: {e}", exc_info=True
        )
        return "Error fetching image", 500


@api_v2.get(
    "/media/komga/images/proxy",
    tags=[media_tag],
    summary="Proxy Komga images",
)
@jwt_required_with_user()
def komga_image_proxy_v2(current_user):
    series_id = request.args.get('series_id')
    book_id = request.args.get('book_id')
    server_id = request.args.get('server_id')
    if not series_id and not book_id:
        current_app.logger.warning("API v2 komga_image_proxy: Either 'series_id' or 'book_id' parameter is required.")
        return "Missing series_id or book_id parameter", 400
    if not server_id:
        current_app.logger.warning("API v2 komga_image_proxy: 'server_id' parameter is missing.")
        return "Missing server_id parameter", 400

    try:
        komga_server = MediaServer.query.filter_by(id=server_id, service_type=ServiceType.KOMGA).first()
        if not komga_server:
            current_app.logger.error("API v2 komga_image_proxy: Komga server not found.")
            return "Komga server not found", 404

        komga_service = MediaServiceFactory.create_service_from_db(komga_server)
        if not komga_service:
            current_app.logger.error("API v2 komga_image_proxy: Could not get Komga instance to proxy image.")
            return "Could not connect to Komga", 500

        if series_id:
            thumbnail_url = f"{komga_server.url.rstrip('/')}/api/v1/series/{series_id}/thumbnail"
        else:
            thumbnail_url = f"{komga_server.url.rstrip('/')}/api/v1/books/{book_id}/thumbnail"

        headers = komga_service._get_headers()
        response = requests.get(thumbnail_url, headers=headers)
        response.raise_for_status()
        content_type = response.headers.get('content-type', 'image/jpeg')
        return Response(response.content, content_type=content_type)
    except requests.exceptions.HTTPError as e_http:
        item_id = series_id or book_id
        current_app.logger.error(
            f"API v2 komga_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Komga: {e_http} for item {item_id}"
        )
        return "Error fetching image from Komga", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        item_id = series_id or book_id
        current_app.logger.error(
            f"API v2 komga_image_proxy: RequestException fetching from Komga: {e_req} for item {item_id}"
        )
        return "Error connecting to Komga", 500
    except Exception as e:
        item_id = series_id or book_id
        current_app.logger.error(
            f"API v2 komga_image_proxy: Unexpected error for item {item_id}: {e}", exc_info=True
        )
        return "Error fetching image", 500


@api_v2.get(
    "/media/kavita/images/proxy",
    tags=[media_tag],
    summary="Proxy Kavita OPDS images",
)
@jwt_required_with_user()
def kavita_image_proxy_v2(current_user):
    image_path = request.args.get('path')
    server_id = request.args.get('server_id')
    series_id = request.args.get('series_id')
    library_id = request.args.get('library_id')
    volume_id = request.args.get('volume_id')
    chapter_id = request.args.get('chapter_id')
    page_number = request.args.get('page_number')
    if not image_path:
        if not (series_id or library_id or volume_id or chapter_id):
            current_app.logger.warning("API v2 kavita_image_proxy: missing path or entity id.")
            return "Missing path or entity id", 400
    if not server_id:
        current_app.logger.warning("API v2 kavita_image_proxy: 'server_id' parameter is missing.")
        return "Missing server_id parameter", 400

    try:
        kavita_server = MediaServer.query.filter_by(id=server_id, service_type=ServiceType.KAVITA).first()
        if not kavita_server:
            current_app.logger.error("API v2 kavita_image_proxy: Kavita server not found.")
            return "Kavita server not found", 404

        if not kavita_server.api_key:
            current_app.logger.error("API v2 kavita_image_proxy: Kavita server missing API key.")
            return "Kavita API key not configured", 500

        if series_id or library_id or volume_id or chapter_id:
            # Use standard image endpoint with apiKey query parameter
            params = {"apiKey": kavita_server.api_key}
            if series_id:
                params["seriesId"] = series_id
            if library_id:
                params["libraryId"] = library_id
            if volume_id:
                params["volumeId"] = volume_id
            if chapter_id:
                params["chapterId"] = chapter_id
            image_url = f"{kavita_server.url.rstrip('/')}/api/Image/series-cover"
            if volume_id:
                image_url = f"{kavita_server.url.rstrip('/')}/api/Image/volume-cover"
            if chapter_id:
                image_url = f"{kavita_server.url.rstrip('/')}/api/Image/chapter-cover"
            if library_id and not (series_id or volume_id or chapter_id):
                image_url = f"{kavita_server.url.rstrip('/')}/api/Image/library-cover"
            if page_number is not None:
                params["pageNumber"] = page_number
            from urllib.parse import urlencode
            image_url = f"{image_url}?{urlencode(params)}"
        else:
            # Strip any embedded OPDS token from the path and rebuild with server API key
            marker = "/api/opds/"
            path = image_path or ""
            lower_path = path.lower()
            if marker in lower_path:
                after = path[lower_path.index(marker) + len(marker):]
                parts = after.split("/", 1)
                if len(parts) == 2:
                    path = "/" + parts[1]
                else:
                    path = "/"

            base_opds = f"{kavita_server.url.rstrip('/')}/api/Opds/{kavita_server.api_key}"
            if not path.startswith("/"):
                path = "/" + path
            image_url = f"{base_opds}{path}"

        timeout = get_api_timeout()
        img_response = requests.get(image_url, stream=True, timeout=timeout, headers=_get_conditional_headers() or None)
        return _build_image_response(img_response)
    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(
            f"API v2 kavita_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Kavita: {e_http} for path {image_path}"
        )
        return "Error fetching image from Kavita", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(
            f"API v2 kavita_image_proxy: RequestException fetching from Kavita: {e_req} for path {image_path}"
        )
        return "Error connecting to Kavita", 500
    except Exception as e:
        current_app.logger.error(
            f"API v2 kavita_image_proxy: Unexpected error for path {image_path}: {e}", exc_info=True
        )
        return "Error fetching image", 500


@api_v2.get(
    "/media/audiobookshelf/images/proxy",
    tags=[media_tag],
    summary="Proxy AudioBookshelf images",
)
@jwt_required_with_user()
def audiobookshelf_image_proxy_v2(current_user):
    image_path = request.args.get('path')
    current_app.logger.info(f"API v2 audiobookshelf_image_proxy: Called with path='{image_path}'")
    if not image_path:
        current_app.logger.warning("API v2 audiobookshelf_image_proxy: 'path' parameter is missing.")
        abort(400)

    abs_servers = MediaServiceManager.get_servers_by_type(ServiceType.AUDIOBOOKSHELF)
    if not abs_servers:
        current_app.logger.error("API v2 audiobookshelf_image_proxy: No AudioBookshelf servers found.")
        abort(503)

    abs_service = MediaServiceFactory.create_service_from_db(abs_servers[0])
    if not abs_service:
        current_app.logger.error("API v2 audiobookshelf_image_proxy: Could not get AudioBookshelf instance to proxy image.")
        abort(503)

    try:
        # Normalize metadata cover paths to stable item cover endpoints
        normalized_path = image_path.lstrip('/')
        if normalized_path.startswith('metadata/items/'):
            parts = normalized_path.split('/')
            if len(parts) >= 3:
                item_id = parts[2]
                normalized_path = f"items/{item_id}/cover"
        image_path = normalized_path

        if not image_path.startswith('/'):
            image_path = '/' + image_path
        full_image_url = f"{abs_service.url.rstrip('/')}/api{image_path}"
        current_app.logger.debug(
            f"API v2 audiobookshelf_image_proxy: Fetching image from AudioBookshelf URL: {full_image_url}"
        )

        alternative_urls: list[str] = []
        if image_path.startswith('items/'):
            item_id = image_path.split('/')[1] if '/' in image_path else image_path.replace('items/', '')
            alternative_urls.extend([
                f"{abs_service.url.rstrip('/')}/api/items/{item_id}/cover",
                f"{abs_service.url.rstrip('/')}/api/items/{item_id}/thumbnail",
                f"{abs_service.url.rstrip('/')}/feed/{item_id}/cover",
                f"{abs_service.url.rstrip('/')}/api/items/{item_id}/image",
                f"{abs_service.url.rstrip('/')}/{image_path}",
                f"{abs_service.url.rstrip('/')}/api/{image_path.replace('/cover', '/cover.jpg')}",
                f"{abs_service.url.rstrip('/')}/api/{image_path.replace('/cover', '/cover.png')}",
            ])
        else:
            alternative_urls.extend([
                f"{abs_service.url.rstrip('/')}/{image_path}",
                f"{abs_service.url.rstrip('/')}/s/{image_path}",
            ])

        headers = abs_service._get_headers()
        # Match v1 behavior for request timeouts
        timeout = get_api_timeout()
        urls_to_try = [full_image_url] + alternative_urls
        last_error: Exception | None = None

        for i, url_to_try in enumerate(urls_to_try):
            try:
                current_app.logger.debug(
                    f"API v2 audiobookshelf_image_proxy: Attempt {i+1} - trying URL: {url_to_try}"
                )
                img_response = requests.get(url_to_try, headers=headers, stream=True, timeout=timeout)
                img_response.raise_for_status()
                content_type = img_response.headers.get('Content-Type', 'image/jpeg')
                current_app.logger.info(
                    f"API v2 audiobookshelf_image_proxy: Success with URL: {url_to_try}"
                )
                return Response(img_response.iter_content(chunk_size=1024*8), content_type=content_type)
            except requests.exceptions.HTTPError as e:
                last_error = e
                current_app.logger.debug(
                    f"API v2 audiobookshelf_image_proxy: Attempt {i+1} failed with {e.response.status_code}: {url_to_try}"
                )
                continue
            except requests.exceptions.RequestException as e:
                last_error = e
                current_app.logger.debug(
                    f"API v2 audiobookshelf_image_proxy: Attempt {i+1} failed with RequestException: {e}"
                )
                continue

        if isinstance(last_error, requests.exceptions.HTTPError):
            raise last_error
        else:
            raise last_error or Exception("All URL attempts failed")
    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(
            f"API v2 audiobookshelf_image_proxy: HTTPError ({e_http.response.status_code}) fetching from AudioBookshelf: {e_http} for path {image_path}"
        )
        abort(e_http.response.status_code)
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(
            f"API v2 audiobookshelf_image_proxy: RequestException fetching from AudioBookshelf: {e_req} for path {image_path}"
        )
        abort(500)
    except Exception as e:
        current_app.logger.error(
            f"API v2 audiobookshelf_image_proxy: Unexpected error for path {image_path}: {e}",
            exc_info=True,
        )
        abort(500)
