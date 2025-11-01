"""DEPRECATED: Helper functions for legacy Plex auth flows (SSR setup/login).

API v2 now uses direct HTTP calls in handlers instead.
"""
"""
Helper functions for Plex authentication using python-plexapi instead of direct HTTP calls.
Replaces direct requests to plex.tv/api/v2/pins with plexapi.myplex.MyPlexPinLogin.
"""

import uuid
from flask import current_app
from plexapi.myplex import MyPlexPinLogin
from plexapi.exceptions import PlexApiException, BadRequest
from app.models import User, UserType, Setting


def get_plex_client_headers(client_identifier_suffix="MUM"):
    """
    Generate Plex client headers for API requests.
    
    Args:
        client_identifier_suffix: Suffix to append to the client identifier
        
    Returns:
        dict: Headers dictionary for Plex API requests
    """
    base_client_id = Setting.get('PLEX_APP_CLIENT_IDENTIFIER')
    if not base_client_id:
        base_client_id = current_app.config.get('PLEX_APP_CLIENT_IDENTIFIER_FALLBACK')
        if not base_client_id:
            base_client_id = "MUM-Default-" + str(uuid.uuid4())[:8]
            current_app.logger.warning(f"Plex Auth: PLEX_APP_CLIENT_IDENTIFIER setting not found. Using generated: {base_client_id}.")
    
    final_client_id = f"{base_client_id}-{client_identifier_suffix}"
    app_name = Setting.get('APP_NAME', current_app.config.get('APP_NAME', "Multimedia User Manager"))
    app_version = current_app.config.get('APP_VERSION', '1.0.0')
    
    headers = {
        'X-Plex-Product': app_name,
        'X-Plex-Version': app_version,
        'X-Plex-Client-Identifier': final_client_id,
        'X-Plex-Device': "Application",
        'X-Plex-Device-Name': f"{app_name} ({client_identifier_suffix})",
        'X-Plex-Platform': "Web",
        'Accept': 'application/xml'
    }
    
    current_app.logger.debug(f"Plex Auth: Generated headers for Plex API: {headers}")
    return headers


def create_plex_pin_login(client_identifier_suffix="MUM", oauth=False):
    """
    Create a Plex PIN login session using plexapi instead of direct HTTP requests.
    
    Args:
        client_identifier_suffix: Suffix for the client identifier
        oauth: Whether to use OAuth flow (default: False for PIN flow)
        
    Returns:
        tuple: (MyPlexPinLogin instance, error_message)
               Returns (None, error_message) on failure
    """
    try:
        headers = get_plex_client_headers(client_identifier_suffix)
        
        # Create PIN login using plexapi
        pin_login = MyPlexPinLogin(
            headers=headers,
            oauth=oauth
        )
        
        # Note: MyPlexPinLogin object may not have 'id' attribute in newer versions
        pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', 'unknown'))
        
        # For OAuth mode, we can't access the pin property, so handle differently
        if oauth:
            current_app.logger.info(f"Plex Auth: Created OAuth login. ID: {pin_id}")
        else:
            current_app.logger.info(f"Plex Auth: Created PIN login. PIN: {pin_login.pin}, ID: {pin_id}")
        return pin_login, None
        
    except PlexApiException as e:
        error_msg = f"Plex API error creating PIN: {str(e)}"
        current_app.logger.error(error_msg, exc_info=True)
        return None, error_msg
    except Exception as e:
        error_msg = f"Unexpected error creating Plex PIN: {str(e)}"
        current_app.logger.error(error_msg, exc_info=True)
        return None, error_msg


def check_plex_pin_status(pin_login):
    """
    Check the status of a Plex PIN login using plexapi.
    
    Args:
        pin_login: MyPlexPinLogin instance
        
    Returns:
        tuple: (auth_token, error_message)
               Returns (None, error_message) on failure or if not ready
    """
    try:
        # Check if the PIN has been authenticated
        if pin_login.checkLogin():
            pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', 'unknown'))
            current_app.logger.info(f"Plex Auth: PIN {pin_id} successfully authenticated")
            return pin_login.token, None
        else:
            # PIN not yet authenticated, but no error
            pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', 'unknown'))
            current_app.logger.debug(f"Plex Auth: PIN {pin_id} not yet authenticated")
            return None, "PIN not yet linked or has expired"
            
    except PlexApiException as e:
        error_msg = f"Plex API error checking PIN: {str(e)}"
        current_app.logger.error(error_msg, exc_info=True)
        return None, error_msg
    except Exception as e:
        error_msg = f"Unexpected error checking Plex PIN: {str(e)}"
        current_app.logger.error(error_msg, exc_info=True)
        return None, error_msg


def get_plex_auth_url(pin_login, forward_url, use_oauth=True):
    """
    Get the Plex authentication URL for user to visit.
    
    Args:
        pin_login: MyPlexPinLogin instance
        forward_url: URL to redirect to after authentication
        use_oauth: Whether to use OAuth flow or PIN flow
        
    Returns:
        str: Authentication URL for user to visit
    """
    try:
        pin_id = getattr(pin_login, 'id', getattr(pin_login, 'identifier', 'unknown'))
        
        if use_oauth:
            # For OAuth flow, create a new OAuth-enabled pin login
            oauth_pin_login, error_msg = create_plex_pin_login(
                client_identifier_suffix="OAuth", 
                oauth=True
            )
            if not oauth_pin_login:
                raise Exception(f"Failed to create OAuth login: {error_msg}")
            
            auth_url = oauth_pin_login.oauthUrl(forwardUrl=forward_url)
            current_app.logger.info(f"Plex Auth: Generated OAuth URL for PIN {pin_id}")
            return auth_url
        else:
            # For PIN flow, use manual URL construction
            from urllib.parse import urlencode, quote as url_quote
            
            headers = pin_login._headers if hasattr(pin_login, '_headers') else get_plex_client_headers()
            auth_app_params = {
                'clientID': headers.get('X-Plex-Client-Identifier', 'MUM'),
                'code': pin_login.pin,
                'forwardUrl': forward_url,
                'context[device][product]': headers.get('X-Plex-Product', 'Multimedia User Manager'),
                'context[device][deviceName]': headers.get('X-Plex-Device-Name', 'MUM'),
                'context[device][platform]': headers.get('X-Plex-Platform', 'Web'),
            }
            auth_url = f"https://app.plex.tv/auth/#?{urlencode(auth_app_params, quote_via=url_quote)}"
            current_app.logger.info(f"Plex Auth: Generated PIN auth URL for PIN {pin_id}")
            return auth_url
            
    except Exception as e:
        current_app.logger.error(f"Error generating Plex auth URL: {e}", exc_info=True)
        # Final fallback to manual URL construction
        from urllib.parse import urlencode, quote as url_quote
        
        headers = get_plex_client_headers()
        auth_app_params = {
            'clientID': headers.get('X-Plex-Client-Identifier', 'MUM'),
            'code': getattr(pin_login, 'pin', 'unknown'),
            'forwardUrl': forward_url,
            'context[device][product]': headers.get('X-Plex-Product', 'Multimedia User Manager'),
            'context[device][deviceName]': headers.get('X-Plex-Device-Name', 'MUM'),
            'context[device][platform]': headers.get('X-Plex-Platform', 'Web'),
        }
        return f"https://app.plex.tv/auth/#?{urlencode(auth_app_params, quote_via=url_quote)}"
