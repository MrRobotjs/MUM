from flask import Blueprint, request, current_app, flash, redirect, url_for, send_from_directory
from flask_login import login_required, current_user
from app.utils.helpers import setup_required, permission_required
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.models import User, UserType, Setting
import os

bp = Blueprint('streaming', __name__)

@bp.route('/streaming')
@login_required
@setup_required
@permission_required('view_streaming')
def index():
    # Redirect UserAppAccess without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('view_streaming'):
        flash('You do not have permission to access the streaming monitoring page.', 'danger')
        return redirect(url_for('user.index'))
    
    # Fetch the session monitoring interval from settings
    default_interval = 30  # Default fallback - don't use config, get from database
    try:
        interval_seconds_str = Setting.get('SESSION_MONITORING_INTERVAL_SECONDS', str(default_interval))
        # Ensure it's a valid integer, otherwise use a sensible default for the template
        streaming_refresh_interval_seconds = int(interval_seconds_str)
        if streaming_refresh_interval_seconds < 5: # Enforce a minimum reasonable refresh interval for UI
            current_app.logger.warning(f"Streaming page refresh interval ({streaming_refresh_interval_seconds}s) is too low, defaulting to 5s for UI.")
            streaming_refresh_interval_seconds = 5 
    except ValueError:
        current_app.logger.warning(f"Invalid SESSION_MONITORING_INTERVAL_SECONDS ('{interval_seconds_str}') in settings. Using default {default_interval}s for streaming page refresh.")
        streaming_refresh_interval_seconds = default_interval
    except Exception as e_setting:
        current_app.logger.error(f"Error fetching SESSION_MONITORING_INTERVAL_SECONDS: {e_setting}. Using default {default_interval}s.")
        streaming_refresh_interval_seconds = default_interval

    current_app.logger.debug(f"Streaming page will use refresh interval: {streaming_refresh_interval_seconds} seconds.")

    dist_path = os.path.join(current_app.root_path, 'static', 'dist')
    index_path = os.path.join(dist_path, 'index.html')

    if not os.path.exists(index_path):
        current_app.logger.error("React SPA build not found at %s", index_path)
        return (
            "<h1>React App Not Built</h1>"
            "<p>The React admin interface has not been built yet.</p>"
            "<p>Please run: <code>cd frontend && npm run build</code></p>"
        ), 500

    current_app.logger.debug("Serving React SPA for streaming page")
    return send_from_directory(dist_path, 'index.html')

