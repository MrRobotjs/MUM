# File: app/utils/helpers.py
import re
from datetime import datetime, timezone, timedelta
# CSRF removed (JWT-only)
from app.utils.timezone_utils import to_app_timezone, format_datetime_human as tz_format_datetime_human
from flask import current_app, flash, g as flask_g, redirect, request  # Use flask_g to avoid conflict with local g
from functools import wraps
# Prefer JWT current_user, fall back to None
try:
    from flask_jwt_extended import current_user as jwt_current_user
except Exception:  # pragma: no cover - optional
    jwt_current_user = None
# app.models import HistoryLog, EventType # This creates circular import if models also import helpers
# from app.extensions import db # Same here

# It's better to import db and models within the function or pass them if needed,
# or ensure helpers don't directly cause DB interaction at module level.

def is_setup_complete():
    """
    Helper function to check the global setup flag.
    The g.setup_complete flag is set on each request by the before_request hook.
    """
    return getattr(flask_g, 'setup_complete', False)


ADMIN_LOGIN_PATH = '/admin/login'
SETUP_UI_PATH = '/setup/account'


def setup_required(f):
    """
    Decorator to ensure that the application setup has been completed
    before allowing access to a route. If setup is not complete, it redirects
    the user to the first step of the setup process.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # The 'g.setup_complete' flag is the primary check. If it's true,
        # the user can proceed to the requested page.
        if is_setup_complete():
            return f(*args, **kwargs)

        # If setup is not complete, we need to redirect the user.
        # This check complements the global before_request hook in app/__init__.py
        # and acts as a direct protector on the route.
        
        # Allow dashboard and media server management endpoints to bypass setup check
        # since the app is already configured and we're just managing existing setup
        bypass_endpoints = [
            'dashboard.settings_plugin_configure', 'dashboard.settings_plugins',
            'dashboard.settings',
            # Plugin management endpoints should work even when setup is not complete
            'plugins.enable_plugin', 'plugins.disable_plugin', 'plugins.reload_plugins',
            'plugins.install_plugin', 'plugins.uninstall_plugin', 'setup.plugins'
        ]
        
        # Also bypass if the endpoint starts with 'dashboard.' or 'media_servers.' or 'plugin_management.'
        if (request.endpoint in bypass_endpoints or 
            (request.endpoint and (request.endpoint.startswith('dashboard.') or 
                                 request.endpoint.startswith('media_servers.') or
                                 request.endpoint.startswith('setup.') or
                                 request.endpoint.startswith('plugin_management.')))):
            return f(*args, **kwargs)
        
        # We also check that we are not already on a setup page to avoid redirect loops.
        if request.endpoint and not request.endpoint.startswith(('setup.', 'public_spa.')):
            flash("Application setup is not complete. Please follow the steps below.", "warning")
            return redirect(SETUP_UI_PATH)
        
        # If we are already on a setup page (like /setup/plex), allow it to run
        # so the user can complete the setup process.
        return f(*args, **kwargs)
    return decorated_function


    except Exception:
        pass


def get_csrf_token():
    """JWT-only mode: CSRF tokens are not used."""
    return ""

def calculate_expiry_date(days: int) -> datetime | None:
    if days is None or days <= 0: return None
    return datetime.now(timezone.utc) + timedelta(days=days)

# UNUSED: legacy template helper (deprecated SSR)
# UNUSED: legacy template helper (deprecated SSR)
# def format_datetime_human(dt: datetime | None, include_time=True, naive_as_utc=True) -> str:
#     """Format datetime using the application's configured timezone."""
#     return tz_format_datetime_human(dt, include_time)

# UNUSED: legacy template helper (deprecated SSR)
# UNUSED: legacy template helper (deprecated SSR)
# def time_ago(dt: datetime | None, naive_as_utc=True) -> str:
#     ...

# UNUSED: legacy template helper (deprecated SSR)
# UNUSED: legacy template helper (deprecated SSR)
# def humanize_time(dt):
#     ...


