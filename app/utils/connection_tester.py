"""
Connection testing utilities for media servers.
Provides functions to test connectivity and authentication for various media services.
"""

import requests
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
        
        server_name = root.get('friendlyName', 'Unknown')
        version = root.get('version', 'Unknown')
        
        return True, f"Successfully connected to Plex server '{server_name}' (v{version})"
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "Plex")
    except Exception as e:
        return False, f"Unexpected error testing Plex connection: {str(e)}"


def check_audiobookshelf(url: str, token: str) -> Tuple[bool, str]:
    """Test connection to AudioBookshelf server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Test basic connectivity
        response = requests.get(
            f"{url}/api/me",
            headers={"Authorization": f"Bearer {token}"},
            timeout=get_api_timeout_with_fallback(10)
        )
        response.raise_for_status()
        
        user_info = response.json()
        username = user_info.get('username', 'Unknown')
        
        # Get server info
        server_response = requests.get(
            f"{url}/status",
            headers={"Authorization": f"Bearer {token}"},
            timeout=get_api_timeout_with_fallback(10)
        )
        server_response.raise_for_status()
        
        server_info = server_response.json()
        version = server_info.get('version', 'Unknown')
        
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


def check_komga(url: str, username: str, password: str) -> Tuple[bool, str]:
    """Test connection to Komga server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # Test basic connectivity with authentication
        response = requests.get(
            f"{url}/api/v1/users/me",
            auth=(username, password),
            timeout=get_api_timeout_with_fallback(10)
        )
        response.raise_for_status()
        
        user_info = response.json()
        user_email = user_info.get('email', username)
        
        # Get server info
        server_response = requests.get(
            f"{url}/api/v1/actuator/info",
            auth=(username, password),
            timeout=get_api_timeout_with_fallback(10)
        )
        
        if server_response.status_code == 200:
            server_info = server_response.json()
            version = server_info.get('build', {}).get('version', 'Unknown')
        else:
            version = 'Unknown'
        
        return True, f"Successfully connected to Komga server (v{version}) as user '{user_email}'"
        
    except requests.exceptions.RequestException as e:
        return handle_connection_error(e, "Komga")
    except Exception as e:
        return False, f"Unexpected error testing Komga connection: {str(e)}"


def check_romm(url: str, username: str, password: str) -> Tuple[bool, str]:
    """Test connection to RomM server."""
    try:
        # Clean up URL
        url = url.rstrip('/')
        
        # First, get authentication token
        auth_response = requests.post(
            f"{url}/api/token",
            data={"username": username, "password": password},
            timeout=get_api_timeout_with_fallback(10)
        )
        auth_response.raise_for_status()
        
        auth_data = auth_response.json()
        token = auth_data.get('access_token')
        
        if not token:
            return False, "Failed to authenticate with RomM server"
        
        # Test authenticated request
        response = requests.get(
            f"{url}/api/users/me",
            headers={"Authorization": f"Bearer {token}"},
            timeout=get_api_timeout_with_fallback(10)
        )
        response.raise_for_status()
        
        user_info = response.json()
        user_username = user_info.get('username', username)
        
        return True, f"Successfully connected to RomM server as user '{user_username}'"
        
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
            username = credentials.get('username')
            password = credentials.get('password')
            if not username or not password:
                return False, "Username and password are required for Komga"
            return check_komga(url, username, password)
            
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