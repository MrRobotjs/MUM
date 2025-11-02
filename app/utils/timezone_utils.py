# File: app/utils/timezone_utils.py
import os
import pytz
from datetime import datetime, timezone
from typing import Optional

def get_app_timezone():
    """Get the application timezone from TZ environment variable or default to UTC."""
    tz_name = os.environ.get('TZ', 'UTC')
    try:
        return pytz.timezone(tz_name)
    except pytz.UnknownTimeZoneError:
        # Fallback to UTC if invalid timezone
        return pytz.UTC

def now():
    """Get current datetime in the application's configured timezone."""
    app_tz = get_app_timezone()
    return datetime.now(app_tz)

def utcnow():
    """Get current datetime in UTC (for database storage)."""
    return datetime.now(timezone.utc)

def to_app_timezone(dt: Optional[datetime]) -> Optional[datetime]:
    """Convert a datetime to the application's timezone."""
    if dt is None:
        return None
    
    app_tz = get_app_timezone()
    
    # If datetime is naive, assume it's UTC
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    
    return dt.astimezone(app_tz)

def format_datetime(dt: Optional[datetime], format_str: str = "%Y-%m-%d %H:%M", show_timezone: bool = True) -> str:
    """Format datetime in the application's timezone."""
    if dt is None:
        return "N/A"
    
    # Convert to app timezone for display
    local_dt = to_app_timezone(dt)
    
    if show_timezone:
        # Add timezone abbreviation
        tz_abbr = local_dt.strftime('%Z')
        if not tz_abbr:  # Some timezones don't have abbreviations
            tz_abbr = str(local_dt.tzinfo)
        return f"{local_dt.strftime(format_str)} {tz_abbr}"
    else:
        return local_dt.strftime(format_str)

def format_datetime_human(dt: Optional[datetime], include_time: bool = True) -> str:
    """Format datetime in a human-readable format using app timezone."""
    if dt is None:
        return "N/A"
    
    local_dt = to_app_timezone(dt)
    
    if include_time:
        return format_datetime(local_dt, "%Y-%m-%d %I:%M %p", show_timezone=True)
    else:
        return format_datetime(local_dt, "%Y-%m-%d", show_timezone=False)

def get_all_timezones():
    """Get a list of all available timezone names."""
    return pytz.all_timezones

def format_datetime_user(dt: Optional[datetime], include_time: bool = True) -> str:
    """Format datetime based on the current user's timezone preference."""
    if dt is None:
        return "N/A"

    # Use JWT-provided current_user when available
    try:
        from flask_jwt_extended import current_user as jwt_current_user
    except Exception:
        jwt_current_user = None
    from app.models import User, UserType, UserPreferences

    if not jwt_current_user:
        return format_datetime(dt)

    prefs = UserPreferences.get_timezone_preference(jwt_current_user.id)
    preference = prefs.get('preference', 'local')
    local_timezone_str = prefs.get('local_timezone')
    time_format = prefs.get('time_format', '12')

    if include_time:
        if time_format == '24':
            format_str = '%Y-%m-%d %H:%M:%S'
        else:
            format_str = '%Y-%m-%d %I:%M:%S %p'
    else:
        format_str = '%Y-%m-%d'

    if preference == 'utc':
        # Ensure datetime is in UTC for display
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        utc_dt = dt.astimezone(timezone.utc)
        return f"{utc_dt.strftime(format_str)} UTC"
    
    if local_timezone_str:
        try:
            local_tz = pytz.timezone(local_timezone_str)
            # Ensure datetime has timezone info before conversion
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            local_dt = dt.astimezone(local_tz)
            if include_time:
                return local_dt.strftime(f'{format_str} %Z')
            return local_dt.strftime(format_str)
        except pytz.UnknownTimeZoneError:
            # Fallback to app timezone if user's timezone is invalid
            return format_datetime(dt)
    
    # Fallback to app timezone
    return format_datetime(dt)