# UNUSED: Legacy Plex auth helpers (replaced by API v2 public invite/auth flows)
# def generate_plex_auth_url(plex_client_id, forward_url, app_name="Multimedia User Manager"):
#     from plexapi.myplex import MyPlexAccount # Local import
#     try:
#         pin_data = MyPlexAccount.get_plex_pin(plex_client_id,product_name=app_name,forwardUrl=forward_url)
#         pin_id = pin_data['id']; pin_code = pin_data['code']
#         auth_url_with_pin = f"https://app.plex.tv/auth#?clientID={plex_client_id}&code={pin_code}&context[device][product]={app_name.replace(' ', '%20')}"
#         return pin_id, auth_url_with_pin
#     except Exception as e: current_app.logger.error(f"Error generating Plex PIN: {e}"); return None, None

# def check_plex_pin_auth(plex_client_id, pin_id):
#     from plexapi.myplex import MyPlexAccount # Local import
#     try:
#         auth_token = MyPlexAccount.check_plex_pin(plex_client_id, pin_id)
#         if auth_token: return auth_token
#         return None
#     except Exception as e: current_app.logger.error(f"Error checking Plex PIN: {e}"); return None

def sanitize_filename(filename: str) -> str:
    if not filename: return "untitled"
    filename = filename.split('/')[-1].split('\\')[-1]
    filename = re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
    filename = re.sub(r'__+', '_', filename)
    filename = filename.strip('_.-')
    if not filename: return "sanitized_file"
    return filename

def permission_required(permission_name):
    """Decorator to check if a logged-in user has a specific permission."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                return redirect(ADMIN_LOGIN_PATH)
            
            # Import user types locally to avoid circular imports
            from app.models import User, UserType
            
            # Owner always has all permissions
            if current_user.userType == UserType.OWNER:
                return f(*args, **kwargs)

            # Administrators (role with 'administrator' permission) have full access
            try:
                if current_user.has_permission('administrator'):
                    return f(*args, **kwargs)
            except Exception:
                pass
            
            # Check permissions for LOCAL users (role-based)
            if current_user.userType == UserType.LOCAL:
                if current_user.has_permission(permission_name):
                    return f(*args, **kwargs)
            
            # Other user types don't have admin permissions
            flash("You do not have permission to access this page.", "danger")
            return redirect('/user')
        return decorated_function
    return decorator

def any_permission_required(permissions):
    """
    Checks if a user has at least one of the permissions in the provided list.
    'permissions' should be a list of permission name strings.
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                return redirect(ADMIN_LOGIN_PATH)
            
            # Import user types locally to avoid circular imports
            from app.models import UserType
            
            # Owner always has all permissions
            if current_user.userType == UserType.OWNER:
                return f(*args, **kwargs)

            # Administrators (role with 'administrator' permission) have full access
            try:
                if current_user.has_permission('administrator'):
                    return f(*args, **kwargs)
            except Exception:
                pass
            
            # Check if local user has ANY of the permissions in the list
            if current_user.userType == UserType.LOCAL:
                for perm in permissions:
                    if current_user.has_permission(perm):
                        return f(*args, **kwargs)
            
            # If no permissions found, deny access
            flash("You do not have permission to access this page.", "danger")
            return redirect('/admin/dashboard')
        return decorated_function
    return decorator

# UNUSED: legacy template helper (deprecated SSR)
# UNUSED: legacy template helper (deprecated SSR)
# def get_text_color_for_bg(hex_color):
#     ...

def get_user_by_uuid(user_uuid):
    """Get user (either type) by uuid"""
    
    # Find user in unified User table
    from app.models import User, UserType
    user = User.query.filter_by(uuid=user_uuid).first()
    if user:
        if user.userType == UserType.SERVICE:
            return user, "user_media_access"  # Keep legacy type name for compatibility
        elif user.userType == UserType.LOCAL:
            return user, "user_app_access"   # Keep legacy type name for compatibility
        elif user.userType == UserType.OWNER:
            return user, "owner"
    
    return None, None
    
