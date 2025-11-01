"""DEPRECATED: Connection testing utilities for media servers (SSR-era).

Kept only for deprecated plugin management routes.
"""

import requests
import base64
from typing import Tuple
from flask import current_app
from app.utils.timeout_helper import get_api_timeout_with_fallback


def handle_connection_error(error: Exception, service_name: str) -> Tuple[bool, str]:
    """Handle connection errors and return standardized response."""
    if isinstance(error, requests.exceptions.ConnectTimeout):
        return False, f"Connection to {service_name} timed out. Check if the server is running and accessible."
    elif isinstance(error, requests.exceptions.ConnectionError):
        return False, f"Could not connect to {service_name}. Check the URL and network connectivity."
    elif isinstance(error, requests.exceptions.HTTPError):
        return False, f"{service_name} returned an error: {error.response.status_code} - {error.response.reason}"
    elif isinstance(error, requests.exceptions.Timeout):
        return False, f"Request to {service_name} timed out. The server may be slow to respond."
    else:
        return False, f"Unexpected error connecting to {service_name}: {str(error)}"


def check_jellyfin(url: str, token: str) -> Tuple[bool, str]:
    """Test connection to Jellyfin server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Test basic connectivity
        response = requests.get(
            f"{url}/System/Info",
            headers={"X-Emby-Token": token},
            timeout=get_api_timeout_with_fallback(10)
        )
        response.raise_for_status()
        
        server_info = response.json()
        server_name = server_info.get('ServerName', 'Unknown')
        version = server_info.get('Version', 'Unknown')
        
        return True, f"Successfully connected to Jellyfin server '{server_name}' (v{version})"
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "Jellyfin")
    except Exception as e:
        return False, f"Unexpected error testing Jellyfin connection: {str(e)}"


def check_emby(url: str, token: str) -> Tuple[bool, str]:
    """Test connection to Emby server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Test basic connectivity
        response = requests.get(
            f"{url}/System/Info",
            headers={"X-Emby-Token": token},
            timeout=get_api_timeout_with_fallback(10)
        )
        response.raise_for_status()
        
        server_info = response.json()
        server_name = server_info.get('ServerName', 'Unknown')
        version = server_info.get('Version', 'Unknown')
        
        return True, f"Successfully connected to Emby server '{server_name}' (v{version})"
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "Emby")
    except Exception as e:
        return False, f"Unexpected error testing Emby connection: {str(e)}"


