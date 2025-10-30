# Plugin Template for MUM (Multimedia User Management)
# This is a template for creating custom media service plugins

from typing import List, Dict, Any, Optional, Tuple
import requests
from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType
from app.utils.timeout_helper import get_api_timeout

class MyServiceMediaService(BaseMediaService):
    """
    Custom media service implementation for [Your Service Name]
    
    Replace 'MyService' with your actual service name and implement all methods below.
    """
    
    @property
    def service_type(self) -> ServiceType:
        # You'll need to add your service type to the ServiceType enum
        # or use a string identifier for custom plugins
        return "my_service"  # Use string for custom plugins
    
    def _get_headers(self):
        """Get headers for API requests"""
        headers = {'Content-Type': 'application/json'}
        
        if self.api_key:
            # Most services use Bearer token or API key in headers
            headers['Authorization'] = f'Bearer {self.api_key}'
            # Or: headers['X-API-Key'] = self.api_key
        elif self.localUsername and self.password:
            # Some services use basic auth
            import base64
            credentials = base64.b64encode(f"{self.localUsername}:{self.password}".encode()).decode()
            headers['Authorization'] = f'Basic {credentials}'
        
        return headers
    
    def _make_request(self, endpoint: str, method: str = 'GET', data: Dict = None):
        """Make API request to your service"""
        url = f"{self.url.rstrip('/')}/api/{endpoint.lstrip('/')}"
        headers = self._get_headers()
        
        try:
            timeout = get_api_timeout()
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=timeout)
            elif method == 'POST':
                response = requests.post(url, headers=headers, json=data, timeout=timeout)
            elif method == 'PUT':
                response = requests.put(url, headers=headers, json=data, timeout=timeout)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers, timeout=timeout)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            response.raise_for_status()
            return response.json() if response.content else {}
        except requests.exceptions.RequestException as e:
            self.log_error(f"API request failed: {e}")
            raise
    
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection to your service"""
        try:
            # Make a simple API call to test connectivity
            # This could be a status endpoint, version check, etc.
            info = self._make_request('status')  # Adjust endpoint as needed
            
            # Extract relevant info from response
            server_name = info.get('name', 'My Service')
            version = info.get('version', 'Unknown')
            
            return True, f"Connected to {server_name} (v{version})"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"
    
    def get_libraries(self) -> List[Dict[str, Any]]:
        """Get all libraries from your service"""
        try:
            # Adjust endpoint and response parsing for your service
            libraries = self._make_request('libraries')
            result = []
            
            # Parse the response - adjust field names as needed
            for lib in libraries:
                result.append({
                    'id': str(lib.get('id', '')),
                    'name': lib.get('name', 'Unknown'),
                    'type': lib.get('type', 'mixed').lower(),
                    'item_count': lib.get('itemCount', 0),
                    'external_id': str(lib.get('id', ''))
                })
            
            return result
        except Exception as e:
            self.log_error(f"Error fetching libraries: {e}")
            return []
    
    def get_users(self) -> List[Dict[str, Any]]:
        """Get all users from your service"""
        try:
            # Adjust endpoint and response parsing for your service
            users = self._make_request('users')
            result = []
            
            for user in users:
                user_id = user.get('id')
                if not user_id:
                    continue
                
                # Get user's library access if your service supports it
                try:
                    user_libs = self._make_request(f'users/{user_id}/libraries')
                    library_ids = [str(lib.get('id')) for lib in user_libs]
                except:
                    library_ids = []
                
                result.append({
                    'id': str(user_id),
                    'uuid': str(user_id),  # Use ID as UUID if no separate UUID
                    'username': user.get('username', 'Unknown'),
                    'email': user.get('email'),
                    'thumb': user.get('avatar'),  # Avatar/profile picture URL
                    'is_home_user': False,  # Adjust based on your service
                    'library_ids': library_ids,
                    'is_admin': user.get('isAdmin', False)
                })
            
            return result
        except Exception as e:
            self.log_error(f"Error fetching users: {e}")
            return []
    
    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        """Create new user in your service"""
        try:
            user_data = {
                'username': username,
                'email': email or '',
                'password': password or 'changeme123'
            }
            
            # Add any service-specific fields
            # user_data['role'] = 'user'
            
            result = self._make_request('users', method='POST', data=user_data)
            user_id = result.get('id')
            
            # Set library access if specified
            library_ids = kwargs.get('library_ids', [])
            if library_ids and user_id:
                # Implement library access assignment for your service
                for lib_id in library_ids:
                    self._make_request(f'users/{user_id}/libraries/{lib_id}', method='POST')
            
            return {
                'success': True,
                'user_id': str(user_id),
                'username': username,
                'email': email
            }
        except Exception as e:
            self.log_error(f"Error creating user: {e}")
            raise
    
    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        """Update user's library access"""
        try:
            if library_ids is not None:
                # Implementation depends on your service's API
                # This is a common pattern - adjust as needed
                
                # Option 1: Replace all access
                update_data = {'libraryIds': library_ids}
                self._make_request(f'users/{user_id}/libraries', method='PUT', data=update_data)
                
                # Option 2: Individual library management
                # current_libs = self._make_request(f'users/{user_id}/libraries')
                # current_lib_ids = [str(lib.get('id')) for lib in current_libs]
                # 
                # # Remove libraries not in new list
                # for lib_id in current_lib_ids:
                #     if lib_id not in library_ids:
                #         self._make_request(f'users/{user_id}/libraries/{lib_id}', method='DELETE')
                # 
                # # Add new libraries
                # for lib_id in library_ids:
                #     if lib_id not in current_lib_ids:
                #         self._make_request(f'users/{user_id}/libraries/{lib_id}', method='POST')
            
            return True
        except Exception as e:
            self.log_error(f"Error updating user access: {e}")
            return False
    
    def delete_user(self, user_id: str) -> bool:
        """Delete user from your service"""
        try:
            self._make_request(f'users/{user_id}', method='DELETE')
            return True
        except Exception as e:
            self.log_error(f"Error deleting user: {e}")
            return False
    
    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get active streaming sessions"""
        try:
            # Not all services support real-time session monitoring
            # Return empty list if your service doesn't support this
            sessions = self._make_request('sessions')
            result = []
            
            for session in sessions:
                # Skip inactive sessions
                if not session.get('isActive', True):
                    continue
                
                result.append({
                    'session_id': str(session.get('id', '')),
                    'user_id': str(session.get('userId', '')),
                    'username': session.get('username', 'Unknown'),
                    'media_title': session.get('mediaTitle', 'Unknown'),
                    'media_type': session.get('mediaType', 'unknown'),
                    'player': session.get('playerName', 'Unknown'),
                    'platform': session.get('platform', ''),
                    'state': session.get('state', 'unknown'),  # 'playing', 'paused', etc.
                    'progress_percent': session.get('progressPercent', 0),
                    'ip_address': session.get('ipAddress', ''),
                    'is_lan': session.get('isLocal', False)
                })
            
            return result
        except Exception as e:
            self.log_error(f"Error fetching active sessions: {e}")
            return []
    
    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        """Terminate an active session"""
        try:
            # Not all services support session termination
            data = {'reason': reason or 'Terminated by administrator'}
            self._make_request(f'sessions/{session_id}/stop', method='POST', data=data)
            return True
        except Exception as e:
            self.log_error(f"Error terminating session: {e}")
            return False
    
    def get_server_info(self) -> Dict[str, Any]:
        """Get server information"""
        try:
            info = self._make_request('status')
            return {
                'name': info.get('name', self.name),
                'url': self.url,
                'service_type': self.service_type,
                'online': True,
                'version': info.get('version', 'Unknown'),
                'server_id': info.get('id', '')
            }
        except:
            return {
                'name': self.name,
                'url': self.url,
                'service_type': self.service_type,
                'online': False,
                'version': 'Unknown'
            }
    
    def supports_feature(self, feature: str) -> bool:
        """Override to specify which features your service supports"""
        # Define which features your service supports
        supported_features = [
            'user_management',
            'library_access',
            'active_sessions',  # Remove if not supported
            'downloads',        # Remove if not supported
            # 'transcoding',    # Add if supported
            # 'sharing',        # Add if supported
            # 'invitations',    # Add if supported
        ]
        
        return feature in supported_features