def format_duration(total_seconds):
    """Formats a duration in seconds into a human-readable string like '1d 4h 5m'."""
    if not total_seconds or total_seconds < 0:
        return "0m"
    
    delta = timedelta(seconds=int(total_seconds))
    days = delta.days
    hours, rem = divmod(delta.seconds, 3600)
    minutes, _ = divmod(rem, 60)
    
    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0 or not parts: # Always show minutes if no other parts
        parts.append(f"{minutes}m")
        
    return " ".join(parts[:3]) # Show at most 3 parts (e.g., d, h, m)

# UNUSED: legacy template helper (deprecated SSR)
# UNUSED: legacy template helper (deprecated SSR)
# def format_media_duration(duration_value, service_type):
#     ...

# UNUSED: legacy template helper (deprecated SSR)
# UNUSED: legacy template helper (deprecated SSR)
# def format_json(data):
#     ...

# UNUSED: Legacy Jellyfin parsing helper (not referenced by active code)
# UNUSED: Legacy Jellyfin parsing helper (not referenced)
# def extract_jellyfin_user_info(raw_data_str):
#     ...

# UNUSED: Replaced by Owner/Administrator model
# UNUSED: super_admin_required (replaced by Administrator/Owner model)
# def super_admin_required(f):
#     ...


# UNUSED: Legacy SSR navigation helper
# UNUSED: Legacy SSR navigation helper kept for reference only
# def get_user_profile_url(user, **kwargs):
#     """
#     Generate the correct profile URL for any user type.
#     
#     Args:
#         user: AppUser or ServiceAccount instance
#         **kwargs: Additional URL parameters (tab, back, back_view, etc.)
#     
#     Returns:
#         str: The appropriate URL for the user's profile
#     """
#     from flask import url_for
#     import urllib.parse
#     
#     if user.userType == UserType.LOCAL:
#         # URL encode the username to handle special characters
#         encoded_username = urllib.parse.quote(user.localUsername, safe='')
#         return url_for('user.view_app_user', username=encoded_username, **kwargs)
#     else:
#         # Service Account - need to determine server and username
#         server_info = get_primary_server_for_user(user)
#         if server_info:
#             server_name, username = server_info
#             # URL encode both server nickname and username
#             encoded_server_name = urllib.parse.quote(server_name, safe='')
#             encoded_username = urllib.parse.quote(username, safe='')
#             return url_for('user.view_service_account', 
#                           server_nickname=encoded_server_name, 
#                           server_username=encoded_username, 
#                           **kwargs)
#     return None


# UNUSED: Legacy SSR helper
# UNUSED: get_primary_server_for_user (SSR helper)
# def get_primary_server_for_user(service_account):
#     ...


# UNUSED: Legacy SSR helper
# UNUSED: extract_username_for_server (SSR helper)
# def extract_username_for_server(service_account, server):
#     ...


# UNUSED: Legacy SSR display helper
# UNUSED: get_user_type_display (SSR helper)
# def get_user_type_display(user):
#     ...


# UNUSED: Legacy SSR helper
# UNUSED: get_user_servers_and_types (SSR helper)
# def get_user_servers_and_types(user):
#     ...


# UNUSED: Legacy routing helper
# UNUSED: validate_username_for_routing (legacy UI helper)
# def validate_username_for_routing(username, user_type='app'):
#     ...


# UNUSED: Legacy routing helper
# UNUSED: get_safe_username_for_url (legacy UI helper)
# def get_safe_username_for_url(username):
#     ...


