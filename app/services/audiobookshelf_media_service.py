# File: app/services/audiobookshelf_media_service.py
from typing import List, Dict, Any, Optional, Tuple
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from datetime import datetime
import requests
from flask import current_app
from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType
from app.utils.timeout_helper import get_api_timeout

class AudiobookShelfMediaService(BaseMediaService):
    """AudiobookShelf implementation of BaseMediaService"""

    def __init__(self, server_config: Dict[str, Any]):
        super().__init__(server_config)
        self._http_log_date = None
        self._http_file_logger = None

    @property
    def service_type(self) -> ServiceType:
        return ServiceType.AUDIOBOOKSHELF

    def _create_http_file_handler_for_date(
        self, target_date: datetime
    ) -> tuple[RotatingFileHandler, bool] | None:
        date_str = target_date.strftime("%Y-%m-%d")
        log_path = None
        is_new_log = True

        override_path = os.getenv("AUDIOBOOKSHELF_HTTP_LOG_PATH")
        if override_path:
            try:
                os.makedirs(os.path.dirname(override_path), exist_ok=True)
                log_path = override_path
            except Exception as exc:
                self.log_error(f"Failed to create log directory for override path {override_path}: {exc}")
                log_path = None
        else:
            try:
                inst_dir = current_app.instance_path
                logs_dir = os.path.join(inst_dir, "logs", "audiobookshelf_http")
                os.makedirs(logs_dir, exist_ok=True)
                log_path = os.path.join(logs_dir, f"{date_str}.log")
            except Exception as exc:
                self.log_error(f"Failed to create instance log directory {inst_dir}: {exc}")
                return None

        try:
            test_file = open(log_path, "a")
            test_file.close()
        except Exception as exc:
            self.log_error(f"Cannot write to log file {log_path}: {exc}")
            return None

        try:
            if os.path.exists(log_path):
                try:
                    is_new_log = os.path.getsize(log_path) == 0
                except OSError:
                    is_new_log = False
            handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3)
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            return handler, is_new_log
        except Exception as exc:
            self.log_error(f"Failed to create file handler for {log_path}: {exc}")
            return None

    def _ensure_http_file_logger(self) -> None:
        logger_name = "audiobookshelf_http_monitor"
        self._http_file_logger = logging.getLogger(logger_name)

        try:
            target_date = datetime.now().date()
            handler_info = self._create_http_file_handler_for_date(datetime.combine(target_date, datetime.min.time()))

            if handler_info:
                handler, is_new_log = handler_info
                for existing in list(self._http_file_logger.handlers):
                    if isinstance(existing, RotatingFileHandler):
                        try:
                            self._http_file_logger.removeHandler(existing)
                            existing.close()
                        except Exception:
                            pass

                self._http_file_logger.addHandler(handler)
                self._http_file_logger.setLevel(logging.DEBUG)
                self._http_file_logger.propagate = False
                if is_new_log:
                    self._http_file_logger.info(
                        "AudiobookShelfMediaService HTTP logger initialized for %s - "
                        "NOTICE: Raw AudiobookShelf HTTP session payloads.",
                        target_date,
                    )
                self._http_log_date = target_date
            else:
                self._http_file_logger = current_app.logger
        except Exception as exc:
            self.log_error(f"Unexpected error initializing HTTP file logger: {exc}")
            self._http_file_logger = current_app.logger

    def _ensure_http_daily_log_file(self) -> None:
        try:
            today = datetime.now().date()
            if self._http_log_date == today:
                return
            self._ensure_http_file_logger()
        except Exception as exc:
            self.log_warning(f"Failed to rotate HTTP daily log file: {exc}")

    def _log_http_payload(self, payload: object) -> None:
        limit = current_app.config.get("AUDIOBOOKSHELF_HTTP_LOG_BYTES")
        if limit is None:
            try:
                env_limit = os.getenv("AUDIOBOOKSHELF_HTTP_LOG_BYTES")
                limit = int(env_limit) if env_limit is not None else 0
            except Exception:
                limit = 0

        try:
            limit_int = int(limit)
        except Exception:
            limit_int = 200

        server_id = self.server_id if self.server_id is not None else "unknown"
        nickname_suffix = f" [{self.name}]" if self.name else ""

        try:
            if isinstance(payload, (bytes, bytearray)):
                payload_text = payload.decode("utf-8", errors="ignore")
            elif isinstance(payload, str):
                payload_text = payload
            else:
                payload_text = json.dumps(payload, default=str)
        except Exception:
            payload_text = str(payload)

        if limit_int and limit_int > 0:
            snippet = payload_text[:limit_int]
            suffix = " (truncated)" if len(payload_text) > limit_int else ""
            msg = f"AudiobookShelfMediaService HTTP payload for server {server_id}{nickname_suffix}{suffix}: {snippet}"
        else:
            msg = f"AudiobookShelfMediaService HTTP payload for server {server_id}{nickname_suffix}: {payload_text}"

        try:
            self._ensure_http_daily_log_file()
            logger = self._http_file_logger if self._http_file_logger else current_app.logger
            if len(logger.handlers) > 0:
                logger.debug(msg)
                for handler in logger.handlers:
                    if isinstance(handler, RotatingFileHandler):
                        try:
                            handler.flush()
                        except Exception:
                            pass
        except Exception as exc:
            self.log_warning(f"Failed to write HTTP payload log: {exc}")
    
    def _get_headers(self):
        """Get headers for AudiobookShelf API requests"""
        return {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json'
        }
    
    def _convert_timestamp(self, timestamp):
        """Convert AudioBookshelf Unix timestamp to Python datetime object"""
        if timestamp is None:
            return None
        try:
            # AudioBookshelf returns timestamps in milliseconds
            if isinstance(timestamp, (int, float)):
                # Convert from milliseconds to seconds
                timestamp_seconds = timestamp / 1000.0
                return datetime.fromtimestamp(timestamp_seconds)
            elif isinstance(timestamp, str):
                try:
                    # Try parsing as Unix timestamp
                    timestamp_seconds = float(timestamp) / 1000.0
                    return datetime.fromtimestamp(timestamp_seconds)
                except ValueError:
                    # Try parsing as ISO format
                    return datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            else:
                # Already a datetime object
                return timestamp
        except (ValueError, TypeError, OSError) as e:
            self.log_warning(f"Could not convert timestamp {timestamp}: {e}")
            return None

    def _make_request(self, endpoint: str, method: str = 'GET', data: Dict = None):
        """Make API request to AudiobookShelf server"""
        url = f"{self.url.rstrip('/')}/api/{endpoint.lstrip('/')}"
        headers = self._get_headers()
        
        try:
            timeout = get_api_timeout()
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=timeout)
            elif method == 'POST':
                response = requests.post(url, headers=headers, json=data, timeout=timeout)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers, timeout=timeout)
            elif method == 'PATCH':
                response = requests.patch(url, headers=headers, json=data, timeout=timeout)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            response.raise_for_status()
            return response.json() if response.content else {}
        except requests.exceptions.RequestException as e:
            self.log_error(f"API request failed: {e}")
            raise
    
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection to AudiobookShelf server"""
        try:
            # Get server info including version from /api/authorize endpoint
            auth_info = self._make_request('authorize', method='POST')
            username = auth_info.get('user', {}).get('username', 'Unknown')
            
            # Get server version from serverSettings
            version = 'Unknown'
            server_settings = auth_info.get('serverSettings', {})
            if server_settings:
                version = server_settings.get('version', 'Unknown')
            
            if version != 'Unknown':
                return True, f"Connected to AudiobookShelf (v{version}) as user '{username}'"
            else:
                return True, f"Connected to AudiobookShelf as user '{username}'"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"
    
    def get_libraries_raw(self) -> List[Dict[str, Any]]:
        """Get raw, unmodified library data from AudiobookShelf API"""
        try:
            # Return the raw API response without any modifications
            libraries = self._make_request('libraries')
            self.log_info(f"Retrieved raw libraries from AudiobookShelf: {type(libraries)} with {len(libraries) if isinstance(libraries, list) else 'unknown'} items")
            self.log_info(f"Raw libraries response structure: {libraries}")
            return libraries
        except Exception as e:
            self.log_error(f"Error fetching raw libraries: {e}")
            return []
    
    def get_libraries(self) -> List[Dict[str, Any]]:
        """Get all AudiobookShelf libraries (processed for internal use)"""
        try:
            # Get raw data first
            libraries_response = self.get_libraries_raw()
            result = []
            
            # Handle different response formats
            if isinstance(libraries_response, list):
                # Direct array response
                libraries_list = libraries_response
                self.log_info(f"AudiobookShelf returned libraries as direct array with {len(libraries_list)} items")
            elif isinstance(libraries_response, dict):
                # Wrapped in object
                libraries_list = libraries_response.get('libraries', [])
                self.log_info(f"AudiobookShelf returned libraries wrapped in object with {len(libraries_list)} items")
            else:
                self.log_error(f"Unexpected libraries response format: {type(libraries_response)}")
                return []
            
            # Process the raw data for internal use
            for lib in libraries_list:
                lib_id = lib.get('id', '')
                
                # Get actual item count using /api/libraries/{id}/items?limit=0
                item_count = 0
                try:
                    if lib_id:
                        items_response = self._make_request(f'libraries/{lib_id}/items?limit=0')
                        self.log_info(f"AudioBookshelf items API response for '{lib.get('name')}': {items_response}")
                        item_count = items_response.get('total', 0)
                        self.log_info(f"AudioBookshelf library '{lib.get('name')}' has {item_count} items")
                except Exception as e:
                    self.log_info(f"Could not get item count for library '{lib.get('name')}': {e}")
                    # Fallback to stats if available
                    item_count = lib.get('stats', {}).get('totalItems', 0)
                
                result.append({
                    'id': lib_id,
                    'name': lib.get('name', 'Unknown'),
                    'type': lib.get('mediaType', 'book').lower(),
                    'item_count': item_count,
                    'external_id': lib_id
                })
            
            self.log_info(f"Processed {len(result)} libraries from AudiobookShelf")
            return result
        except Exception as e:
            self.log_error(f"Error fetching libraries: {e}")
            return []
    
    def get_users(self) -> List[Dict[str, Any]]:
        """Get all AudiobookShelf users"""
        try:
            users_response = self._make_request('users')
            result = []
            
            # Handle different response formats
            if isinstance(users_response, dict) and 'users' in users_response:
                users_list = users_response.get('users', [])
            elif isinstance(users_response, list):
                users_list = users_response
            else:
                self.log_error(f"Unexpected users response format: {type(users_response)}")
                return []
            
            for user in users_list:
                user_id = user.get('id')
                if not user_id:
                    continue
                
                # Get user's library access
                permissions = user.get('permissions', {})
                library_ids = permissions.get('librariesAccessible', [])
                
                # Debug logging for raw data
                self.log_info(f"AudioBookshelf user {user.get('username', 'Unknown')} raw data keys: {list(user.keys()) if isinstance(user, dict) else 'not a dict'}")
                self.log_info(f"AudioBookshelf user {user.get('username', 'Unknown')} raw data size: {len(str(user))}")
                
                result.append({
                    'id': user_id,
                    'uuid': user_id,
                    'username': user.get('username', 'Unknown'),
                    'email': user.get('email'),
                    'thumb': None,  # AudiobookShelf doesn't provide avatars in user list
                    'is_home_user': False,
                    'created_at': user.get('createdAt'),
                    'library_ids': library_ids,
                    'is_admin': user.get('type') == 'admin',
                    'raw_data': user  # Store individual user's raw data (not the full response)
                })
            
            return result
        except Exception as e:
            self.log_error(f"Error fetching users: {e}")
            return []
    
    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        """Create new AudiobookShelf user"""
        try:
            # Required fields according to API docs
            user_data = {
                'username': username,
                'password': password or 'changeme123',
                'type': 'user',  # Required: guest, user, or admin
                'isActive': True,
                'isLocked': False
            }
            
            # Add email if provided (not required by API)
            if email:
                user_data['email'] = email
            
            # Set up permissions object with all required fields
            library_ids = kwargs.get('library_ids', [])
            user_data['permissions'] = {
                'download': True,
                'update': True,
                'delete': False,
                'upload': False,
                'accessAllLibraries': len(library_ids) == 0,  # True if no specific libraries
                'accessAllTags': True,
                'accessExplicitContent': True
            }
            
            # Set library access if specified
            if library_ids:
                user_data['librariesAccessible'] = library_ids
            else:
                user_data['librariesAccessible'] = []  # Empty array means all libraries
            
            # Optional fields with defaults
            user_data['mediaProgress'] = []
            user_data['bookmarks'] = []
            user_data['seriesHideFromContinueListening'] = []
            user_data['itemTagsAccessible'] = []  # Empty array means all tags
            
            result = self._make_request('users', method='POST', data=user_data)
            
            return {
                'success': True,
                'user_id': result.get('id'),
                'username': username,
                'email': email or ''
            }
        except Exception as e:
            self.log_error(f"Error creating user: {e}")
            raise
    
    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        """Update AudiobookShelf user's library access"""
        try:
            if library_ids is not None:
                update_data = {
                    'permissions': {
                        'librariesAccessible': library_ids,
                        'accessAllLibraries': len(library_ids) == 0
                    }
                }
                self._make_request(f'users/{user_id}', method='PATCH', data=update_data)
            
            return True
        except Exception as e:
            self.log_error(f"Error updating user access: {e}")
            return False
    
    def delete_user(self, user_id: str) -> bool:
        """Delete AudiobookShelf user"""
        try:
            self._make_request(f'users/{user_id}', method='DELETE')
            return True
        except Exception as e:
            self.log_error(f"Error deleting user: {e}")
            return False
    
    def get_server_info(self) -> Dict[str, Any]:
        """Get AudiobookShelf server information"""
        try:
            # Get server info including version from /api/authorize endpoint
            version = 'Unknown'
            online = True
            
            try:
                auth_info = self._make_request('authorize', method='POST')
                server_settings = auth_info.get('serverSettings', {})
                if server_settings:
                    version = server_settings.get('version', 'Unknown')
            except Exception as e:
                self.log_info(f"Authorize endpoint failed in get_server_info: {e}, testing connectivity")
                # Test basic connectivity
                try:
                    self._make_request('me')  # Test basic connectivity
                except:
                    online = False
            
            return {
                'name': self.name,
                'url': self.url,
                'service_type': self.service_type.value,
                'online': online,
                'version': version
            }
        except:
            return {
                'name': self.name,
                'url': self.url,
                'service_type': self.service_type.value,
                'online': False,
                'version': 'Unknown'
            }

    def get_geoip_info(self, ip_address: str) -> Dict[str, Any]:
        """Get GeoIP information for a given IP address."""
        if not ip_address or ip_address in ['127.0.0.1', 'localhost']:
            return {"status": "local", "message": "This is a local address."}
        
        try:
            response = requests.get(f"http://ip-api.com/json/{ip_address}")
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            self.log_error(f"Failed to get GeoIP info for {ip_address}: {e}")
            return {"status": "error", "message": str(e)}
    
    def get_library_content(self, library_key: str, page: int = 1, per_page: int = 50) -> Dict[str, Any]:
        """Get library content from AudioBookshelf API"""
        try:
            # AudioBookshelf uses 0-indexed pages, so convert from 1-indexed
            abs_page = page - 1 if page > 0 else 0
            
            # Build query parameters based on API documentation
            params = []
            if per_page > 0:
                params.append(f"limit={per_page}")
            params.append(f"page={abs_page}")
            params.append("minified=0")  # Get full objects for better data
            
            query_string = "&".join(params)
            endpoint = f"libraries/{library_key}/items?{query_string}"
            
            self.log_info(f"AudioBookshelf: Fetching library content from {endpoint}")
            response = self._make_request(endpoint)
            
            # Extract items and metadata from response
            items = response.get('results', [])
            total = response.get('total', 0)
            
            self.log_info(f"AudioBookshelf: Retrieved {len(items)} items from library {library_key}, total: {total}")
            
            # Convert AudioBookshelf items to our standard format
            processed_items = []
            for item in items:
                try:
                    # Extract basic item info
                    item_id = item.get('id', '')
                    library_item = item  # The item itself is the library item
                    media = library_item.get('media', {})
                    metadata = media.get('metadata', {})
                    
                    # Handle different media types (book, podcast)
                    media_type = library_item.get('mediaType', 'book')
                    
                    # Extract title and other metadata
                    title = metadata.get('title', 'Unknown')
                    
                    # Extract additional metadata based on type
                    if media_type == 'book':
                        author = metadata.get('authors', [])
                        if isinstance(author, list) and author:
                            author = author[0] if isinstance(author[0], str) else author[0].get('name', 'Unknown')
                        elif isinstance(author, str):
                            pass  # Use as-is
                        else:
                            author = 'Unknown'
                        
                        series = metadata.get('series', [])
                        series_name = series[0].get('name') if series and isinstance(series, list) and series else None
                        
                        processed_item = {
                            'id': item_id,
                            'title': title,
                            'type': 'book',
                            'author': author,
                            'series': series_name,
                            'year': metadata.get('publishedYear'),
                            'summary': metadata.get('description', ''),
                            'rating': None,  # AudioBookshelf doesn't seem to have ratings
                            'duration': media.get('duration'),  # Duration in seconds
                            'added_at': self._convert_timestamp(library_item.get('addedAt')),
                            'updated_at': self._convert_timestamp(library_item.get('updatedAt')),
                            'thumb': None,  # Will be processed if available
                            'art': None,
                            'raw_data': item
                        }
                        
                    elif media_type == 'podcast':
                        processed_item = {
                            'id': item_id,
                            'title': title,
                            'type': 'podcast',
                            'author': metadata.get('author', 'Unknown'),
                            'description': metadata.get('description', ''),
                            'year': None,
                            'summary': metadata.get('description', ''),
                            'rating': None,
                            'duration': None,  # Podcasts have episodes with duration
                            'added_at': self._convert_timestamp(library_item.get('addedAt')),
                            'updated_at': self._convert_timestamp(library_item.get('updatedAt')),
                            'thumb': None,
                            'art': None,
                            'raw_data': item
                        }
                    else:
                        # Fallback for unknown types
                        processed_item = {
                            'id': item_id,
                            'title': title,
                            'type': media_type,
                            'year': None,
                            'summary': metadata.get('description', ''),
                            'rating': None,
                            'duration': media.get('duration'),
                            'added_at': self._convert_timestamp(library_item.get('addedAt')),
                            'updated_at': self._convert_timestamp(library_item.get('updatedAt')),
                            'thumb': None,
                            'art': None,
                            'raw_data': item
                        }
                    
                    # Handle cover/thumbnail if available
                    cover_path = media.get('coverPath')
                    self.log_info(f"AudioBookshelf: coverPath for '{title}': {cover_path}")
                    
                    if cover_path:
                        # Try using the actual cover path from the API response
                        # coverPath might be something like "/audiobooks/Terry Goodkind/.../cover.jpg"
                        thumb_url = f"/admin/api/v2/media/audiobookshelf/images/proxy?path={cover_path.lstrip('/')}"
                        processed_item['thumb'] = thumb_url
                        self.log_info(f"AudioBookshelf: Generated thumb URL from coverPath for '{title}': {thumb_url}")
                    elif item_id:
                        # Fallback: try the standard items endpoint
                        thumb_url = f"/admin/api/v2/media/audiobookshelf/images/proxy?path=items/{item_id}/cover"
                        processed_item['thumb'] = thumb_url
                        self.log_info(f"AudioBookshelf: Generated fallback thumb URL for '{title}': {thumb_url}")
                    
                    processed_items.append(processed_item)
                    
                except Exception as e:
                    self.log_error(f"Error processing AudioBookshelf item {item.get('id', 'unknown')}: {e}")
                    continue
            
            # Calculate pagination info (convert back to 1-indexed)
            current_page = abs_page + 1
            total_pages = (total + per_page - 1) // per_page if per_page > 0 else 1
            has_next = current_page < total_pages
            has_prev = current_page > 1
            
            return {
                'success': True,
                'items': processed_items,
                'pagination': {
                    'page': current_page,
                    'per_page': per_page,
                    'total_pages': total_pages,
                    'total_items': total,
                    'has_next': has_next,
                    'has_prev': has_prev
                }
            }
            
        except Exception as e:
            self.log_error(f"Error fetching library content for library {library_key}: {e}")
            return {
                'success': False,
                'error': str(e),
                'items': [],
                'pagination': {
                    'page': page,
                    'per_page': per_page,
                    'total_pages': 0,
                    'total_items': 0,
                    'has_next': False,
                    'has_prev': False
                }
            }

    def get_media_raw(self, media_id: str) -> Dict[str, Any]:
        """Get raw API data for a specific media item"""
        try:
            endpoint = f"items/{media_id}"
            self.log_info(f"AudioBookshelf: Fetching raw media data from {endpoint}")
            response = self._make_request(endpoint)
            return response
        except Exception as e:
            self.log_error(f"Error fetching raw media data for item {media_id}: {e}")
            return {}

    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get active AudioBookshelf listening sessions"""
        try:
            # Use the sessions API endpoint
            endpoint = "sessions/open"
            self.log_info(f"AudioBookshelf: Fetching active sessions from {endpoint}")
            response = self._make_request(endpoint)
            self._log_http_payload(response)
            
            # Extract sessions from the response
            sessions = response.get('sessions', []) if isinstance(response, dict) else []
            self.log_info(f"AudioBookshelf: Retrieved {len(sessions)} sessions from API")
            
            # Debug: Log the full response structure
            # self.log_info(f"AudioBookshelf: Full sessions API response: {response}")
            
            # Debug: Log details about each session
            active_sessions = []
            for i, session in enumerate(sessions):
                # self.log_info(f"AudioBookshelf: Session {i+1} debug info:")
                # self.log_info(f"  - ID: {session.get('id')}")
                # self.log_info(f"  - User: {session.get('user', {}).get('username')}")
                # self.log_info(f"  - Media: {session.get('mediaMetadata', {}).get('title')}")
                # self.log_info(f"  - Started: {session.get('startedAt')}")
                # self.log_info(f"  - Updated: {session.get('updatedAt')}")
                # self.log_info(f"  - Current Time: {session.get('currentTime')}")
                # self.log_info(f"  - Duration: {session.get('duration')}")
                # self.log_info(f"  - Device Info: {session.get('deviceInfo', {})}")
                
                # Check if session appears to be active
                current_time = session.get('currentTime', 0)
                duration = session.get('duration', 0)
                progress = (current_time / duration * 100) if duration > 0 else 0
                
                # Open sessions are already filtered to active playback by AudioBookshelf.
                # self.log_info(f"  - Progress: {progress:.1f}%")
                # self.log_info(f"  - Session is ACTIVE (updated recently)")
                
                # Add server context to each session
                session['server_name'] = self.name
                session['server_id'] = self.server_id
                session['service_type'] = self.service_type.value
                
                active_sessions.append(session)
            
            self.log_info(f"AudioBookshelf: Returning {len(active_sessions)} sessions to streaming page")
            return active_sessions
            
        except Exception as e:
            self.log_error(f"Error fetching active sessions: {e}")
            return []

    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        """Get active AudioBookshelf sessions formatted for display"""
        from app.models import User, UserType

        raw_sessions = self.get_active_sessions()
        if not raw_sessions:
            return []

        user_ids_in_session = {
            str(raw_session.get('userId') or (raw_session.get('user') or {}).get('id'))
            for raw_session in raw_sessions
            if raw_session.get('userId') or (raw_session.get('user') or {}).get('id')
        }
        mum_users_map_by_abs_id = {}
        if user_ids_in_session and self.server_id is not None:
            abs_accesses = User.query.filter_by(userType=UserType.SERVICE).filter(
                User.server_id == self.server_id,
                User.external_user_id.in_(list(user_ids_in_session))
            ).all()
            for access in abs_accesses:
                if access.external_user_id:
                    mum_users_map_by_abs_id[str(access.external_user_id)] = access

        formatted_sessions = []
        
        for raw_session in raw_sessions:
            try:
                # Extract basic session info
                session_id = raw_session.get('id', '')
                user_info = raw_session.get('user', {})
                user_name = user_info.get('username', 'Unknown User')
                abs_user_id = raw_session.get('userId') or user_info.get('id')
                abs_user_id_str = str(abs_user_id) if abs_user_id is not None else None
                mum_user = mum_users_map_by_abs_id.get(abs_user_id_str) if abs_user_id_str else None
                mum_user_id = mum_user.id if mum_user else None
                mum_user_uuid = mum_user.uuid if mum_user else None
                
                # Media metadata
                media_metadata = raw_session.get('mediaMetadata', {})
                media_title = media_metadata.get('title', 'Unknown Title')
                media_type = raw_session.get('mediaType', 'book').capitalize()
                
                # Extract author information
                display_author = raw_session.get('displayAuthor')
                if not display_author:
                    # Fallback to authors array if displayAuthor not available
                    authors = media_metadata.get('authors', [])
                    if authors and isinstance(authors, list) and len(authors) > 0:
                        first_author = authors[0]
                        if isinstance(first_author, dict):
                            display_author = first_author.get('name', 'Unknown Author')
                        else:
                            display_author = str(first_author)
                    else:
                        display_author = 'Unknown Author'
                
                # Device and player info
                device_info = raw_session.get('deviceInfo', {})
                player_platform = device_info.get('osName', 'Unknown OS')
                browser_name = device_info.get('browserName', 'Unknown Browser')
                player_title = f"{browser_name} on {player_platform}"
                
                # Progress and timing info
                current_time = raw_session.get('currentTime', 0)
                duration = raw_session.get('duration', 0)
                progress = (current_time / duration * 100) if duration > 0 else 0
                time_listening = raw_session.get('timeListening', 0)
                
                # Display title (episode or chapter info)
                display_title = raw_session.get('displayTitle', media_title)
                
                # Location info
                location_ip = device_info.get('ipAddress', 'N/A')
                
                # Clean up IPv6-mapped IPv4 addresses for display
                display_ip = location_ip
                if location_ip and location_ip.startswith('::ffff:'):
                    display_ip = location_ip[7:]  # Remove ::ffff: prefix for display
                
                # Determine if IP is LAN or WAN
                def is_lan_ip(ip_str):
                    """Check if IP address is in private/local range"""
                    if not ip_str or ip_str == 'N/A':
                        return False
                    
                    # Handle IPv6-mapped IPv4 addresses (::ffff:x.x.x.x)
                    if ip_str.startswith('::ffff:'):
                        ip_str = ip_str[7:]  # Remove ::ffff: prefix
                    
                    # Handle localhost
                    if ip_str in ['127.0.0.1', 'localhost', '::1']:
                        return True
                    
                    try:
                        import ipaddress
                        ip = ipaddress.ip_address(ip_str)
                        return ip.is_private or ip.is_loopback
                    except (ValueError, ipaddress.AddressValueError):
                        # If we can't parse it, assume WAN for safety
                        return False
                
                is_lan = is_lan_ip(location_ip)
                location_type = "LAN" if is_lan else "WAN"
                
                # Cover/thumbnail - use same working pattern as media library
                cover_path = raw_session.get('coverPath')
                library_item_id = raw_session.get('libraryItemId')
                self.log_info(f"AudioBookshelf session coverPath: {cover_path}, libraryItemId: {library_item_id}")
                thumb_url = None
                
                if library_item_id:
                    # Use the same working pattern as media library: items/{id}/cover
                    thumb_url = f"/admin/api/v2/media/audiobookshelf/images/proxy?path=items/{library_item_id}/cover"
                    self.log_info(f"AudioBookshelf session thumb_url (using items pattern): {thumb_url}")
                elif cover_path:
                    # Fallback to original coverPath if no libraryItemId
                    thumb_url = f"/admin/api/v2/media/audiobookshelf/images/proxy?path={cover_path.lstrip('/')}"
                    self.log_info(f"AudioBookshelf session thumb_url (using coverPath): {thumb_url}")
                # If neither available, leave thumb_url as None for HTML placeholder
                
                # Format timestamps
                started_at = raw_session.get('startedAt')
                updated_at = raw_session.get('updatedAt')
                
                # Convert AudioBookshelf timestamps to readable format
                import datetime
                started_at_readable = None
                if started_at:
                    try:
                        started_at_readable = datetime.datetime.fromtimestamp(started_at / 1000).strftime('%Y-%m-%d %H:%M:%S')
                    except:
                        started_at_readable = 'Unknown'
                
                # Format duration and current time
                def format_time(seconds):
                    if not seconds:
                        return "0:00"
                    hours = int(seconds // 3600)
                    minutes = int((seconds % 3600) // 60)
                    secs = int(seconds % 60)
                    if hours > 0:
                        return f"{hours}:{minutes:02d}:{secs:02d}"
                    else:
                        return f"{minutes}:{secs:02d}"
                
                current_time_formatted = format_time(current_time)
                duration_formatted = format_time(duration)
                time_listening_formatted = format_time(time_listening)
                
                # Session details for display
                session_details = {
                    'user': user_name,
                    'mum_user_id': mum_user_id,
                    'mum_user_uuid': mum_user_uuid,
                    'player_title': player_title,
                    'player_platform': player_platform,
                    'product': 'AudioBookshelf',
                    'media_title': display_title,
                    'grandparent_title': None,  # Not used for audiobooks
                    'parent_title': display_author,  # Author appears under the title
                    'media_type': media_type,
                    'library_name': raw_session.get('libraryName', 'Unknown Library'),
                    'year': None,  # AudioBookshelf doesn't provide year in session data
                    'state': 'Listening',  # AudioBookshelf sessions show as "Listening" instead of "Playing"
                    'progress': round(progress, 1),
                    'thumb_url': thumb_url,
                    'session_key': session_id,
                    'user_avatar_url': None,  # Not available in session data
                    'quality_detail': 'Original Audio',
                    'stream_detail': 'Direct Stream',
                    'container_detail': 'Audio File',
                    'video_detail': 'N/A (Audio Only)',
                    'audio_detail': 'Direct Stream (Original)',
                    'subtitle_detail': 'N/A',
                    'location_detail': f"{location_type}: {display_ip}",
                    'is_public_ip': not is_lan,
                    'location_ip': display_ip,
                    'bandwidth_detail': f'Streaming via {location_type}',
                    'bitrate_calc': 0,  # Not provided by AudioBookshelf
                    'location_type_calc': location_type,
                    'is_transcode_calc': False,  # AudioBookshelf streams original files
                    'raw_data_json': json.dumps(raw_session, indent=2),
                    'raw_data_json_lines': json.dumps(raw_session, indent=2).splitlines(),
                    'service_type': 'audiobookshelf',
                    'server_name': self.name,
                    # AudioBookshelf specific fields
                    'current_time': current_time_formatted,
                    'duration': duration_formatted,
                    'time_listening': time_listening_formatted,
                    'started_at': started_at_readable
                }
                
                formatted_sessions.append(session_details)
                
            except Exception as e:
                self.log_error(f"Error formatting AudioBookshelf session {raw_session.get('id', 'unknown')}: {e}")
                continue
        
        return formatted_sessions

    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        """Terminate an AudioBookshelf session (not supported by AudioBookshelf API)"""
        self.log_warning(f"AudioBookshelf does not support session termination via API")
        return False

    def check_username_exists(self, username: str) -> bool:
        """Check if a username already exists in AudiobookShelf"""
        try:
            users = self.get_users()
            for user in users:
                if user.get('username', '').lower() == username.lower():
                    return True
            return False
        except Exception as e:
            self.log_error(f"Error checking username '{username}': {e}")
            return False