def check_plex(url: str, token: str) -> Tuple[bool, str]:
    """Test connection to Plex server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Test basic connectivity
        response = requests.get(
            f"{url}/identity",
            headers={"X-Plex-Token": token},
            timeout=get_api_timeout_with_fallback(10)
        )
        response.raise_for_status()
        
        # Parse XML response
        import xml.etree.ElementTree as ET
        root = ET.fromstring(response.content)
        
        server_name = root.get('friendlyName', 'Unknown') # There is no "friendlyName" in /identity
        version = root.get('version', 'Unknown')
        
        return True, f"Successfully connected to Plex server v{version}"
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "Plex")
    except Exception as e:
        return False, f"Unexpected error testing Plex connection: {str(e)}"


def check_audiobookshelf(url: str, token: str) -> Tuple[bool, str]:
    """Test connection to AudioBookshelf server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Debug logging
        from flask import current_app
        current_app.logger.debug(f"AudioBookshelf connection test - URL: {url}")
        current_app.logger.debug(f"AudioBookshelf connection test - Token length: {len(token) if token else 0}")
        current_app.logger.debug(f"AudioBookshelf connection test - Token preview: {token[:20]}..." if token and len(token) > 20 else f"Token: {token}")
        
        # Test basic connectivity
        headers = {"Authorization": f"Bearer {token}"}
        current_app.logger.debug(f"AudioBookshelf connection test - Headers: {headers}")
        
        response = requests.get(
            f"{url}/api/me",
            headers=headers,
            timeout=get_api_timeout_with_fallback(10)
        )
        
        current_app.logger.debug(f"AudioBookshelf connection test - Response status: {response.status_code}")
        current_app.logger.debug(f"AudioBookshelf connection test - Response headers: {dict(response.headers)}")
        
        if response.status_code == 401:
            current_app.logger.debug(f"AudioBookshelf connection test - 401 response body: {response.text}")
            return False, f"Authentication failed. Please check your API token. Server response: {response.text[:100]}"
        
        response.raise_for_status()
        
        user_info = response.json()
        username = user_info.get('username', 'Unknown')
        
        # Get server info - try different endpoints
        version = 'Unknown'
        try:
            # Try /api/status first
            server_response = requests.get(
                f"{url}/api/status",
                headers=headers,
                timeout=get_api_timeout_with_fallback(10)
            )
            current_app.logger.debug(f"AudioBookshelf /api/status response: {server_response.status_code}")
            
            if server_response.status_code == 200:
                server_info = server_response.json()
                version = server_info.get('serverVersion', server_info.get('version', 'Unknown'))
            else:
                current_app.logger.debug(f"AudioBookshelf /api/status failed with {server_response.status_code}, trying alternatives")
                
                # Try /api/ping or other endpoints
                ping_response = requests.get(
                    f"{url}/api/ping",
                    headers=headers,
                    timeout=get_api_timeout_with_fallback(10)
                )
                current_app.logger.debug(f"AudioBookshelf /api/ping response: {ping_response.status_code}")
                
                if ping_response.status_code == 200:
                    ping_info = ping_response.json()
                    version = ping_info.get('serverVersion', ping_info.get('version', 'Unknown'))
                    
        except Exception as e:
            current_app.logger.debug(f"AudioBookshelf server info request failed: {e}")
            # Don't fail the whole test if we can't get version info
        
        return True, f"Successfully connected to AudioBookshelf server (v{version}) as user '{username}'"
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "AudioBookshelf")
    except Exception as e:
        return False, f"Unexpected error testing AudioBookshelf connection: {str(e)}"


def check_kavita(url: str, api_key: str) -> Tuple[bool, str]:
    """Test connection to Kavita server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Step 1: Authenticate with API key to get JWT token
        auth_url = f"{url}/api/Plugin/authenticate"
        auth_headers = {'accept': 'text/plain'}
        auth_params = {
            'apiKey': api_key,
            'pluginName': 'MUM'  # Using MUM as the plugin name
        }
        
        auth_response = requests.post(
            auth_url, 
            headers=auth_headers, 
            params=auth_params, 
            timeout=get_api_timeout_with_fallback(10)
        )
        auth_response.raise_for_status()
        
        # Try to parse as JSON first (Kavita returns JSON with token field)
        try:
            response_data = auth_response.json()
            jwt_token = response_data.get('token', '').strip()
        except ValueError:
            # Fallback to plain text if not JSON
            jwt_token = auth_response.text.strip()
        
        if not jwt_token:
            return False, "No JWT token returned from Kavita authentication"
        
        # Step 2: Test the JWT token with a simple API call
        headers = {"Authorization": f"Bearer {jwt_token}"}
        
        # Try the Health endpoint first as it's simpler
        health_response = requests.get(
            f"{url}/api/Health",
            headers=headers,
            timeout=get_api_timeout_with_fallback(10)
        )
        health_response.raise_for_status()
        
        # Try to get server info for version
        try:
            server_response = requests.get(
                f"{url}/api/Server/server-info-slim",
                headers=headers,
                timeout=get_api_timeout_with_fallback(10)
            )
            server_response.raise_for_status()
            
            server_info = server_response.json()
            version = server_info.get('kavitaVersion', 'Unknown')
            install_id = server_info.get('installId', 'Unknown')
            
            return True, f"Successfully connected to Kavita server (v{version}, ID: {install_id})"
        except:
            # If server info fails, just return success from health check
            return True, "Successfully connected to Kavita server"
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "Kavita")
    except Exception as e:
        return False, f"Unexpected error testing Kavita connection: {str(e)}"


def check_komga(url: str, api_key: str) -> Tuple[bool, str]:
    """Test connection to Komga server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Komga uses X-API-Key header authentication
        headers = {
            "X-API-Key": api_key,
            "Accept": "application/json"
        }
        
        # Test with libraries endpoint
        response = requests.get(
            f"{url}/api/v1/libraries",
            headers=headers,
            timeout=get_api_timeout_with_fallback(10)
        )
        response.raise_for_status()
        
        libraries = response.json()
        library_count = len(libraries) if isinstance(libraries, list) else 0
        
        # Try to get server info for version
        try:
            server_response = requests.get(
                f"{url}/api/v1/actuator/info",
                headers=headers,
                timeout=get_api_timeout_with_fallback(10)
            )
            
            if server_response.status_code == 200:
                server_info = server_response.json()
                version = server_info.get('build', {}).get('version', 'Unknown')
            else:
                version = 'Unknown'
        except:
            version = 'Unknown'
        
        return True, f"Successfully connected to Komga server (v{version}). Found {library_count} libraries."
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "Komga")
    except Exception as e:
        return False, f"Unexpected error testing Komga connection: {str(e)}"