# UNUSED: Legacy routing helper
# UNUSED: resolve_user_route_conflict (legacy UI helper)
# def resolve_user_route_conflict(path_segment):
#     ...
    
    # Check for server
    #server = MediaServer.query.filter_by(server_nickname=decoded_segment).first()
    
    #if app_user and server:
    #    result['type'] = 'ambiguous'
    #    result['user'] = app_user
    #    result['server'] = server
    #elif app_user:
    #    result['type'] = 'app_user'
    #    result['user'] = app_user
    #elif server:
    #    result['type'] = 'server'
    #    result['server'] = server
    
    #return result


def encode_url_component(text):
    """
    Encode URL components by replacing special characters with dashes.
    Replaces %20 (URL-encoded spaces), forward slashes, dots, colons, and spaces with dashes.
    
    Args:
        text (str): The text to encode for URL usage
        
    Returns:
        str: URL-safe string with special characters replaced by dashes
    """
    if not text:
        return text
    
    # First decode any existing URL encoding
    import urllib.parse
    decoded_text = urllib.parse.unquote(text)
    
    # Replace special characters with dashes
    # Order matters: do spaces first, then other characters
    encoded = decoded_text.replace(' ', '-')  # Replace spaces
    encoded = encoded.replace('/', '-')       # Replace forward slashes
    encoded = encoded.replace('.', '-')       # Replace dots
    encoded = encoded.replace(':', '-')       # Replace colons
    encoded = encoded.replace('%20', '-')     # Replace URL-encoded spaces (if any remain)
    
    # Clean up multiple consecutive dashes
    while '--' in encoded:
        encoded = encoded.replace('--', '-')
    
    # Remove leading/trailing dashes
    encoded = encoded.strip('-')
    
    # Debug logging
    try:
        from flask import current_app
        #current_app.logger.debug(f"encode_url_component: '{text}' -> '{encoded}'")
    except:
        pass  # Ignore if not in Flask context
    
    return encoded


