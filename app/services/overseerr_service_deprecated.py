"""DEPRECATED: Overseerr service helpers used by legacy SSR flows.

API v2 endpoints for Overseerr listing do not require this.
"""
import requests
from typing import Dict, List, Tuple, Optional
from flask import current_app


class OverseerrService:
    """Service for interacting with Overseerr API"""
    
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.update({
            'X-Api-Key': api_key,
            'Content-Type': 'application/json'
        })
    
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection to Overseerr instance"""
        try:
            # First check if the base URL is reachable with the status endpoint (no auth required)
            current_app.logger.info(f"OVERSEERR SERVICE DEBUG: Testing connection to {self.base_url}")
            status_response = self.session.get(f"{self.base_url}/api/v1/status", timeout=10)
            
            if status_response.status_code != 200:
                return False, f"Cannot reach Overseerr server: HTTP {status_response.status_code}"
            
            # Get version from status for success message
            status_data = status_response.json()
            version = status_data.get('version', 'Unknown')
            
            # Now test authentication with a fast endpoint that requires a valid API key
            current_app.logger.info(f"OVERSEERR SERVICE DEBUG: Testing API key authentication")
            current_app.logger.info(f"OVERSEERR SERVICE DEBUG: Using API key: {self.api_key[:10]}...")
            
            # Use GET /user/1 endpoint to test auth (fast - single user lookup, user 1 is always admin/owner)
            auth_response = self.session.get(f"{self.base_url}/api/v1/user/1", timeout=10)
            
            current_app.logger.info(f"OVERSEERR SERVICE DEBUG: Auth test response status: {auth_response.status_code}")
            current_app.logger.info(f"OVERSEERR SERVICE DEBUG: Auth test response text: {auth_response.text[:200]}")
            
            if auth_response.status_code == 200:
                return True, f"Connected to Overseerr v{version}"
            elif auth_response.status_code == 401:
                return False, "Invalid API key"
            elif auth_response.status_code == 403:
                return False, "API key does not have sufficient permissions"
            elif auth_response.status_code == 404:
                return False, "User 1 not found - Overseerr may not be properly initialized"
            else:
                return False, f"Authentication failed: HTTP {auth_response.status_code}: {auth_response.text[:100]}"
                
        except requests.exceptions.Timeout:
            return False, "Connection timeout - check URL and network connectivity"
        except requests.exceptions.ConnectionError:
            return False, "Cannot connect to Overseerr - check URL and ensure service is running"
        except requests.exceptions.RequestException as e:
            return False, f"Request failed: {str(e)}"
        except Exception as e:
            current_app.logger.error(f"Overseerr connection test error: {e}")
            return False, f"Unexpected error: {str(e)}"
    
    def get_users(self) -> Tuple[bool, List[Dict], str]:
        """Get all users from Overseerr"""
        try:
            # Request more users to avoid pagination issues (max 100 per Overseerr API)
            params = {
                'take': 100,  # Maximum allowed by Overseerr API
                'skip': 0
            }
            
            response = self.session.get(f"{self.base_url}/api/v1/user", params=params, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                users = data.get('results', [])
                total_results = data.get('pageInfo', {}).get('results', len(users))
                
                current_app.logger.info(f"OVERSEERR API: Retrieved {len(users)} users out of {total_results} total")
                
                # If there are more users than we retrieved, log a warning
                if total_results > len(users):
                    current_app.logger.warning(f"OVERSEERR API: Only retrieved {len(users)} out of {total_results} total users. Some users may be missed.")
                
                return True, users, f"Retrieved {len(users)} users (total: {total_results})"
            elif response.status_code == 401:
                return False, [], "Invalid API key"
            elif response.status_code == 403:
                return False, [], "API key does not have sufficient permissions to access users"
            else:
                return False, [], f"HTTP {response.status_code}: {response.text[:100]}"
                
        except requests.exceptions.RequestException as e:
            return False, [], f"Request failed: {str(e)}"
        except Exception as e:
            current_app.logger.error(f"Overseerr get users error: {e}")
            return False, [], f"Unexpected error: {str(e)}"
    
    def get_user_requests(self, user_id: int, take: int = 50, skip: int = 0) -> Tuple[bool, List[Dict], Dict, str]:
        """Get requests for a specific user with enhanced media information"""
        try:
            params = {
                'take': take,
                'skip': skip,
                'filter': 'all',
                'sort': 'added',
                'requestedBy': user_id
            }
            
            response = self.session.get(
                f"{self.base_url}/api/v1/request", 
                params=params,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                requests_list = data.get('results', [])
                page_info = data.get('pageInfo', {})
                total_results = data.get('totalResults', len(requests_list))
                
                current_app.logger.info(f"OVERSEERR API: Retrieved {len(requests_list)} requests out of {total_results} total for user {user_id}")
                
                # Enrich requests with detailed media information
                enriched_requests = []
                for request in requests_list:
                    enriched_request = self._enrich_request_with_media_details(request)
                    enriched_requests.append(enriched_request)
                
                pagination_info = {
                    'current_page': page_info.get('page', 1),
                    'total_pages': page_info.get('pages', 1),
                    'total_results': total_results,
                    'results_per_page': take,
                    'has_next': (skip + take) < total_results,
                    'has_prev': skip > 0
                }
                
                return True, enriched_requests, pagination_info, f"Retrieved {len(enriched_requests)} of {total_results} requests"
            elif response.status_code == 401:
                return False, [], {}, "Invalid API key"
            elif response.status_code == 403:
                return False, [], {}, "API key does not have sufficient permissions to access requests"
            else:
                return False, [], {}, f"HTTP {response.status_code}: {response.text[:100]}"
                
        except requests.exceptions.RequestException as e:
            return False, [], {}, f"Request failed: {str(e)}"
        except Exception as e:
            current_app.logger.error(f"Overseerr get user requests error: {e}")
            return False, [], {}, f"Unexpected error: {str(e)}"
    
    def get_movie_details(self, movie_id: int) -> Tuple[bool, Optional[Dict], str]:
        """Get detailed movie information from Overseerr"""
        try:
            response = self.session.get(f"{self.base_url}/api/v1/movie/{movie_id}", timeout=10)
            
            if response.status_code == 200:
                return True, response.json(), "Movie details retrieved"
            elif response.status_code == 404:
                return False, None, f"Movie {movie_id} not found"
            else:
                return False, None, f"HTTP {response.status_code}: {response.text[:100]}"
                
        except requests.exceptions.RequestException as e:
            return False, None, f"Request failed: {str(e)}"
        except Exception as e:
            current_app.logger.error(f"Overseerr get movie details error: {e}")
            return False, None, f"Unexpected error: {str(e)}"
    
    def get_tv_details(self, tv_id: int) -> Tuple[bool, Optional[Dict], str]:
        """Get detailed TV show information from Overseerr"""
        try:
            response = self.session.get(f"{self.base_url}/api/v1/tv/{tv_id}", timeout=10)
            
            if response.status_code == 200:
                return True, response.json(), "TV show details retrieved"
            elif response.status_code == 404:
                return False, None, f"TV show {tv_id} not found"
            else:
                return False, None, f"HTTP {response.status_code}: {response.text[:100]}"
                
        except requests.exceptions.RequestException as e:
            return False, None, f"Request failed: {str(e)}"
        except Exception as e:
            current_app.logger.error(f"Overseerr get TV details error: {e}")
            return False, None, f"Unexpected error: {str(e)}"
    
    def _enrich_request_with_media_details(self, request: Dict) -> Dict:
        """Enrich a request with detailed media information"""
        try:
            media = request.get('media', {})
            media_type = media.get('mediaType')
            tmdb_id = media.get('tmdbId')
            
            if not tmdb_id or not media_type:
                current_app.logger.debug(f"Request {request.get('id')} missing tmdb_id or media_type")
                return request
            
            # Get detailed media info based on type
            if media_type == 'movie':
                success, details, message = self.get_movie_details(tmdb_id)
            elif media_type == 'tv':
                success, details, message = self.get_tv_details(tmdb_id)
            else:
                current_app.logger.debug(f"Unknown media type: {media_type}")
                return request
            
            if success and details:
                # Merge the detailed information with the existing media object
                enriched_media = {**media, **details}
                request['media'] = enriched_media
                current_app.logger.debug(f"Enriched request {request.get('id')} with detailed {media_type} info")
            else:
                current_app.logger.warning(f"Failed to get {media_type} details for TMDB ID {tmdb_id}: {message}")
            
            return request
            
        except Exception as e:
            current_app.logger.error(f"Error enriching request with media details: {e}")
            return request
    
    def get_user_by_plex_username(self, plex_username: str) -> Tuple[bool, Optional[Dict], str]:
        """Find Overseerr user by Plex username"""
        try:
            success, users, message = self.get_users()
            if not success:
                return False, None, message
            
            current_app.logger.info(f"OVERSEERR API DEBUG: Looking for Plex username '{plex_username}' in {len(users)} Overseerr users")
            
            # Debug: Log all users and their Plex usernames
            for i, user in enumerate(users):
                overseerr_username = user.get('username', 'N/A')
                plex_username_in_overseerr = user.get('plexUsername', 'N/A')
                user_email = user.get('email', 'N/A')
                user_id = user.get('id', 'N/A')
                current_app.logger.info(f"OVERSEERR API DEBUG: User {i+1}: id={user_id}, username='{overseerr_username}', email='{user_email}', plexUsername='{plex_username_in_overseerr}'")
            
            for user in users:
                # Check if user has Plex account linked by username
                if user.get('plexUsername') == plex_username:
                    current_app.logger.info(f"OVERSEERR API DEBUG: Found exact match for '{plex_username}'")
                    return True, user, f"Found user: {user.get('username', user.get('email', 'Unknown'))}"
            
            # Debug: Try case-insensitive matching
            for user in users:
                overseerr_plex_username = user.get('plexUsername', '')
                if overseerr_plex_username.lower() == plex_username.lower():
                    current_app.logger.info(f"OVERSEERR API DEBUG: Found case-insensitive match: '{overseerr_plex_username}' matches '{plex_username}'")
                    return True, user, f"Found user (case-insensitive): {user.get('username', user.get('email', 'Unknown'))}"
            
            # Debug: Try email matching as fallback
            current_app.logger.info(f"OVERSEERR API DEBUG: No plexUsername match found, checking if any users have email that might match")
            
            current_app.logger.info(f"OVERSEERR API DEBUG: No match found for Plex username '{plex_username}' among {len(users)} users")
            return False, None, f"No Overseerr user found with Plex username: {plex_username}"
            
        except Exception as e:
            current_app.logger.error(f"Overseerr get user by plex username error: {e}")
            return False, None, f"Error finding user: {str(e)}"
    
    def link_plex_users(self, plex_users: List[Dict]) -> Tuple[bool, List[Dict], str]:
        """Link Plex users to Overseerr users"""
        try:
            success, overseerr_users, message = self.get_users()
            if not success:
                return False, [], f"Failed to get Overseerr users: {message}"
            
            linked_users = []
            
            for plex_user in plex_users:
                plex_id = str(plex_user.get('id', ''))
                plex_username = plex_user.get('username', plex_user.get('title', 'Unknown'))
                
                # Find matching Overseerr user by plexUsername
                overseerr_user = None
                for ou in overseerr_users:
                    if ou.get('plexUsername') == plex_username:
                        overseerr_user = ou
                        break
                
                linked_user = {
                    'plex_id': plex_id,
                    'plex_username': plex_username,
                    'plex_email': plex_user.get('email', ''),
                    'overseerr_user_id': overseerr_user.get('id') if overseerr_user else None,
                    'overseerr_username': overseerr_user.get('username', overseerr_user.get('email', 'Unknown')) if overseerr_user else None,
                    'overseerr_email': overseerr_user.get('email') if overseerr_user else None,
                    'is_linked': overseerr_user is not None
                }
                linked_users.append(linked_user)
            
            linked_count = sum(1 for user in linked_users if user['is_linked'])
            return True, linked_users, f"Linked {linked_count} of {len(plex_users)} Plex users to Overseerr"
            
        except Exception as e:
            current_app.logger.error(f"Overseerr link plex users error: {e}")
            return False, [], f"Error linking users: {str(e)}"
    
    def update_request_status(self, request_id, status):
        """
        Update the status of an Overseerr request
        
        Args:
            request_id (int): The ID of the request to update
            status (str): The new status ('approve' or 'decline')
            
        Returns:
            tuple: (success: bool, message: str)
        """
        try:
            url = f"{self.base_url}/api/v1/request/{request_id}/{status}"
            headers = {
                'X-Api-Key': self.api_key,
                'Content-Type': 'application/json'
            }
            
            current_app.logger.info(f"OVERSEERR: Updating request {request_id} to {status}")
            
            response = requests.post(url, headers=headers, timeout=10)
            
            if response.status_code == 200:
                current_app.logger.info(f"OVERSEERR: Successfully {status}d request {request_id}")
                return True, f"Request {status}d successfully"
            else:
                error_msg = f"Failed to {status} request: HTTP {response.status_code}"
                try:
                    error_data = response.json()
                    if 'message' in error_data:
                        error_msg = error_data['message']
                except:
                    pass
                current_app.logger.error(f"OVERSEERR: {error_msg}")
                return False, error_msg
                
        except requests.RequestException as e:
            current_app.logger.error(f"OVERSEERR: Request error updating status: {str(e)}")
            return False, f"Connection error: {str(e)}"
        except Exception as e:
            current_app.logger.error(f"OVERSEERR: Unexpected error updating status: {str(e)}")
            return False, f"Unexpected error: {str(e)}"
    
    def delete_request(self, request_id):
        """
        Delete an Overseerr request
        
        Args:
            request_id (int): The ID of the request to delete
            
        Returns:
            tuple: (success: bool, message: str)
        """
        try:
            url = f"{self.base_url}/api/v1/request/{request_id}"
            headers = {
                'X-Api-Key': self.api_key,
                'Content-Type': 'application/json'
            }
            
            current_app.logger.info(f"OVERSEERR: Deleting request {request_id}")
            
            response = requests.delete(url, headers=headers, timeout=10)
            
            if response.status_code == 200:
                current_app.logger.info(f"OVERSEERR: Successfully deleted request {request_id}")
                return True, "Request deleted successfully"
            else:
                error_msg = f"Failed to delete request: HTTP {response.status_code}"
                try:
                    error_data = response.json()
                    if 'message' in error_data:
                        error_msg = error_data['message']
                except:
                    pass
                current_app.logger.error(f"OVERSEERR: {error_msg}")
                return False, error_msg
                
        except requests.RequestException as e:
            current_app.logger.error(f"OVERSEERR: Request error deleting request: {str(e)}")
            return False, f"Connection error: {str(e)}"
        except Exception as e:
            current_app.logger.error(f"OVERSEERR: Unexpected error deleting request: {str(e)}")
            return False, f"Unexpected error: {str(e)}"
