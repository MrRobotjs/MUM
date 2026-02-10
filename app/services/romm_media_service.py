"""
RomM Media Service Implementation
Provides integration with RomM (Rom Manager) servers for retro gaming content management.
"""

import requests
import json
import base64
from typing import List, Dict, Any, Optional, Tuple
from flask import current_app
from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType


class RommMediaService(BaseMediaService):
    """RomM media service implementation"""
    
    @property
    def service_type(self) -> ServiceType:
        return ServiceType.ROMM
    
    def __init__(self, server_config: Dict[str, Any]):
        super().__init__(server_config)
        self.session = requests.Session()
        self.session.timeout = 30
        # RomM uses username/password authentication
        self.localUsername = server_config.get('username')
        self.password = server_config.get('password')
        
    def _setup_auth_headers(self) -> bool:
        """Setup authentication headers for RomM API requests"""
        try:
            if not self.localUsername or not self.password:
                self.log_error("Username and password are required for RomM authentication")
                return False
            
            # RomM uses Basic auth with base64 encoded username:password
            auth_string = f"{self.localUsername}:{self.password}"
            encoded_auth = base64.b64encode(auth_string.encode()).decode()
            self.session.headers.update({
                'Authorization': f'Basic {encoded_auth}',
                'Accept': 'application/json'
            })
            self.log_info("Successfully setup RomM authentication headers")
            return True
                
        except Exception as e:
            self.log_error(f"Error setting up authentication: {e}")
            return False
    
    def _get_auth_header(self, username: str = None, password: str = None) -> str:
        """Get Basic auth header for operations"""
        user = username or self.localUsername
        pwd = password or self.password
        if not user or not pwd:
            return ""
        # RomM uses username:password format for authentication
        auth_string = f"{user}:{pwd}"
        encoded = base64.b64encode(auth_string.encode()).decode()
        return f"Basic {encoded}"
    
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection to RomM server"""
        try:
            # Setup authentication headers
            if not self._setup_auth_headers():
                return False, "Authentication failed. Check API key."
            
            # Get server version from heartbeat endpoint
            version = 'Unknown'
            try:
                response = self.session.get(f"{self.url.rstrip('/')}/api/heartbeat")
                response.raise_for_status()
                heartbeat_data = response.json()
                
                # Extract version from SYSTEM.VERSION
                system_info = heartbeat_data.get('SYSTEM', {})
                version = system_info.get('VERSION', 'Unknown')
            except Exception as e:
                self.log_info(f"Could not get version from heartbeat: {e}")
            
            # Test authenticated request - use platforms endpoint as it's more reliable
            response = self.session.get(f"{self.url.rstrip('/')}/api/platforms")
            response.raise_for_status()
            
            platforms = response.json()
            platform_count = len(platforms) if isinstance(platforms, list) else 0
            
            if version != 'Unknown':
                return True, f"Successfully connected to RomM server (v{version}). Found {platform_count} platforms."
            else:
                return True, f"Successfully connected to RomM server. Found {platform_count} platforms."
            
        except requests.exceptions.ConnectTimeout:
            return False, "Connection to RomM timed out. Check if the server is running and accessible."
        except requests.exceptions.ConnectionError:
            return False, "Could not connect to RomM. Check the URL and network connectivity."
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 401:
                return False, "Authentication failed. Check API key."
            elif e.response.status_code == 403:
                return False, "Access denied. API key may not have sufficient permissions."
            else:
                return False, f"RomM returned an error: {e.response.status_code} - {e.response.reason}"
        except requests.exceptions.Timeout:
            return False, "Request to RomM timed out. The server may be slow to respond."
        except Exception as e:
            return False, f"Unexpected error connecting to RomM: {str(e)}"
    
    def get_libraries_raw(self) -> List[Dict[str, Any]]:
        """Get raw, unmodified platform data from RomM API"""
        try:
            if not self._setup_auth_headers():
                self.log_error("Failed to setup authentication for raw library retrieval")
                return []
            
            response = self.session.get(f"{self.url.rstrip('/')}/api/platforms")
            response.raise_for_status()
            
            # Return the raw API response without any modifications
            platforms = response.json()
            self.log_info(f"Retrieved {len(platforms)} raw platforms from RomM")
            return platforms
            
        except Exception as e:
            self.log_error(f"Error retrieving raw platforms: {e}")
            return []
    
    def get_libraries(self) -> List[Dict[str, Any]]:
        """Get all platforms (libraries) from RomM (processed for internal use)"""
        try:
            # Get raw data first
            platforms = self.get_libraries_raw()
            libraries = []
            
            # Process the raw data for internal use
            for platform in platforms:
                libraries.append({
                    'id': str(platform.get('id', '')),
                    'name': platform.get('display_name', 'Unknown Platform'),  # RomM uses 'display_name' field
                    'type': 'rom',  # RomM is specifically for ROMs
                    'slug': platform.get('slug', ''),
                    'rom_count': platform.get('rom_count', 0),
                    'item_count': platform.get('rom_count', 0),  # Use rom_count as item_count for consistency
                    'external_id': str(platform.get('id', ''))  # Add external_id for compatibility
                })
            
            self.log_info(f"Processed {len(libraries)} platforms from RomM")
            return libraries
            
        except Exception as e:
            self.log_error(f"Error retrieving platforms: {e}")
            return []
    
    def scan_libraries(self, url: str = None, username: str = None, password: str = None) -> Dict[str, str]:
        """Scan available platforms on this RomM server.
        
        Args:
            url: Optional server URL override
            username: Optional username override
            password: Optional password override
            
        Returns:
            dict: Platform name -> platform ID mapping
        """
        try:
            if url and username and password:
                # Use provided credentials for scanning
                auth_header = self._get_auth_header(username, password)
                headers = {"Authorization": auth_header, "Accept": "application/json"}
                response = requests.get(
                    f"{url.rstrip('/')}/api/platforms", 
                    headers=headers, 
                    timeout=10
                )
                response.raise_for_status()
                data = response.json()
            else:
                # Use saved credentials
                if not self._setup_auth_headers():
                    self.log_error("Failed to setup authentication for library scan")
                    return {}
                response = self.session.get(f"{self.url.rstrip('/')}/api/platforms")
                response.raise_for_status()
                data = response.json()
            
            return {p.get("name", p["id"]): p["id"] for p in data}
        except Exception as e:
            self.log_error(f"RomM: failed to scan platforms – {e}")
            return {}
    
    def get_users(self) -> List[Dict[str, Any]]:
        """Get all users from RomM"""
        try:
            if not self._setup_auth_headers():
                self.log_error("Failed to setup authentication for user retrieval")
                return []
            
            response = self.session.get(f"{self.url.rstrip('/')}/api/users")
            response.raise_for_status()
            
            users_data = response.json()
            users = []
            
            for user in users_data:
                users.append({
                    'id': str(user.get('id', '')),
                    'username': user.get('username', ''),
                    'email': user.get('email', ''),
                    'enabled': user.get('enabled', True),
                    'role': user.get('role', 'viewer'),
                    'created_at': user.get('created_at', ''),
                    'last_active_at': user.get('last_active_at', ''),
                    'raw_data': user  # Store complete raw user data for debugging
                })
            
            self.log_info(f"Retrieved {len(users)} users from RomM")
            return users
            
        except Exception as e:
            self.log_error(f"Error retrieving users: {e}")
            return []
    
    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        """Create a new user in RomM"""
        try:
            if not self._setup_auth_headers():
                self.log_error("Failed to setup authentication for user creation")
                return {}
            
            user_data = {
                'username': username,
                'password': password or 'defaultpassword123',  # RomM requires a password
                'role': kwargs.get('role', 'viewer'),
                'enabled': kwargs.get('enabled', True)
            }
            
            if email:
                user_data['email'] = email
            
            response = self.session.post(
                f"{self.url.rstrip('/')}/api/users",
                json=user_data
            )
            response.raise_for_status()
            
            created_user = response.json()
            self.log_info(f"Created user '{username}' in RomM")
            user_id = str(created_user.get('id', ''))
            
            return {
                'id': user_id,
                'user_id': user_id,
                'username': created_user.get('username', ''),
                'email': created_user.get('email', ''),
                'role': created_user.get('role', ''),
                'enabled': created_user.get('enabled', True)
            }
            
        except Exception as e:
            self.log_error(f"Error creating user '{username}': {e}")
            return {}
    
    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        """Update user's platform access in RomM"""
        try:
            if not self._setup_auth_headers():
                self.log_error("Failed to setup authentication for user access update")
                return False
            
            # RomM doesn't have granular library access control like other services
            # Users typically have access to all platforms based on their role
            # This method could be used to update user role or other permissions
            
            user_data = {}
            if 'role' in kwargs:
                user_data['role'] = kwargs['role']
            if 'enabled' in kwargs:
                user_data['enabled'] = kwargs['enabled']
            
            if user_data:
                response = self.session.patch(
                    f"{self.url.rstrip('/')}/api/users/{user_id}",
                    json=user_data
                )
                response.raise_for_status()
                
                self.log_info(f"Updated user {user_id} access in RomM")
                return True
            
            return True  # No changes needed
            
        except Exception as e:
            self.log_error(f"Error updating user access for {user_id}: {e}")
            return False
    
    def delete_user(self, user_id: str) -> bool:
        """Delete/remove user from RomM"""
        current_app.logger.error(f"RomM delete_user method called with user_id: {user_id}")
        print(f"RomM delete_user method called with user_id: {user_id}")  # Force console output
        try:
            if not self._setup_auth_headers():
                self.log_error("Failed to setup authentication for user deletion")
                return False
            
            delete_url = f"{self.url.rstrip('/')}/api/users/{user_id}"
            self.log_info(f"RomM: Attempting to delete user {user_id} using URL: {delete_url}")
            self.log_info(f"RomM: Using authentication headers: {dict(self.session.headers)}")
            
            response = self.session.delete(delete_url)
            
            self.log_info(f"RomM: Delete response status: {response.status_code}")
            self.log_info(f"RomM: Delete response headers: {dict(response.headers)}")
            self.log_info(f"RomM: Delete response body: {response.text}")
            
            if response.status_code == 404:
                self.log_error(f"RomM: User {user_id} not found (404). User may not exist or ID format is incorrect.")
                return False
            elif response.status_code == 403:
                self.log_error(f"RomM: Access denied (403). Check if the authenticated user has permission to delete users.")
                return False
            elif response.status_code == 401:
                self.log_error(f"RomM: Authentication failed (401). Check credentials.")
                return False
            
            response.raise_for_status()
            
            self.log_info(f"RomM: Successfully deleted user {user_id}")
            return True
            
        except requests.exceptions.HTTPError as e:
            self.log_error(f"RomM: HTTP error deleting user {user_id}: {e.response.status_code} - {e.response.text}")
            return False
        except Exception as e:
            self.log_error(f"RomM: Unexpected error deleting user {user_id}: {e}")
            return False
    
    def check_username_exists(self, username: str) -> bool:
        """Check if a username already exists in Romm"""
        try:
            users = self.get_users()
            for user in users:
                if user.get('username', '').lower() == username.lower():
                    return True
            return False
        except Exception as e:
            self.log_error(f"Error checking username '{username}': {e}")
            return False
    
    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get active RomM sessions - not supported."""
        return []
    
    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        """Terminate an active gaming session"""
        try:
            # RomM doesn't support terminating sessions remotely
            # This is a limitation of the platform
            self.log_warning(f"Session termination not supported by RomM for session {session_id}")
            return False
            
        except Exception as e:
            self.log_error(f"Error terminating session {session_id}: {e}")
            return False
    
    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        """Get active RomM sessions formatted for display - not supported."""
        return []
    
    def get_server_info(self) -> Dict[str, Any]:
        """Get RomM server information"""
        try:
            if not self._setup_auth_headers():
                return {
                    'name': self.name,
                    'url': self.url,
                    'service_type': 'romm',
                    'online': False,
                    'version': 'Unknown'
                }
            
            response = self.session.get(f"{self.url.rstrip('/')}/api/heartbeat")
            response.raise_for_status()
            
            heartbeat_data = response.json()
            
            # Extract version from SYSTEM.VERSION
            system_info = heartbeat_data.get('SYSTEM', {})
            version = system_info.get('VERSION', 'Unknown')
            
            return {
                'name': self.name,
                'url': self.url,
                'service_type': 'romm',
                'online': True,
                'version': version,
                'platforms_count': heartbeat_data.get('platforms_count', 0),
                'roms_count': heartbeat_data.get('roms_count', 0),
                'users_count': heartbeat_data.get('users_count', 0)
            }
            
        except Exception as e:
            self.log_error(f"Error getting server info: {e}")
            return {
                'name': self.name,
                'url': self.url,
                'service_type': 'romm',
                'online': False,
                'version': 'Unknown'
            }
    
    def supports_feature(self, feature: str) -> bool:
        """Check if RomM supports a specific feature"""
        romm_features = [
            'user_management',
            'library_access',
            'downloads',  # ROMs can be downloaded
            'active_sessions'  # Can view recent activity
        ]
        
        # Features RomM doesn't support
        unsupported_features = [
            'transcoding',  # Not applicable for ROMs
            'sharing',  # No sharing mechanism
            'session_termination'  # Can't terminate remote sessions
        ]
        
        if feature in unsupported_features:
            return False
        
        return feature in romm_features
    
    def get_library_content(self, library_key: str, page: int = 1, per_page: int = 50) -> Dict[str, Any]:
        """Get ROMs for a specific platform (library)"""
        try:
            if not self._setup_auth_headers():
                self.log_error("Failed to setup authentication for library content retrieval")
                return {'success': False, 'error': 'Authentication failed'}
            
            # Calculate offset for pagination
            offset = (page - 1) * per_page
            
            # Build the API URL with the exact parameters you specified
            url = f"{self.url.rstrip('/')}/api/roms"
            params = {
                'with_char_index': 'true',
                'platform_id': library_key,  # This is the external_id (platform ID)
                'group_by_meta_id': 'false',
                'order_by': 'name',
                'order_dir': 'asc',
                'limit': per_page,
                'offset': offset
            }
            
            self.log_info(f"Fetching ROMs for platform {library_key}, page {page}")
            response = self.session.get(url, params=params)
            response.raise_for_status()
            
            data = response.json()
            
            # Extract ROMs from response - RomM uses 'items' array
            roms = data.get('items', []) if isinstance(data, dict) else data
            total_count = data.get('total_count', len(roms)) if isinstance(data, dict) else len(roms)
            
            # Process ROMs into the expected format
            items = []
            for rom in roms:
                # Extract year from metadatum if available
                year = None
                if rom.get('metadatum') and rom.get('metadatum', {}).get('first_release_date'):
                    try:
                        # Parse year from first_release_date
                        release_date = rom['metadatum']['first_release_date']
                        if isinstance(release_date, str) and len(release_date) >= 4:
                            year = int(release_date[:4])
                    except (ValueError, TypeError):
                        year = None
                
                # Construct thumbnail URL using image proxy to handle HTTPS/HTTP mixed content
                thumb_url = None
                if rom.get('path_cover_large'):
                    # Use the image proxy to handle mixed content issues (HTTPS page loading HTTP images)
                    thumb_url = f"/api/v2/media/romm/images/proxy?path={rom['path_cover_large']}&server_id={self.server_id}"
                    self.log_info(f"Generated proxy cover URL for ROM '{rom.get('name')}': {thumb_url}")
                
                items.append({
                    'id': str(rom.get('id', '')),
                    'external_id': str(rom.get('id', '')),
                    'title': rom.get('name', 'Unknown ROM'),
                    'year': year,
                    'summary': rom.get('summary', ''),
                    'type': 'rom',
                    'file_size': rom.get('fs_size_bytes', 0),  # RomM uses 'fs_size_bytes'
                    'file_path': rom.get('fs_path', ''),  # RomM uses 'fs_path'
                    'file_name': rom.get('fs_name', ''),  # Add file name
                    'platform': rom.get('platform_display_name', ''),  # RomM uses 'platform_display_name'
                    'genres': rom.get('metadatum', {}).get('genres', []) if rom.get('metadatum') else [],
                    'thumb': thumb_url,  # Construct full URL for cover image
                    'added_at': rom.get('created_at', ''),
                    'raw_data': rom  # Store full ROM data
                })
            
            # Calculate pagination info
            total_pages = (total_count + per_page - 1) // per_page
            has_next = page < total_pages
            has_prev = page > 1
            
            self.log_info(f"Retrieved {len(items)} ROMs for platform {library_key} (page {page}/{total_pages})")
            
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
            self.log_error(f"Error getting library content for platform {library_key}: {e}")
            return {'success': False, 'error': str(e)}

    def get_geoip_info(self, ip_address: str) -> Dict[str, Any]:
        """Get GeoIP information for a given IP address"""
        # Use the base class implementation
        return super().get_geoip_info(ip_address)