def decode_url_component_variations(text):
    """
    Generate multiple possible variations of what the original text could have been.
    Since dashes could represent spaces, slashes, dots, or original hyphens, we need to try different combinations.
    
    Args:
        text (str): The URL-encoded text to decode
        
    Returns:
        list: List of possible original strings to try for database lookup
    """
    if not text:
        return [text]
    
    # First decode any URL encoding
    import urllib.parse
    decoded_text = urllib.parse.unquote(text)
    
    variations = []
    
    # IMPORTANT: Add the original text as-is first (in case it already had hyphens)
    variations.append(decoded_text)
    
    # Most common case: dashes represent spaces
    variations.append(decoded_text.replace('-', ' '))
    
    # Special case: Convert dashes to spaces but preserve compound words ending in -chan, -kun, -san, etc.
    # This handles Japanese/anime titles where some hyphens are part of compound words
    if '-chan' in decoded_text or '-kun' in decoded_text or '-san' in decoded_text:
        temp = decoded_text.replace('-', ' ')  # Convert all dashes to spaces first
        # Then restore common Japanese compound word patterns
        temp = temp.replace(' chan', '-chan')
        temp = temp.replace(' kun', '-kun') 
        temp = temp.replace(' san', '-san')
        variations.append(temp)
        
        # Also try with colon restoration for patterns like "Ribbon-chan-Eigo" -> "Ribbon-chan: Eigo"
        # This handles cases where the colon was encoded as a dash
        if 'chan ' in temp or 'kun ' in temp or 'san ' in temp:
            temp_with_colon = temp.replace('chan ', 'chan: ')
            temp_with_colon = temp_with_colon.replace('kun ', 'kun: ')
            temp_with_colon = temp_with_colon.replace('san ', 'san: ')
            variations.append(temp_with_colon)
    
    # Try dashes as slashes (for cases like "50/50" -> "50-50")
    variations.append(decoded_text.replace('-', '/'))
    
    # Try dashes as dots (for cases like "file.name" -> "file-name")
    variations.append(decoded_text.replace('-', '.'))
    
    # Try dashes as colons (for cases like "title: subtitle" -> "title- subtitle")
    variations.append(decoded_text.replace('-', ':'))
    
    # Try mixed patterns for complex titles with multiple dashes
    if '-' in decoded_text:
        # For titles like "ChID-BLITS-EBU", try preserving some hyphens while converting others
        # This handles cases where some dashes are original hyphens and others are encoded characters
        
        # Try converting only every other dash to space (common pattern)
        parts = decoded_text.split('-')
        if len(parts) > 2:
            # Try: "A-B-C-D" -> "A B-C D" (spaces for odd positions)
            temp = []
            for i, part in enumerate(parts):
                if i > 0 and i % 2 == 1:
                    temp.append(' ' + part)
                elif i > 0:
                    temp.append('-' + part)
                else:
                    temp.append(part)
            variations.append(''.join(temp))
            
            # Try: "A-B-C-D" -> "A-B C-D" (spaces for even positions)
            temp = []
            for i, part in enumerate(parts):
                if i > 0 and i % 2 == 0:
                    temp.append(' ' + part)
                elif i > 0:
                    temp.append('-' + part)
                else:
                    temp.append(part)
            variations.append(''.join(temp))
            
        # Special case: Handle version numbers like "5-1" -> "5.1"
        # This is common for audio/video content
        if len(parts) >= 2:
            # Look for numeric patterns that might be version numbers
            for i in range(len(parts) - 1):
                if parts[i].isdigit() and parts[i + 1].isdigit():
                    # Create a version with period instead of dash for this numeric pair
                    temp_parts = parts.copy()
                    temp_parts[i] = parts[i] + '.' + parts[i + 1]
                    # Remove the next part since we combined it
                    temp_parts.pop(i + 1)
                    # Rejoin with spaces for other dashes
                    variations.append(' '.join(temp_parts))
                    # Also try with original hyphens preserved elsewhere
                    if len(temp_parts) > 1:
                        # Convert some dashes to spaces, keep others as hyphens
                        result = temp_parts[0]
                        for j in range(1, len(temp_parts)):
                            if j == 1:  # First connection uses space
                                result += ' ' + temp_parts[j]
                            else:  # Others use hyphens
                                result += '-' + temp_parts[j]
                        variations.append(result)
                        
                    # Special case for the exact pattern we're seeing:
                    # "Fraunhofer-ChID-BLITS-EBU-5-1" -> "Fraunhofer ChID-BLITS-EBU 5.1"
                    if len(temp_parts) >= 2:
                        # Keep all hyphens except convert first dash to space and last to period
                        result = temp_parts[0]
                        for j in range(1, len(temp_parts)):
                            if j == 1:  # First connection uses space
                                result += ' ' + temp_parts[j]
                            elif j == len(temp_parts) - 1:  # Last part already has the period
                                result += ' ' + temp_parts[j]
                            else:  # Middle connections use hyphens
                                result += '-' + temp_parts[j]
                        variations.append(result)
    
    # Special handling for mixed patterns with colons
    # Handle cases like "Maji-de-Otaku-na-English!-Ribbon-chan:-Eigo-de-Tatakau-Mahou-Shoujo"
    # where some dashes are spaces, some are original hyphens, and some are colons
    if '-' in decoded_text and ':' in decoded_text:
        # Split by colon first to handle the colon separately
        colon_parts = decoded_text.split(':')
        if len(colon_parts) == 2:
            # Process each part separately
            left_part = colon_parts[0]  # "Maji-de-Otaku-na-English!-Ribbon-chan-"
            right_part = colon_parts[1]  # "-Eigo-de-Tatakau-Mahou-Shoujo"
            
            # For the left part, convert most dashes to spaces but keep some as hyphens
            # Pattern: "Maji-de-Otaku-na-English!-Ribbon-chan-" -> "Maji de Otaku na English! Ribbon-chan"
            left_processed = left_part.replace('-', ' ').strip()
            # But restore the hyphen in "Ribbon-chan"
            left_processed = left_processed.replace('Ribbon chan', 'Ribbon-chan')
            
            # For the right part, convert dashes to spaces
            # Pattern: "-Eigo-de-Tatakau-Mahou-Shoujo" -> " Eigo de Tatakau Mahou Shoujo"
            right_processed = right_part.replace('-', ' ').strip()
            
            # Combine with colon
            combined = left_processed + ': ' + right_processed
            variations.append(combined)
            
            # Also try without the space after colon
            combined_no_space = left_processed + ':' + right_processed
            variations.append(combined_no_space)
    
    # Additional pattern for anime/Japanese titles with mixed encoding
    # Handle "Maji-de-Otaku-na-English!-Ribbon-chan:-Eigo-de-Tatakau-Mahou-Shoujo"
    if '-' in decoded_text:
        # Try converting spaces around specific patterns while preserving hyphens in compound words
        temp = decoded_text
        # Convert word boundary dashes to spaces, but preserve hyphens in compound words
        # This is a heuristic approach for Japanese/anime titles
        
        # Pattern 1: Convert dashes between lowercase/uppercase boundaries to spaces
        import re
        # Replace dashes that are likely word separators
        pattern1 = re.sub(r'-([A-Z])', r' \1', temp)  # "word-Word" -> "word Word"
        pattern1 = re.sub(r'([a-z])-([a-z])', r'\1 \2', pattern1)  # "word-word" -> "word word"
        if pattern1 != temp:
            variations.append(pattern1)
        
        # Pattern 2: Handle the specific case with colon
        if ':' in temp:
            # "Maji-de-Otaku-na-English!-Ribbon-chan:-Eigo-de-Tatakau-Mahou-Shoujo"
            # -> "Maji de Otaku na English! Ribbon-chan: Eigo de Tatakau Mahou Shoujo"
            pattern2 = temp.replace('-', ' ')  # Convert all dashes to spaces first
            pattern2 = pattern2.replace('Ribbon chan:', 'Ribbon-chan:')  # Restore compound word hyphen
            variations.append(pattern2)
    
    # Remove duplicates while preserving order
    seen = set()
    unique_variations = []
    for variation in variations:
        if variation not in seen:
            seen.add(variation)
            unique_variations.append(variation)
    
    # Debug logging
    try:
        from flask import current_app
        current_app.logger.debug(f"decode_url_component_variations: '{text}' -> {unique_variations}")
    except:
        pass  # Ignore if not in Flask context
    
    return unique_variations


