# File: app/services/komga_media_service.py
from typing import List, Dict, Any, Optional, Tuple
import requests
import base64
from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType
from app.utils.timeout_helper import get_api_timeout

class KomgaMediaService(BaseMediaService):
    """Komga implementation of BaseMediaService"""
    
    @property
    def service_type(self) -> ServiceType:
        return ServiceType.KOMGA
    
    def _get_headers(self):
        """Get headers for Komga API requests"""
        if self.api_key:
            # Komga uses X-API-Key header for API key authentication
            return {
                'X-API-Key': self.api_key,
                'Content-Type': 'application/json'
            }
        elif self.localUsername and self.password:
            # Komga also supports basic auth as fallback
            credentials = base64.b64encode(f"{self.localUsername}:{self.password}".encode()).decode()
            return {
                'Authorization': f'Basic {credentials}',
                'Content-Type': 'application/json'
            }
        else:
            return {'Content-Type': 'application/json'}
    
    def _make_request(self, endpoint: str, method: str = 'GET', data: Dict = None):
        """Make API request to Komga server"""
        # Use v2 API for user-related endpoints, v1 for everything else
        if endpoint.startswith('users'):
            api_version = 'v2'
        else:
            api_version = 'v1'
        
        url = f"{self.url.rstrip('/')}/api/{api_version}/{endpoint.lstrip('/')}"
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
        """Test connection to Komga server"""
        try:
            # Get server version from actuator info endpoint
            version = 'Unknown'
            try:
                # Komga actuator endpoint doesn't use the API versioning
                url = f"{self.url.rstrip('/')}/actuator/info"
                headers = self._get_headers()
                timeout = get_api_timeout()
                response = requests.get(url, headers=headers, timeout=timeout)
                response.raise_for_status()
                info_data = response.json()
                
                # Extract version from build info
                build_info = info_data.get('build', {})
                version = build_info.get('version', 'Unknown')
            except Exception as e:
                self.log_info(f"Could not get version from actuator/info: {e}")
            
            # Test basic connectivity
            self._make_request('users')
            
            if version != 'Unknown':
                return True, f"Connected to Komga (v{version}) successfully"
            else:
                return True, "Connected to Komga successfully"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"
    
    def get_libraries_raw(self) -> List[Dict[str, Any]]:
        """Get raw, unmodified library data from Komga API"""
        try:
            # Return the raw API response without any modifications
            libraries = self._make_request('libraries')
            self.log_info(f"Retrieved raw libraries from Komga")
            return libraries
        except Exception as e:
            self.log_error(f"Error fetching raw libraries: {e}")
            return []
    
    def get_libraries(self) -> List[Dict[str, Any]]:
        """Get all Komga libraries (processed for internal use)"""
        try:
            # Get raw data first
            libraries_response = self.get_libraries_raw()
            result = []
            
            # Komga API returns a list directly, not wrapped in a 'content' object
            libraries_list = libraries_response if isinstance(libraries_response, list) else libraries_response.get('content', [])
            
            # Process the raw data for internal use
            for lib in libraries_list:
                result.append({
                    'id': lib.get('id', ''),
                    'name': lib.get('name', 'Unknown'),
                    'type': 'comic',  # Komga is primarily for comics/manga
                    'item_count': lib.get('seriesCount', 0),
                    'external_id': lib.get('id', '')
                })
            
            self.log_info(f"Processed {len(result)} libraries from Komga")
            return result
        except Exception as e:
            self.log_error(f"Error fetching libraries: {e}")
            return []
    
    def get_users(self) -> List[Dict[str, Any]]:
        """Get all Komga users"""
        try:
            users = self._make_request('users')
            result = []
            all_library_ids: Optional[List[str]] = None
            
            # Komga API returns a list directly, not wrapped in a 'content' object
            users_list = users if isinstance(users, list) else users.get('content', [])
            
            for user in users_list:
                user_id = user.get('id')
                if not user_id:
                    continue
                
                # Komga v2 includes sharing context directly on UserDto.
                shared_all_libraries = bool(user.get('sharedAllLibraries', False))
                library_ids = [
                    str(lib_id) for lib_id in (user.get('sharedLibrariesIds') or []) if lib_id
                ]

                # If a user has "all libraries" enabled but explicit IDs are empty,
                # resolve to current library IDs for sync consistency in MUM.
                if shared_all_libraries and not library_ids:
                    if all_library_ids is None:
                        libraries = self._make_request('libraries')
                        libraries_list = (
                            libraries if isinstance(libraries, list) else libraries.get('content', [])
                        )
                        all_library_ids = [
                            str(lib.get('id')) for lib in libraries_list if lib.get('id')
                        ]
                    library_ids = list(all_library_ids)
                
                result.append({
                    'id': user_id,
                    'uuid': user_id,
                    'username': user.get('email', 'Unknown'),  # Komga uses email as username
                    'email': user.get('email'),
                    'thumb': None,  # Komga doesn't provide avatars
                    'is_home_user': False,
                    'library_ids': library_ids,
                    'is_admin': 'ADMIN' in user.get('roles', []),
                    'raw_data': user,
                })
            
            return result
        except Exception as e:
            self.log_error(f"Error fetching users: {e}")
            return []
    
    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        """Create new Komga user"""
        try:
            user_data = {
                'email': email or username,
                'password': password or 'changeme123',
                'roles': ['USER']
            }
            
            library_ids = kwargs.get('library_ids', [])
            if library_ids:
                user_data['sharedLibraries'] = {
                    'all': False,
                    'libraryIds': [str(lib_id) for lib_id in library_ids if lib_id],
                }

            result = self._make_request('users', method='POST', data=user_data)
            user_id = result.get('id')
            
            return {
                'success': True,
                'user_id': user_id,
                'username': username,
                'email': email
            }
        except Exception as e:
            self.log_error(f"Error creating user: {e}")
            raise
    
    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        """Update Komga user's library access"""
        try:
            if library_ids is not None:
                # Komga v2 updates shared libraries via PATCH /api/v2/users/{id}
                payload = {
                    'sharedLibraries': {
                        'all': False,
                        'libraryIds': [str(lib_id) for lib_id in library_ids if lib_id],
                    }
                }
                self._make_request(f'users/{user_id}', method='PATCH', data=payload)
            
            return True
        except Exception as e:
            self.log_error(f"Error updating user access: {e}")
            return False
    
    def delete_user(self, user_id: str) -> bool:
        """Delete Komga user"""
        try:
            self._make_request(f'users/{user_id}', method='DELETE')
            return True
        except Exception as e:
            self.log_error(f"Error deleting user: {e}")
            return False
    
    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get active Komga sessions - Komga doesn't have real-time sessions"""
        # Komga doesn't have active session tracking like media servers
        # We could potentially get recent reading progress instead
        return []
    
    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        """Terminate session - Not applicable for Komga"""
        return False
    
    def get_server_info(self) -> Dict[str, Any]:
        """Get Komga server information"""
        try:
            # Get server version from actuator info endpoint
            version = 'Unknown'
            online = True
            
            try:
                # Komga actuator endpoint doesn't use the API versioning
                url = f"{self.url.rstrip('/')}/actuator/info"
                headers = self._get_headers()
                timeout = get_api_timeout()
                response = requests.get(url, headers=headers, timeout=timeout)
                response.raise_for_status()
                info_data = response.json()
                
                # Extract version from build info
                build_info = info_data.get('build', {})
                version = build_info.get('version', 'Unknown')
            except Exception as e:
                self.log_info(f"Could not get version from actuator/info in get_server_info: {e}")
                # Test basic connectivity if version fetch fails
                try:
                    self._make_request('users')
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

    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        """Get active Komga sessions formatted for display"""
        # Komga doesn't have real-time sessions like media servers
        return []

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
    
    def check_username_exists(self, username: str) -> bool:
        """Check if a username already exists in Komga"""
        try:
            users = self.get_users()
            for user in users:
                if user.get('email', '').lower() == username.lower():
                    return True
            return False
        except Exception as e:
            self.log_error(f"Error checking username '{username}': {e}")
            return False

    def get_library_content(self, library_key: str, page: int = 1, per_page: int = 50) -> Dict[str, Any]:
        """Get series/books for a specific library"""
        try:
            # Calculate offset for pagination
            offset = (page - 1) * per_page
            
            # Build the API URL for getting series in a library
            url = f"{self.url.rstrip('/')}/api/v1/series"
            params = {
                'library_id': library_key,  # This is the external_id (library ID)
                'page': page - 1,  # Komga uses 0-based pagination
                'size': per_page,
                'sort': 'metadata.titleSort,asc'
            }
            
            self.log_info(f"Fetching series for library {library_key}, page {page}")
            response = self._make_request(f'series?library_id={library_key}&page={page-1}&size={per_page}&sort=metadata.titleSort,asc')
            
            # Extract series from response
            series_list = response if isinstance(response, list) else response.get('content', [])
            total_count = response.get('totalElements', len(series_list)) if isinstance(response, dict) else len(series_list)
            
            # Process series into the expected format
            items = []
            for series in series_list:
                # Extract metadata
                metadata = series.get('metadata', {})
                
                # Construct thumbnail URL using image proxy
                thumb_url = None
                series_id = series.get('id')
                if series_id:
                    # Use the image proxy to handle authentication
                    thumb_url = f"/api/v2/media/komga/images/proxy?series_id={series_id}&server_id={self.server_id}"
                
                items.append({
                    'id': str(series.get('id', '')),
                    'external_id': str(series.get('id', '')),
                    'title': metadata.get('title', series.get('name', 'Unknown Series')),
                    'year': metadata.get('releaseYear'),
                    'summary': metadata.get('summary', ''),
                    'type': 'series',  # Komga content is series/books
                    'book_count': series.get('booksCount', 0),
                    'books_ready_count': series.get('booksReadyCount', 0),
                    'books_in_progress_count': series.get('booksInProgressCount', 0),
                    'books_unread_count': series.get('booksUnreadCount', 0),
                    'publisher': metadata.get('publisher', ''),
                    'status': metadata.get('status', ''),
                    'thumb': thumb_url,  # Use proxy URL for series thumbnail
                    'added_at': series.get('createdDate', ''),
                    'updated_at': series.get('lastModifiedDate', ''),
                    'raw_data': series  # Store full series data
                })
            
            # Calculate pagination info
            total_pages = (total_count + per_page - 1) // per_page
            has_next = page < total_pages
            has_prev = page > 1
            
            self.log_info(f"Retrieved {len(items)} series for library {library_key} (page {page}/{total_pages})")
            
            return {
                'success': True,
                'items': items,
                'pagination': {
                    'page': page,
                    'per_page': per_page,
                    'total': total_count,
                    'total_pages': total_pages,
                    'has_next': has_next,
                    'has_prev': has_prev
                }
            }
            
        except Exception as e:
            self.log_error(f"Error getting library content for library {library_key}: {e}")
            return {'success': False, 'error': str(e)}

    def get_series_books(self, series_id: str, page: int = 1, per_page: int = 50, sort_by: str = 'number_asc') -> Dict[str, Any]:
        """Get books/issues for a specific series"""
        try:
            # Calculate offset for pagination
            offset = (page - 1) * per_page
            
            # Map sort_by to Komga API sort parameters
            sort_mapping = {
                'number_asc': 'metadata.numberSort,asc',
                'number_desc': 'metadata.numberSort,desc',
                'title_asc': 'metadata.titleSort,asc',
                'title_desc': 'metadata.titleSort,desc',
                'date_asc': 'metadata.releaseDate,asc',
                'date_desc': 'metadata.releaseDate,desc'
            }
            
            komga_sort = sort_mapping.get(sort_by, 'metadata.numberSort,asc')
            
            # Build the API URL for getting books in a series
            self.log_info(f"Fetching books for series {series_id}, page {page}, sort: {sort_by} ({komga_sort})")
            response = self._make_request(f'series/{series_id}/books?page={page-1}&size={per_page}&sort={komga_sort}')
            
            # Extract books from response
            books_list = response if isinstance(response, list) else response.get('content', [])
            total_count = response.get('totalElements', len(books_list)) if isinstance(response, dict) else len(books_list)
            
            # Process books into the expected format
            items = []
            for book in books_list:
                # Extract metadata
                metadata = book.get('metadata', {})
                
                # Construct thumbnail URL using image proxy for book covers
                thumb_url = None
                book_id = book.get('id')
                if book_id:
                    # Use the image proxy to handle authentication for book thumbnails
                    thumb_url = f"/api/v2/media/komga/images/proxy?book_id={book_id}&server_id={self.server_id}"
                
                items.append({
                    'id': str(book.get('id', '')),
                    'external_id': str(book.get('id', '')),
                    'title': metadata.get('title', book.get('name', 'Unknown Issue')),
                    'number': metadata.get('number'),
                    'summary': metadata.get('summary', ''),
                    'type': 'book',  # Komga books are individual issues
                    'pages_count': book.get('pagesCount', 0),
                    'file_size': book.get('sizeBytes', 0),
                    'media_status': book.get('media', {}).get('status', ''),
                    'release_date': metadata.get('releaseDate'),
                    'isbn': metadata.get('isbn'),
                    'thumb': thumb_url,  # Use proxy URL for book thumbnail
                    'created_date': book.get('createdDate', ''),
                    'last_modified_date': book.get('lastModifiedDate', ''),
                    'file_hash': book.get('fileHash', ''),
                    'raw_data': book  # Store full book data
                })
            
            # Calculate pagination info
            total_pages = (total_count + per_page - 1) // per_page
            has_next = page < total_pages
            has_prev = page > 1
            
            self.log_info(f"Retrieved {len(items)} books for series {series_id} (page {page}/{total_pages})")
            
            return {
                'success': True,
                'items': items,
                'pagination': {
                    'page': page,
                    'per_page': per_page,
                    'total': total_count,
                    'total_pages': total_pages,
                    'has_next': has_next,
                    'has_prev': has_prev
                }
            }
            
        except Exception as e:
            self.log_error(f"Error getting books for series {series_id}: {e}")
            return {'success': False, 'error': str(e)}