@bp.route('/streaming/partial')
@login_required
@setup_required
@permission_required('view_streaming')
def sessions_partial():
    # Redirect UserAppAccess without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('view_streaming'):
        flash('You do not have permission to access the streaming monitoring page.', 'danger')
        return redirect(url_for('user.index'))
    
    view_mode = request.args.get('view', 'merged')
    
    active_sessions_data = []
    sessions_by_server = {}  # For categorized view
    sessions_by_service = {}  # For service view
    summary_stats = {
        "total_streams": 0,
        "direct_play_count": 0,
        "transcode_count": 0,
        "total_bandwidth_mbps": 0.0,
        "lan_bandwidth_mbps": 0.0,
        "wan_bandwidth_mbps": 0.0
    }

    try:
        # Get formatted sessions from all services using the new service methods
        all_servers = MediaServiceManager.get_all_servers()
        
        for server in all_servers:
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                try:
                    # Use the service's get_formatted_sessions method
                    formatted_sessions = service.get_formatted_sessions()
                    active_sessions_data.extend(formatted_sessions)
                except Exception as e:
                    current_app.logger.error(f"Error getting formatted sessions from {server.server_nickname}: {e}")

        # Calculate summary statistics from formatted sessions
        summary_stats["total_streams"] = len(active_sessions_data)
        
        for session in active_sessions_data:
            # Count transcoding vs direct play
            if session.get('is_transcode_calc', False):
                summary_stats["transcode_count"] += 1
            else:
                summary_stats["direct_play_count"] += 1
            
            # Calculate bandwidth
            bitrate_calc = session.get('bitrate_calc', 0)
            bitrate_mbps = bitrate_calc / 1000.0 if bitrate_calc else 0.0  # Convert kbps to Mbps
            summary_stats["total_bandwidth_mbps"] += bitrate_mbps
            
            # LAN vs WAN bandwidth
            if session.get('location_type_calc') == 'LAN':
                summary_stats["lan_bandwidth_mbps"] += bitrate_mbps
            else:
                summary_stats["wan_bandwidth_mbps"] += bitrate_mbps
            
            # Group sessions for different view modes
            server_name = session.get('server_name', 'Unknown Server')
            service_type = session.get('service_type', 'unknown')
            
            # Initialize server grouping for categorized view
            if view_mode == 'categorized':
                if server_name not in sessions_by_server:
                    sessions_by_server[server_name] = {
                        'sessions': [],
                        'stats': {
                            'total_streams': 0,
                            'direct_play_count': 0,
                            'transcode_count': 0,
                            'total_bandwidth_mbps': 0.0,
                            'lan_bandwidth_mbps': 0.0,
                            'wan_bandwidth_mbps': 0.0
                        }
                    }
                sessions_by_server[server_name]['sessions'].append(session)
                sessions_by_server[server_name]['stats']['total_streams'] += 1
                
                if session.get('is_transcode_calc', False):
                    sessions_by_server[server_name]['stats']['transcode_count'] += 1
                else:
                    sessions_by_server[server_name]['stats']['direct_play_count'] += 1
                
                sessions_by_server[server_name]['stats']['total_bandwidth_mbps'] += bitrate_mbps
                if session.get('location_type_calc') == 'LAN':
                    sessions_by_server[server_name]['stats']['lan_bandwidth_mbps'] += bitrate_mbps
                else:
                    sessions_by_server[server_name]['stats']['wan_bandwidth_mbps'] += bitrate_mbps
            
            # Initialize service grouping for service view
            elif view_mode == 'service':
                service_display_name = service_type.title()
                if service_display_name not in sessions_by_service:
                    sessions_by_service[service_display_name] = {
                        'sessions': [],
                        'stats': {
                            'total_streams': 0,
                            'direct_play_count': 0,
                            'transcode_count': 0,
                            'total_bandwidth_mbps': 0.0,
                            'lan_bandwidth_mbps': 0.0,
                            'wan_bandwidth_mbps': 0.0
                        }
                    }
                sessions_by_service[service_display_name]['sessions'].append(session)
                sessions_by_service[service_display_name]['stats']['total_streams'] += 1
                
                if session.get('is_transcode_calc', False):
                    sessions_by_service[service_display_name]['stats']['transcode_count'] += 1
                else:
                    sessions_by_service[service_display_name]['stats']['direct_play_count'] += 1
                
                sessions_by_service[service_display_name]['stats']['total_bandwidth_mbps'] += bitrate_mbps
                if session.get('location_type_calc') == 'LAN':
                    sessions_by_service[service_display_name]['stats']['lan_bandwidth_mbps'] += bitrate_mbps
                else:
                    sessions_by_service[service_display_name]['stats']['wan_bandwidth_mbps'] += bitrate_mbps
        
        # Round bandwidth values for display
        summary_stats["total_bandwidth_mbps"] = round(summary_stats["total_bandwidth_mbps"], 1)
        summary_stats["lan_bandwidth_mbps"] = round(summary_stats["lan_bandwidth_mbps"], 1)
        summary_stats["wan_bandwidth_mbps"] = round(summary_stats["wan_bandwidth_mbps"], 1)

        # Round server-specific bandwidth values
        if view_mode == 'categorized':
            for server_data in sessions_by_server.values():
                server_data['stats']['total_bandwidth_mbps'] = round(server_data['stats']['total_bandwidth_mbps'], 1)
                server_data['stats']['lan_bandwidth_mbps'] = round(server_data['stats']['lan_bandwidth_mbps'], 1)
                server_data['stats']['wan_bandwidth_mbps'] = round(server_data['stats']['wan_bandwidth_mbps'], 1)
        
        # Round service-specific bandwidth values
        elif view_mode == 'service':
            for service_data in sessions_by_service.values():
                service_data['stats']['total_bandwidth_mbps'] = round(service_data['stats']['total_bandwidth_mbps'], 1)
                service_data['stats']['lan_bandwidth_mbps'] = round(service_data['stats']['lan_bandwidth_mbps'], 1)
                service_data['stats']['wan_bandwidth_mbps'] = round(service_data['stats']['wan_bandwidth_mbps'], 1)

    except Exception as e:
        current_app.logger.debug(f"Error during streaming_sessions_partial: {e}", exc_info=True)
    
    if view_mode == 'categorized':
        return render_template('streaming/_partials/sessions_categorized.html', 
                               sessions_by_server=sessions_by_server, 
                               summary_stats=summary_stats)
    elif view_mode == 'service':
        return render_template('streaming/_partials/sessions_categorized_by_service.html', 
                               sessions_by_service=sessions_by_service, 
                               summary_stats=summary_stats)
    else:
        return render_template('streaming/_partials/sessions.html', 
                               sessions=active_sessions_data, 
                               summary_stats=summary_stats)
# DEPRECATED: Legacy Flask SSR streaming routes. Replaced by React SPA.