def decode_url_component(text):
    """
    Decode URL components by converting dashes back to spaces (most common case).
    For more complex cases, use decode_url_component_variations() in route handlers.
    
    Args:
        text (str): The URL-encoded text to decode
        
    Returns:
        str: Decoded string with dashes converted back to spaces
    """
    if not text:
        return text
    
    # First decode any URL encoding
    import urllib.parse
    decoded_text = urllib.parse.unquote(text)
    
    # For backward compatibility, convert dashes back to spaces
    # This assumes the most common case where dashes represent spaces
    return decoded_text.replace('-', ' ')


def generate_url_slug(text, max_length=100):
    """
    Generate a URL-safe slug from text for use in URLs.
    This creates human-readable URLs while keeping them safe.
    
    Args:
        text (str): The text to convert to a slug
        max_length (int): Maximum length of the slug
        
    Returns:
        str: URL-safe slug
    """
    if not text:
        return ''
    
    import re
    import unicodedata
    
    # Convert to lowercase and normalize unicode characters
    slug = unicodedata.normalize('NFKD', text.lower())
    
    # Remove non-ASCII characters
    slug = slug.encode('ascii', 'ignore').decode('ascii')
    
    # Replace spaces and special characters with hyphens
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    
    # Remove leading/trailing hyphens and limit length
    slug = slug.strip('-')[:max_length]
    
    # Remove trailing hyphen if truncation created one
    slug = slug.rstrip('-')
    
    return slug or 'media'  # Fallback if slug is empty