def check_romm(url: str, username: str, password: str) -> Tuple[bool, str]:
    """Test connection to RomM server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # RomM uses Basic auth with base64 encoded username:password
        auth_string = f"{username}:{password}"
        encoded_auth = base64.b64encode(auth_string.encode()).decode()
        headers = {
            "Accept": "application/json",
            "Authorization": f"Basic {encoded_auth}"
        }
        
        # Test authenticated request - use platforms endpoint
        response = requests.get(
            f"{url}/api/platforms",
            headers=headers,
            timeout=get_api_timeout_with_fallback(10)
        )
        
        # Check status code explicitly
        if response.status_code != 200:
            return False, f"RomM returned status code {response.status_code}. Response: {response.text[:100]}"
        
        # Basic sanity check – ensure response is JSON list
        platforms = response.json()
        if not isinstance(platforms, list):
            return False, "Unexpected RomM response format - expected JSON list"
        
        platform_count = len(platforms)
        return True, f"Successfully connected to RomM server. Found {platform_count} platforms."
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "RomM")
    except Exception as e:
        return False, f"Unexpected error testing RomM connection: {str(e)}"


def test_server_connection(service_type: str, url: str, **credentials) -> Tuple[bool, str]:
    """
    Test connection to a media server based on service type.
    
    Args:
        service_type: Type of service (jellyfin, emby, plex, etc.)
        url: Server URL
        **credentials: Authentication credentials (token, username, password, etc.)
    
    Returns:
        Tuple of (success: bool, message: str)
    """
    service_type = service_type.lower()
    
    try:
        if service_type == 'jellyfin':
            token = credentials.get('token') or credentials.get('api_key')
            if not token:
                return False, "API token is required for Jellyfin"
            return check_jellyfin(url, token)
            
        elif service_type == 'emby':
            token = credentials.get('token') or credentials.get('api_key')
            if not token:
                return False, "API token is required for Emby"
            return check_emby(url, token)
            
        elif service_type == 'plex':
            token = credentials.get('token') or credentials.get('api_key')
            if not token:
                return False, "API token is required for Plex"
            return check_plex(url, token)
            
        elif service_type == 'audiobookshelf':
            token = credentials.get('token') or credentials.get('api_key')
            if not token:
                return False, "API token is required for AudioBookshelf"
            return check_audiobookshelf(url, token)
            
        elif service_type == 'kavita':
            api_key = credentials.get('token') or credentials.get('api_key')
            if not api_key:
                return False, "API token is required for Kavita"
            return check_kavita(url, api_key)
            
        elif service_type == 'komga':
            api_key = credentials.get('token') or credentials.get('api_key')
            if not api_key:
                return False, "API token is required for Komga"
            return check_komga(url, api_key)
            
        elif service_type == 'romm':
            username = credentials.get('username')
            password = credentials.get('password')
            if not username or not password:
                return False, "Username and password are required for RomM"
            return check_romm(url, username, password)
            
        else:
            return False, f"Unsupported service type: {service_type}"
            
    except Exception as e:
        current_app.logger.error(f"Error testing {service_type} connection: {e}", exc_info=True)
        return False, f"Unexpected error testing {service_type} connection: {str(e)}"
