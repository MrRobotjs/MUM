# File: app/routes/api.py
from flask import Blueprint, request, current_app, render_template, Response, abort, jsonify, make_response
from flask_login import login_required, current_user
import requests
import json
from app.models import User, UserType, Invite, Setting
from app.utils.helpers import permission_required
from app.utils.timeout_helper import get_api_timeout
from app.extensions import csrf, db
from app.models_media_services import ServiceType, MediaServer
from app.services.media_service_factory import MediaServiceFactory
from app.services.media_service_manager import MediaServiceManager
import time
from datetime import datetime, timedelta

bp = Blueprint('api', __name__)

def get_stored_server_status():
    """Get server status from database (last known status)"""
    all_servers = MediaServiceManager.get_all_servers(active_only=True)
    server_count = len(all_servers)
    current_app.logger.debug(f"API: Found {server_count} servers to get stored status")
    
    if server_count == 0:
        return None
    elif server_count == 1:
        server = all_servers[0]
        return {
            'server_id': server.id,
            'name': f"{server.service_type.value.title()} Server Status",
            'service_type': server.service_type.value,
            'friendly_name': server.server_nickname,
            'actual_server_name': server.server_name,
            'online': server.last_status,
            'last_check_time': server.last_status_check,
            'error_message': server.last_status_error,
            'version': server.last_version,
            'url': server.url
        }
    else:
        # Multiple servers
        online_count = 0
        offline_count = 0
        all_server_statuses = []
        servers_by_service = {}
        
        for server in all_servers:
            status = {
                'server_id': server.id,
                'name': server.server_nickname,
                'service_type': server.service_type.value,
                'online': server.last_status,
                'last_check_time': server.last_status_check,
                'error_message': server.last_status_error,
                'version': server.last_version,
                'url': server.url,
                'actual_server_name': server.server_name
            }
            
            if server.last_status is True:
                online_count += 1
            elif server.last_status is False:
                offline_count += 1
            # None status (never checked) doesn't count as online or offline
            
            all_server_statuses.append(status)
            
            # Group by service type for modal
            service_type = server.service_type.value
            if service_type not in servers_by_service:
                servers_by_service[service_type] = {
                    'service_name': service_type.title(),
                    'servers': [],
                    'online_count': 0,
                    'offline_count': 0,
                    'total_count': 0
                }
            
            servers_by_service[service_type]['servers'].append(status)
            servers_by_service[service_type]['total_count'] += 1
            
            if server.last_status is True:
                servers_by_service[service_type]['online_count'] += 1
            elif server.last_status is False:
                servers_by_service[service_type]['offline_count'] += 1
        
        return {
            'multi_server': True,
            'online_count': online_count,
            'offline_count': offline_count,
            'all_statuses': all_server_statuses,
            'servers_by_service': servers_by_service
        }

def get_fresh_server_status():
    """Fetch fresh server status data from all servers - NO CACHING"""
    current_app.logger.info("API: get_fresh_server_status() called - fetching real-time server status")
    all_servers = MediaServiceManager.get_all_servers(active_only=True)
    server_count = len(all_servers)
    current_app.logger.debug(f"API: Found {server_count} servers to check status")
    server_status_data = {}

    if server_count == 1:
        server = all_servers[0]
        current_app.logger.warning(f"API: Making API call to single server '{server.server_nickname}' ({server.service_type.value})")
        service = MediaServiceFactory.create_service_from_db(server)
        if service:
            server_status_data = service.get_server_info()
            # The service returns 'name' field with the server's actual friendly name (e.g., "Plex+")
            # Save this as 'friendly_name' for the template
            actual_server_name = server_status_data.get('name', server.server_nickname)
            # Update server status in database
            server.last_status_check = datetime.utcnow()
            server.last_status = server_status_data.get('online')
            server.last_status_error = server_status_data.get('error_message') if not server_status_data.get('online') else None
            server.last_version = server_status_data.get('version') if server_status_data.get('online') else server.last_version
            server.server_name = actual_server_name if server_status_data.get('online') else server.server_name
            db.session.add(server)
            
            try:
                db.session.commit()
                current_app.logger.debug("API: Single server status update committed to database")
            except Exception as e:
                current_app.logger.error(f"API: Error committing single server status update: {e}")
                db.session.rollback()
            
            server_status_data['server_id'] = server.id
            server_status_data['name'] = f"{server.service_type.value.title()} Server Status"
            server_status_data['service_type'] = server.service_type.value
            server_status_data['friendly_name'] = actual_server_name
            server_status_data['last_check_time'] = server.last_status_check
            current_app.logger.debug(f"API: Single server status: {server_status_data.get('online', 'unknown')}")
    elif server_count > 1:
        online_count = 0
        offline_count = 0
        all_server_statuses = []
        servers_by_service = {}
        
        current_app.logger.warning(f"API: Making API calls to {len(all_servers)} servers for status check")
        for server in all_servers:
            current_app.logger.warning(f"API: Making API call to server '{server.server_nickname}' ({server.service_type.value}) at {server.url}")
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                status = service.get_server_info()
                current_app.logger.info(f"API: Server '{server.server_nickname}' status: {status.get('online', 'unknown')} - Error: {status.get('error_message', 'None')}")
                current_app.logger.debug(f"API: Server '{server.server_nickname}' status: {status.get('online', 'unknown')}")
                
                # Extract the actual server name BEFORE overriding the 'name' field
                actual_server_name = status.get('name', server.server_nickname)
                
                # Update server status in database
                server.last_status_check = datetime.utcnow()
                server.last_status = status.get('online')
                server.last_status_error = status.get('error_message') if not status.get('online') else None
                server.last_version = status.get('version') if status.get('online') else server.last_version
                server.server_name = actual_server_name if status.get('online') else server.server_name
                db.session.add(server)
                
                status['server_id'] = server.id
                status['custom_name'] = server.server_nickname  # Custom nickname from app
                status['actual_server_name'] = actual_server_name  # Actual server name from service
                status['name'] = server.server_nickname  # Override with custom name for backward compatibility
                status['service_type'] = server.service_type.value
                all_server_statuses.append(status)
                
                # Group by service type for categorized display
                service_type = server.service_type.value
                if service_type not in servers_by_service:
                    servers_by_service[service_type] = {
                        'service_name': service_type.title(),
                        'servers': [],
                        'online_count': 0,
                        'offline_count': 0,
                        'total_count': 0
                    }
                
                servers_by_service[service_type]['servers'].append(status)
                servers_by_service[service_type]['total_count'] += 1
                
                if status.get('online'):
                    online_count += 1
                    servers_by_service[service_type]['online_count'] += 1
                else:
                    offline_count += 1
                    servers_by_service[service_type]['offline_count'] += 1
                    
        # Commit all status updates to database
        try:
            db.session.commit()
            current_app.logger.debug("API: Server status updates committed to database")
        except Exception as e:
            current_app.logger.error(f"API: Error committing server status updates: {e}")
            db.session.rollback()
        
        server_status_data = {
            'multi_server': True,
            'online_count': online_count,
            'offline_count': offline_count,
            'all_statuses': all_server_statuses,
            'servers_by_service': servers_by_service
        }
    
    return server_status_data

# Server status cache functions removed - now using real-time data

# =============================================================================
# SYSTEM HEALTH
# =============================================================================

@bp.route('/health')
def health_check():
    """Health check endpoint for Docker HEALTHCHECK."""
    return jsonify(status="ok"), 200

# =============================================================================
# SETTINGS API
# =============================================================================

@bp.route('/settings/session-monitoring-interval')
@login_required
def get_session_monitoring_interval():
    """Get the current session monitoring interval setting"""
    # Add comprehensive logging
    raw_setting = Setting.get('SESSION_MONITORING_INTERVAL_SECONDS', 30)
    
    try:
        interval = int(raw_setting)
    except (ValueError, TypeError) as e:
        current_app.logger.warning(f"API: Failed to convert '{raw_setting}' to int: {e}, using default 30")
        interval = 30
    
    return jsonify({'interval': interval})

@bp.route('/settings/navbar-stream-badge-status')
@login_required
def get_navbar_stream_badge_status():
    """Get the current navbar stream badge setting"""
    enabled = Setting.get_bool('ENABLE_NAVBAR_STREAM_BADGE', False)
    return jsonify({'enabled': enabled})

# =============================================================================
# SERVERS API
# =============================================================================

@bp.route('/servers/<int:server_id>/status', methods=['POST'])
@login_required
@csrf.exempt
def check_server_status(server_id):
    """Check and return server status"""
    current_app.logger.debug(f"Api.py - check_server_status(): HTMX call received for server_id {server_id}. Forcing connection check.")
    
    server = MediaServiceManager.get_server_by_id(server_id)
    if not server:
        abort(404)

    service = MediaServiceFactory.create_service_from_db(server)
    if not service:
        abort(503)
    
    # Force a reconnect attempt
    service._get_server_instance(force_reconnect=True) 
    
    # Then, retrieve the status that was just updated by the call above.
    server_status_for_htmx = service.get_server_info()
    current_app.logger.debug(f"Api.py - check_server_status(): Status after forced check: {server_status_for_htmx}")
            
    # Render the partial template with the fresh status data.
    # We need to format this as a single server status for the multi_service_status template
    # Use the same logic as get_fresh_server_status for consistency
    actual_server_name = server_status_for_htmx.get('name', server.server_nickname)
    server_status_data = {
        'server_id': server.id,
        'service_type': server.service_type.value,
        'name': f"{server.service_type.value.title()} Server Status",
        'online': server_status_for_htmx.get('online', False),
        'friendly_name': actual_server_name,
        'version': server_status_for_htmx.get('version'),
        'error_message': server_status_for_htmx.get('error_message'),
        'last_check_time': None,  # Don't show last check time since it's always "just now"
        'multi_server': False
    }
    return render_template('dashboard/_partials/multi_service_status.html', server_status=server_status_data)

@bp.route('/dashboard/server-status', methods=['GET'])
@login_required
def get_dashboard_server_status():
    """Get server status for dashboard - loads asynchronously with real-time data"""
    current_app.logger.info("=== API ENDPOINT: /dashboard/server-status called ===")
    current_app.logger.debug("Api.py - get_dashboard_server_status(): Loading real-time server status for dashboard")
    
    # Get fresh server status data and save to database
    server_status_data = get_fresh_server_status()
    current_app.logger.info(f"DASHBOARD CARD: Online={server_status_data.get('online_count', 'N/A')}, Offline={server_status_data.get('offline_count', 'N/A')}")
    current_app.logger.debug(f"Api.py - get_dashboard_server_status(): Fresh server status: {server_status_data}")

    return render_template('dashboard/_partials/multi_service_status.html', server_status=server_status_data)

@bp.route('/dashboard/all-servers-modal', methods=['GET'])
@login_required
def get_all_servers_modal():
    """Get all servers status for modal - uses cached data if available"""
    current_app.logger.info("=== API ENDPOINT: /dashboard/all-servers-modal called ===")
    current_app.logger.debug("Api.py - get_all_servers_modal(): Loading server status for modal")
    
    # Use stored database status (same as dashboard card)
    server_status_data = get_stored_server_status()
    current_app.logger.info(f"MODAL: Online={server_status_data.get('online_count', 'N/A')}, Offline={server_status_data.get('offline_count', 'N/A')}")
    current_app.logger.debug(f"Api.py - get_all_servers_modal(): Server status for modal: {server_status_data}")

    return render_template('components/modals/all_servers_status_modal_content.html', server_status=server_status_data)

@bp.route('/dashboard/active-streams-count', methods=['GET'])
@login_required
def get_active_streams_count():
    """Get active streams count for dashboard - real-time data, no caching"""
    current_app.logger.info("=== API ENDPOINT: /dashboard/active-streams-count called ===")
    current_app.logger.debug("Api.py - get_active_streams_count(): Loading real-time active streams count")
    
    active_streams_count = 0
    try:
        current_app.logger.info("API: Fetching real-time active sessions from all servers")
        active_sessions_list = MediaServiceManager.get_all_active_sessions()
        if active_sessions_list:
            active_streams_count = len(active_sessions_list)
        current_app.logger.debug(f"API: Real-time active streams count: {active_streams_count}")
    except Exception as e:
        current_app.logger.error(f"API: Failed to get active streams count: {e}")
    
    # Return the card content HTML
    return f'''
    <div class="flex flex-row gap-3 items-center">
        <div class="p-3 rounded-md bg-accent/20 text-accent"><i class="fa-solid fa-tower-broadcast fa-2x"></i></div>
        <div class="flex flex-col">
            <p class="text-base-content/70">Active Streams</p>
            <h2 class="card-title text-2xl">{active_streams_count}</h2>
        </div>
    </div>
    <div class="card-actions justify-end w-full mt-2"><span class="text-xs text-accent group-hover:underline">View Streams <i class="fa-solid fa-arrow-right fa-xs ml-1"></i></span></div>
    '''

@bp.route('/servers/<int:server_id>/libraries', methods=['GET'])
@login_required
def get_server_libraries(server_id):
    """Get libraries for a specific server from database (fast)"""
    current_app.logger.info(f"API: get_server_libraries called for server_id={server_id}")
    server = MediaServiceManager.get_server_by_id(server_id)
    if not server:
        # Log available servers for debugging
        all_servers = MediaServiceManager.get_all_servers()
        available_server_ids = [s.id for s in all_servers]
        current_app.logger.error(f"API: Server {server_id} not found. Available server IDs: {available_server_ids}")
        return jsonify({
            'error': f'Server {server_id} not found',
            'available_server_ids': available_server_ids
        }), 404
    
    try:
        from app.models_media_services import MediaLibrary
        
        # Load libraries from database (much faster than API calls)
        db_libraries = MediaLibrary.query.filter_by(server_id=server_id).all()
        
        libraries = []
        for lib in db_libraries:
            lib_data = {
                'id': lib.external_id,
                'external_id': lib.external_id,
                'name': lib.name,
                'type': lib.library_type or 'unknown',
                'item_count': lib.item_count or 0
            }
            
            # For Kavita servers, include internal_id for UUID handling
            if server.service_type.value == 'kavita' and hasattr(lib, 'internal_id') and lib.internal_id:
                lib_data['internal_id'] = lib.internal_id
                
            libraries.append(lib_data)
        
        current_app.logger.info(f"Loaded {len(libraries)} libraries from database for server {server.server_nickname}")
        
        return jsonify({
            'success': True, 
            'libraries': libraries,
            'service_type': server.service_type.name.upper(),
            'server_name': server.server_nickname,
            'source': 'database'
        })
    except Exception as e:
        current_app.logger.error(f"Error getting libraries from database for server {server_id}: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@bp.route('/servers/<int:server_id>/libraries/refresh', methods=['POST'])
@login_required
@csrf.exempt
def refresh_server_libraries(server_id):
    """Refresh libraries for a specific server from live API"""
    server = MediaServiceManager.get_server_by_id(server_id)
    if not server:
        return jsonify({'error': 'Server not found'}), 404
    
    service = MediaServiceFactory.create_service_from_db(server)
    if not service:
        return jsonify({'error': 'Service not available'}), 503
    
    try:
        # Get fresh libraries from live API
        libraries = service.get_libraries()
        
        # Ensure each library has both 'id' and 'external_id' for compatibility
        for lib in libraries:
            if 'external_id' in lib and 'id' not in lib:
                lib['id'] = lib['external_id']
        
        # For Kavita servers, also add internal_id from database if available
        if server.service_type.value == 'kavita':
            from app.models_media_services import MediaLibrary
            db_libraries = MediaLibrary.query.filter_by(server_id=server_id).all()
            db_lib_map = {lib.external_id: lib.internal_id for lib in db_libraries if lib.internal_id}
            
            for lib in libraries:
                external_id = lib.get('external_id') or lib.get('id')
                if external_id and external_id in db_lib_map:
                    lib['internal_id'] = db_lib_map[external_id]
        
        current_app.logger.info(f"Refreshed {len(libraries)} libraries from live API for server {server.server_nickname}")
        
        return jsonify({
            'success': True, 
            'libraries': libraries,
            'service_type': server.service_type.name.upper(),
            'server_name': server.server_nickname,
            'source': 'live_api'
        })
    except Exception as e:
        current_app.logger.error(f"Error refreshing libraries from API for server {server_id}: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@bp.route('/servers/test', methods=['POST'])
@csrf.exempt
def test_new_server():
    """Test connection to a new server"""
    # Allow during setup, but require auth after setup is complete
    if not current_user.is_authenticated:
        try:
            admin_exists = User.get_owner() is not None
            if admin_exists:
                return jsonify({'success': False, 'message': 'Authentication required'}), 401
        except:
            pass  # Database might not be ready yet
    
    data = request.get_json()
    if not data:
        return jsonify({'success': False, 'message': 'No data provided'}), 400
    
    try:
        service = MediaServiceFactory.create_service(data)
        if not service:
            return jsonify({'success': False, 'message': 'Unsupported service type'}), 400
        
        success, message = service.test_connection()
        return jsonify({'success': success, 'message': message})
    except Exception as e:
        current_app.logger.error(f"Error testing new server: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@bp.route('/servers/<int:server_id>/test', methods=['POST'])
@login_required
@csrf.exempt
def test_existing_server(server_id):
    """Test connection to an existing server"""
    result = MediaServiceManager.test_server_connection(server_id)
    return jsonify(result)

@bp.route('/servers/<int:server_id>/sync/libraries', methods=['POST'])
@login_required
@csrf.exempt
def sync_server_libraries(server_id):
    """Sync libraries for a server"""
    try:
        current_app.logger.debug(f"Starting server sync for server_id: {server_id}")
        result = MediaServiceManager.sync_server_libraries(server_id)
        current_app.logger.debug(f"Server sync result: {result}")
        
        if result.get('success'):
            current_app.logger.debug(f"Server sync successful, processing response...")
            # Get server name for the message
            from app.models_media_services import MediaServer
            server = MediaServer.query.get(server_id)
            server_name = server.server_nickname if server else f"Server {server_id}"
            
            # Create success message
            added = result.get('added', 0)
            updated = result.get('updated', 0)
            removed = result.get('removed', 0)
            # Handle different error field formats - be very defensive
            errors = 0
            error_messages = []
            try:
                errors = result.get('errors', result.get('error_count', 0))
                if not isinstance(errors, (int, float)):
                    errors = 0
                error_messages = result.get('error_messages', [])
                if not isinstance(error_messages, list):
                    error_messages = []
            except Exception as e:
                current_app.logger.warning(f"Error accessing error fields: {e}")
                errors = 0
                error_messages = []
            
            # Check if there are any changes to determine response type
            has_changes = (added > 0 or updated > 0 or removed > 0 or errors > 0 or len(error_messages) > 0)
            
            if has_changes:
                # Ensure the result has all expected fields for the template
                template_result = {
                    'success': result.get('success', True),
                    'servers_synced': 1,
                    'libraries_added': added,
                    'libraries_updated': updated,
                    'libraries_removed': removed,
                    'errors': errors,
                    'error_messages': error_messages,
                    'added_libraries': [],
                    'updated_libraries': [],
                    'removed_libraries': []
                }
                
                # Add detailed library information for display
                if updated > 0:
                    # Get the actual updated libraries from the result
                    updated_libs = result.get('updated_libraries', [])
                    if updated_libs:
                        # Use the detailed library information
                        template_result['updated_libraries'] = updated_libs
                    else:
                        # Fallback to generic message if no details available
                        template_result['updated_libraries'] = [{
                            'name': f"{server_name} Libraries",
                            'server_name': server_name,
                            'changes': [f"Updated {updated} libraries"]
                        }]
                
                # Add added libraries if any
                if added > 0:
                    added_libs = result.get('added_libraries', [])
                    if added_libs:
                        template_result['added_libraries'] = added_libs
                    else:
                        template_result['added_libraries'] = [{
                            'name': f"{server_name} Libraries",
                            'server_name': server_name,
                            'changes': [f"Added {added} libraries"]
                        }]
                
                # Add removed libraries if any
                if removed > 0:
                    removed_libs = result.get('removed_libraries', [])
                    if removed_libs:
                        template_result['removed_libraries'] = removed_libs
                    else:
                        template_result['removed_libraries'] = [{
                            'name': f"{server_name} Libraries",
                            'server_name': server_name,
                            'changes': [f"Removed {removed} libraries"]
                        }]
                
                # Show modal for changes or errors
                modal_html = render_template('libraries/_partials/server_sync_results_modal.html',
                                           sync_result=result,
                                           server_name=server_name)
                
                if errors > 0 or len(error_messages) > 0:
                    error_count = errors if errors > 0 else len(error_messages)
                    message = f"{server_name}: Sync completed with {error_count} errors. See details."
                    category = "warning"
                else:
                    message = f"{server_name}: {added} added, {updated} updated, {removed} removed."
                    category = "success"
                
                trigger_payload = {
                    "showToastEvent": {"message": message, "category": category},
                    "openLibrarySyncResultsModal": True,
                    "refreshLibrariesPage": True
                }
                headers = {
                    'HX-Retarget': '#librarySyncResultModalContainer',
                    'HX-Reswap': 'innerHTML',
                    'HX-Trigger-After-Swap': json.dumps(trigger_payload)
                }
                return make_response(modal_html, 200, headers)
            else:
                # No changes - just show toast
                current_app.logger.debug(f"No changes for server {server_name}, returning toast-only response")
                trigger_payload = {
                    "showToastEvent": {
                        "message": f"{server_name}: No changes were made.",
                        "category": "success"
                    }
                }
                headers = {
                    'HX-Trigger': json.dumps(trigger_payload)
                }
                current_app.logger.debug(f"Returning empty response with headers: {headers}")
                # Return empty response with just the toast trigger
                response = make_response("", 200, headers)
                current_app.logger.debug(f"Response created successfully")
                return response
        else:
            # Handle error case
            error_message = result.get('message', 'Unknown error')
            trigger_payload = {
                "showToastEvent": {
                    "message": f"Server sync failed: {error_message}",
                    "category": "error"
                }
            }
            headers = {
                'HX-Trigger': json.dumps(trigger_payload)
            }
            return make_response("", 500, headers)
            
    except Exception as e:
        current_app.logger.error(f"Error in server sync endpoint: {e}")
        
        # Return error response
        trigger_payload = {
            "showToastEvent": {
                "message": f"Server sync failed: {str(e)}",
                "category": "error"
            }
        }
        headers = {
            'HX-Trigger': json.dumps(trigger_payload)
        }
        return make_response("", 500, headers)

@bp.route('/servers/<int:server_id>/sync/users', methods=['POST'])
@login_required
@csrf.exempt
def sync_server_users(server_id):
    """Sync users for a server"""
    result = MediaServiceManager.sync_server_users(server_id)
    return jsonify(result)

@bp.route('/libraries/<int:library_id>/sync', methods=['POST'])
@login_required
@csrf.exempt
def sync_library_content(library_id):
    """Sync content for a specific library"""
    try:
        from app.services.media_sync_service import MediaSyncService
        from app.models_media_services import MediaLibrary
        import time
        
        # Check if library exists
        library = MediaLibrary.query.get(library_id)
        if not library:
            return jsonify({'success': False, 'error': 'Library not found'}), 404
        
        current_app.logger.info(f"Starting library content sync for: {library.name}")
        start_time = time.time()
        
        # Perform the sync
        result = MediaSyncService.sync_library_content(library_id)
        end_time = time.time()
        duration = end_time - start_time
        
        if result['success']:
            current_app.logger.info(f"Library content sync completed successfully")
            current_app.logger.debug(f"Full sync result keys: {list(result.keys())}")
            
            # Add duration to result
            result['duration'] = duration
            
            # Check if there are any changes to determine response type
            # Use the count values, not the list values
            added = result.get('added', 0)
            updated = result.get('updated', 0)
            removed = result.get('removed', 0)
            
            # Debug logging to identify the issue
            current_app.logger.debug(f"SYNC RESULT: added={added} (type: {type(added)})")
            current_app.logger.debug(f"SYNC RESULT: updated={updated} (type: {type(updated)})")
            current_app.logger.debug(f"SYNC RESULT: removed={removed} (type: {type(removed)})")
            current_app.logger.debug(f"SYNC RESULT: errors={result.get('errors')} (type: {type(result.get('errors'))})")
            current_app.logger.debug(f"SYNC RESULT: total_items={result.get('total_items', 'NOT_SET')}")
            
            try:
                errors_list = result.get('errors', [])
                current_app.logger.debug(f"SYNC RESULT: errors_list = {errors_list} (type: {type(errors_list)})")
                current_app.logger.debug(f"SYNC RESULT: len(errors_list) = {len(errors_list)}")
                
                # Break down the logic step by step
                added_check = added > 0
                updated_check = updated > 0
                removed_check = removed > 0
                errors_check = bool(errors_list and len(errors_list) > 0)
                
                current_app.logger.debug(f"SYNC RESULT: added_check = {added_check}")
                current_app.logger.debug(f"SYNC RESULT: updated_check = {updated_check}")
                current_app.logger.debug(f"SYNC RESULT: removed_check = {removed_check}")
                current_app.logger.debug(f"SYNC RESULT: errors_check = {errors_check}")
                
                has_changes = added_check or updated_check or removed_check or errors_check
                current_app.logger.debug(f"SYNC RESULT: has_changes = {has_changes} (type: {type(has_changes)})")
            except Exception as e:
                current_app.logger.debug(f"Error in has_changes comparison: {e}")
                current_app.logger.debug(f"Full result data: {result}")
                raise
            
            if has_changes:
                # Return JSON response for React frontend
                current_app.logger.debug(f"Library sync has changes, returning JSON response")

                # Create success message
                if result.get('errors') and len(result.get('errors', [])) > 0:
                    message = f"Library sync completed with {len(result.get('errors', []))} errors. See details."
                else:
                    message = f"Library sync complete. {added} added, {updated} updated, {removed} removed."

                return jsonify({
                    'success': True,
                    'message': message,
                    'result': result
                })
            else:
                # No changes - return JSON response
                current_app.logger.debug("Taking NO CHANGES path - returning JSON")
                total_items = result.get('total_items', 0)

                return jsonify({
                    'success': True,
                    'message': f"Library sync complete. No changes were made to {total_items} items.",
                    'result': result
                })
        else:
            current_app.logger.error(f"Library sync failed: {result.get('error', 'Unknown error')}")

            # Return JSON error response
            return jsonify({
                'success': False,
                'error': result.get('error', 'Unknown error')
            }), 500

    except Exception as e:
        current_app.logger.error(f"Error in library sync endpoint: {e}")

        # Return JSON error response
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@bp.route('/libraries/<int:library_id>/purge', methods=['POST'])
@login_required
@csrf.exempt
def purge_library_content(library_id):
    """Purge all cached media items for a specific library from the database"""
    try:
        from app.models_media_services import MediaLibrary, MediaItem
        
        # Check if library exists
        library = MediaLibrary.query.get(library_id)
        if not library:
            return jsonify({'success': False, 'error': 'Library not found'}), 404
        
        current_app.logger.info(f"Starting library purge for: {library.name}")
        
        # Count items before deletion
        item_count = MediaItem.query.filter_by(library_id=library_id).count()
        
        # Delete all media items for this library
        deleted_count = MediaItem.query.filter_by(library_id=library_id).delete()
        
        # Commit the changes
        db.session.commit()
        
        current_app.logger.info(f"Library purge completed: deleted {deleted_count} items from {library.name}")
        
        return jsonify({
            'success': True,
            'deleted_count': deleted_count,
            'library_name': library.name,
            'message': f'Successfully purged {deleted_count} items from library {library.name}'
        })
        
    except Exception as e:
        current_app.logger.error(f"Error in library purge endpoint: {e}")
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500

# =============================================================================
# MEDIA SERVICES API
# =============================================================================

@bp.route('/media/plex/images/proxy')
@login_required
def plex_image_proxy():
    """Proxy Plex images through the application"""
    image_path_on_plex = request.args.get('path')
    if not image_path_on_plex:
        current_app.logger.warning("API plex_image_proxy: 'path' parameter is missing.")
        abort(400)

    plex_servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX)
    if not plex_servers:
        current_app.logger.error("API plex_image_proxy: No Plex servers found.")
        abort(503)
    
    # Use the first active Plex server
    plex_service = MediaServiceFactory.create_service_from_db(plex_servers[0])
    if not plex_service:
        current_app.logger.error("API plex_image_proxy: Could not get Plex instance to proxy image.")
        abort(503)

    try:
        # Ensure the path for plex.url starts with a '/' if it's meant to be from the server root
        path_for_plexapi = image_path_on_plex
        if not path_for_plexapi.startswith('/'):
            path_for_plexapi = '/' + path_for_plexapi
        
        plex = plex_service._get_server_instance()
        full_authed_plex_image_url = plex.url(path_for_plexapi, includeToken=True)
        
        # current_app.logger.debug(f"API plex_image_proxy: Corrected path for plex.url(): {path_for_plexapi}")
        # current_app.logger.debug(f"API plex_image_proxy: Fetching image from Plex URL: {full_authed_plex_image_url}")

        plex_timeout = current_app.config.get('PLEX_TIMEOUT', 10)
        
        img_response = plex._session.get(full_authed_plex_image_url, stream=True, timeout=plex_timeout)
        img_response.raise_for_status()

        content_type = img_response.headers.get('Content-Type', 'image/jpeg')
        return Response(img_response.iter_content(chunk_size=1024*8), content_type=content_type)

    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(f"API plex_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Plex: {e_http} for path {image_path_on_plex}")
        abort(e_http.response.status_code)
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API plex_image_proxy: RequestException fetching from Plex: {e_req} for path {image_path_on_plex}")
        abort(500)
    except Exception as e:
        current_app.logger.error(f"API plex_image_proxy: Unexpected error for path {image_path_on_plex}: {e}", exc_info=True)
        abort(500)

@bp.route('/media/jellyfin/images/proxy')
@login_required
def jellyfin_image_proxy():
    """Proxy Jellyfin images through the application"""
    item_id = request.args.get('item_id')
    image_type = request.args.get('image_type', 'Primary')
    image_tag = request.args.get('image_tag')
    
    #current_app.logger.info(f"API jellyfin_image_proxy: Received request for item_id='{item_id}', image_type='{image_type}'")
    
    if not item_id:
        current_app.logger.warning("API jellyfin_image_proxy: 'item_id' parameter is missing.")
        return "Missing item_id parameter", 400

    try:
        jellyfin_servers = MediaServiceManager.get_servers_by_type(ServiceType.JELLYFIN, active_only=True)
        
        if not jellyfin_servers:
            current_app.logger.error("API jellyfin_image_proxy: No Jellyfin servers found.")
            return "No Jellyfin servers available", 404

        jellyfin_server = jellyfin_servers[0]  # Use first available server
        #current_app.logger.info(f"API jellyfin_image_proxy: Using Jellyfin server: {jellyfin_server.server_nickname} at {jellyfin_server.url}")
        
        jellyfin_service = MediaServiceFactory.create_service_from_db(jellyfin_server)
        
        if not jellyfin_service:
            current_app.logger.error("API jellyfin_image_proxy: Could not get Jellyfin instance to proxy image.")
            return "Could not connect to Jellyfin", 500

        # Construct Jellyfin image URL
        jellyfin_image_url = f"{jellyfin_server.url.rstrip('/')}/Items/{item_id}/Images/{image_type}"
        if image_tag:
            jellyfin_image_url = f"{jellyfin_image_url}?tag={image_tag}"
        
        #current_app.logger.info(f"API jellyfin_image_proxy: Fetching image from Jellyfin URL: {jellyfin_image_url}")

        # Make request with authentication headers
        headers = {
            'X-Emby-Token': jellyfin_server.api_key,
        }
        #current_app.logger.info(f"API jellyfin_image_proxy: Using API key: {jellyfin_server.api_key[:8]}...")
        
        timeout = get_api_timeout()
        img_response = requests.get(jellyfin_image_url, headers=headers, stream=True, timeout=timeout)
        img_response.raise_for_status()

        content_type = img_response.headers.get('Content-Type', 'image/jpeg')
        
        return Response(img_response.content, content_type=content_type)

    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(f"API jellyfin_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Jellyfin: {e_http} for item {item_id}")
        return f"HTTP error fetching image: {e_http.response.status_code}", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API jellyfin_image_proxy: RequestException fetching from Jellyfin: {e_req} for item {item_id}")
        return "Network error fetching image", 500
    except Exception as e:
        current_app.logger.error(f"API jellyfin_image_proxy: Unexpected error for item {item_id}: {e}", exc_info=True)
        return "Error fetching image", 500

@bp.route('/media/romm/images/proxy')
@login_required
def romm_image_proxy():
    """Proxy images from RomM servers with authentication"""
    image_path = request.args.get('path')
    server_id = request.args.get('server_id')
    
    if not image_path:
        current_app.logger.warning("API romm_image_proxy: 'path' parameter is missing.")
        return "Missing path parameter", 400
    
    if not server_id:
        current_app.logger.warning("API romm_image_proxy: 'server_id' parameter is missing.")
        return "Missing server_id parameter", 400
    
    try:
        # Get the specific RomM server
        from app.models_media_services import MediaServer, ServiceType
        romm_server = MediaServer.query.filter_by(id=server_id, service_type=ServiceType.ROMM).first()
        
        if not romm_server:
            current_app.logger.error("API romm_image_proxy: RomM server not found.")
            return "RomM server not found", 404
        
        # Create RomM service instance
        from app.services.media_service_factory import MediaServiceFactory
        romm_service = MediaServiceFactory.create_service_from_db(romm_server)
        
        if not romm_service:
            current_app.logger.error("API romm_image_proxy: Could not get RomM instance to proxy image.")
            return "Could not connect to RomM", 500
        
        # Setup authentication and make request
        if not romm_service._setup_auth_headers():
            current_app.logger.error("API romm_image_proxy: Failed to setup authentication.")
            return "Authentication failed", 500
        
        # Construct full image URL
        full_image_url = f"{romm_server.url.rstrip('/')}{image_path}"
        
        # Fetch image with authentication
        response = romm_service.session.get(full_image_url)
        response.raise_for_status()
        
        # Return image with proper content type
        content_type = response.headers.get('content-type', 'image/jpeg')
        return Response(response.content, content_type=content_type)
        
    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(f"API romm_image_proxy: HTTPError ({e_http.response.status_code}) fetching from RomM: {e_http} for path {image_path}")
        return "Error fetching image from RomM", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API romm_image_proxy: RequestException fetching from RomM: {e_req} for path {image_path}")
        return "Error connecting to RomM", 500
    except Exception as e:
        current_app.logger.error(f"API romm_image_proxy: Unexpected error for path {image_path}: {e}", exc_info=True)
        return "Error fetching image", 500

@bp.route('/media/komga/images/proxy')
@login_required
def komga_image_proxy():
    """Proxy images from Komga servers with authentication"""
    series_id = request.args.get('series_id')
    book_id = request.args.get('book_id')
    server_id = request.args.get('server_id')
    
    if not series_id and not book_id:
        current_app.logger.warning("API komga_image_proxy: Either 'series_id' or 'book_id' parameter is required.")
        return "Missing series_id or book_id parameter", 400
    
    if not server_id:
        current_app.logger.warning("API komga_image_proxy: 'server_id' parameter is missing.")
        return "Missing server_id parameter", 400
    
    try:
        # Get the specific Komga server
        from app.models_media_services import MediaServer, ServiceType
        komga_server = MediaServer.query.filter_by(id=server_id, service_type=ServiceType.KOMGA).first()
        
        if not komga_server:
            current_app.logger.error("API komga_image_proxy: Komga server not found.")
            return "Komga server not found", 404
        
        # Create Komga service instance
        from app.services.media_service_factory import MediaServiceFactory
        komga_service = MediaServiceFactory.create_service_from_db(komga_server)
        
        if not komga_service:
            current_app.logger.error("API komga_image_proxy: Could not get Komga instance to proxy image.")
            return "Could not connect to Komga", 500
        
        # Construct thumbnail URL based on type
        if series_id:
            thumbnail_url = f"{komga_server.url.rstrip('/')}/api/v1/series/{series_id}/thumbnail"
        else:  # book_id
            thumbnail_url = f"{komga_server.url.rstrip('/')}/api/v1/books/{book_id}/thumbnail"
        
        # Get headers with authentication
        headers = komga_service._get_headers()
        
        # Fetch image with authentication
        import requests
        response = requests.get(thumbnail_url, headers=headers)
        response.raise_for_status()
        
        # Return image with proper content type
        content_type = response.headers.get('content-type', 'image/jpeg')
        return Response(response.content, content_type=content_type)
        
    except requests.exceptions.HTTPError as e_http:
        item_id = series_id or book_id
        current_app.logger.error(f"API komga_image_proxy: HTTPError ({e_http.response.status_code}) fetching from Komga: {e_http} for item {item_id}")
        return "Error fetching image from Komga", e_http.response.status_code
    except requests.exceptions.RequestException as e_req:
        item_id = series_id or book_id
        current_app.logger.error(f"API komga_image_proxy: RequestException fetching from Komga: {e_req} for item {item_id}")
        return "Error connecting to Komga", 500
    except Exception as e:
        item_id = series_id or book_id
        current_app.logger.error(f"API komga_image_proxy: Unexpected error for item {item_id}: {e}", exc_info=True)
        return "Error fetching image", 500

@bp.route('/media/audiobookshelf/images/proxy')
@login_required
def audiobookshelf_image_proxy():
    """Proxy AudioBookshelf images through the application"""
    image_path = request.args.get('path')
    current_app.logger.info(f"API audiobookshelf_image_proxy: Called with path='{image_path}'")
    
    if not image_path:
        current_app.logger.warning("API audiobookshelf_image_proxy: 'path' parameter is missing.")
        abort(400)

    audiobookshelf_servers = MediaServiceManager.get_servers_by_type(ServiceType.AUDIOBOOKSHELF)
    if not audiobookshelf_servers:
        current_app.logger.error("API audiobookshelf_image_proxy: No AudioBookshelf servers found.")
        abort(503)
    
    # Use the first active AudioBookshelf server
    abs_service = MediaServiceFactory.create_service_from_db(audiobookshelf_servers[0])
    if not abs_service:
        current_app.logger.error("API audiobookshelf_image_proxy: Could not get AudioBookshelf instance to proxy image.")
        abort(503)

    try:
        # AudioBookshelf image URLs are typically /api/items/{id}/cover
        # The path parameter should be something like "items/{id}/cover"
        if not image_path.startswith('/'):
            image_path = '/' + image_path
        
        # Build the full URL to the AudioBookshelf server
        full_image_url = f"{abs_service.url.rstrip('/')}/api{image_path}"
        
        current_app.logger.debug(f"API audiobookshelf_image_proxy: Fetching image from AudioBookshelf URL: {full_image_url}")
        
        # If first attempt fails, try alternative endpoints
        alternative_urls = []
        
        if image_path.startswith('items/'):
            # Extract item ID for AudioBookshelf specific endpoints
            item_id = image_path.split('/')[1] if '/' in image_path else image_path.replace('items/', '')
            
            # AudioBookshelf specific endpoint variations
            alternative_urls.extend([
                f"{abs_service.url.rstrip('/')}/api/items/{item_id}/cover",  # Standard cover endpoint
                f"{abs_service.url.rstrip('/')}/api/items/{item_id}/thumbnail",  # Thumbnail endpoint
                f"{abs_service.url.rstrip('/')}/feed/{item_id}/cover",  # Feed cover endpoint
                f"{abs_service.url.rstrip('/')}/api/items/{item_id}/image",  # Generic image endpoint
                f"{abs_service.url.rstrip('/')}/{image_path}",  # Without /api prefix
                f"{abs_service.url.rstrip('/')}/api/{image_path.replace('/cover', '/cover.jpg')}",  # With .jpg extension
                f"{abs_service.url.rstrip('/')}/api/{image_path.replace('/cover', '/cover.png')}",  # With .png extension
            ])
        else:
            # Direct file path - serve as static file
            alternative_urls.extend([
                f"{abs_service.url.rstrip('/')}/{image_path}",  # Direct file path
                f"{abs_service.url.rstrip('/')}/s/{image_path}",  # Static file endpoint
            ])

        headers = abs_service._get_headers()
        timeout = get_api_timeout()
        
        # Try the primary URL first
        urls_to_try = [full_image_url] + alternative_urls
        last_error = None
        
        for i, url_to_try in enumerate(urls_to_try):
            try:
                current_app.logger.debug(f"API audiobookshelf_image_proxy: Attempt {i+1} - trying URL: {url_to_try}")
                img_response = requests.get(url_to_try, headers=headers, stream=True, timeout=timeout)
                img_response.raise_for_status()

                content_type = img_response.headers.get('Content-Type', 'image/jpeg')
                current_app.logger.info(f"API audiobookshelf_image_proxy: Success with URL: {url_to_try}")
                return Response(img_response.iter_content(chunk_size=1024*8), content_type=content_type)
                
            except requests.exceptions.HTTPError as e:
                last_error = e
                current_app.logger.debug(f"API audiobookshelf_image_proxy: Attempt {i+1} failed with {e.response.status_code}: {url_to_try}")
                continue
            except requests.exceptions.RequestException as e:
                last_error = e
                current_app.logger.debug(f"API audiobookshelf_image_proxy: Attempt {i+1} failed with RequestException: {e}")
                continue
        
        # If all attempts failed, raise the last error
        if isinstance(last_error, requests.exceptions.HTTPError):
            raise last_error
        else:
            raise last_error or Exception("All URL attempts failed")

    except requests.exceptions.HTTPError as e_http:
        current_app.logger.error(f"API audiobookshelf_image_proxy: HTTPError ({e_http.response.status_code}) fetching from AudioBookshelf: {e_http} for path {image_path}")
        abort(e_http.response.status_code)
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API audiobookshelf_image_proxy: RequestException fetching from AudioBookshelf: {e_req} for path {image_path}")
        abort(500)
    except Exception as e:
        current_app.logger.error(f"API audiobookshelf_image_proxy: Unexpected error for path {image_path}: {e}", exc_info=True)
        abort(500)

@bp.route('/media/jellyfin/users/avatar')
@login_required
def jellyfin_user_avatar_proxy():
    """Proxy Jellyfin user avatars through the application"""
    user_id = request.args.get('user_id')
    
    #current_app.logger.debug(f"API jellyfin_user_avatar_proxy: Received request for user_id='{user_id}'")
    
    if not user_id:
        current_app.logger.warning("API jellyfin_user_avatar_proxy: 'user_id' parameter is missing.")
        abort(400)

    try:
        jellyfin_servers = MediaServiceManager.get_servers_by_type(ServiceType.JELLYFIN, active_only=True)
        
        if not jellyfin_servers:
            current_app.logger.error("API jellyfin_user_avatar_proxy: No Jellyfin servers found.")
            abort(404)

        jellyfin_server = jellyfin_servers[0]  # Use first available server
        current_app.logger.debug(f"API jellyfin_user_avatar_proxy: Using Jellyfin server: {jellyfin_server.server_nickname}")
        
        # First, get user data to check if PrimaryImageTag exists
        headers = {
            'X-Emby-Token': jellyfin_server.api_key,
        }
        
        # Get user info to check for PrimaryImageTag
        user_info_url = f"{jellyfin_server.url.rstrip('/')}/Users/{user_id}"
        timeout = get_api_timeout()
        user_response = requests.get(user_info_url, headers=headers, timeout=timeout)
        user_response.raise_for_status()
        user_data = user_response.json()
        
        # Check if user has a PrimaryImageTag (avatar)
        primary_image_tag = user_data.get('PrimaryImageTag')
        if not primary_image_tag:
            current_app.logger.debug(f"API jellyfin_user_avatar_proxy: User {user_id} has no PrimaryImageTag, no avatar available")
            return '', 404
        
        # Construct Jellyfin user avatar URL with tag parameter (required for Jellyfin avatars)
        avatar_url = f"{jellyfin_server.url.rstrip('/')}/Users/{user_id}/Images/Primary?tag={primary_image_tag}&width=64&quality=90"
        
        current_app.logger.debug(f"API jellyfin_user_avatar_proxy: Fetching avatar from: {avatar_url}")

        timeout = get_api_timeout()
        img_response = requests.get(avatar_url, headers=headers, stream=True, timeout=timeout)
        img_response.raise_for_status()

        content_type = img_response.headers.get('Content-Type', 'image/jpeg')
        
        return Response(img_response.content, content_type=content_type)

    except requests.exceptions.HTTPError as e_http:
        if e_http.response.status_code == 404:
            current_app.logger.debug(f"API jellyfin_user_avatar_proxy: User {user_id} avatar not found (404)")
        else:
            current_app.logger.error(f"API jellyfin_user_avatar_proxy: HTTPError ({e_http.response.status_code}) fetching avatar for user {user_id}: {e_http}")
        abort(e_http.response.status_code)
    except requests.exceptions.RequestException as e_req:
        current_app.logger.error(f"API jellyfin_user_avatar_proxy: RequestException fetching avatar for user {user_id}: {e_req}")
        abort(500)
    except Exception as e:
        current_app.logger.error(f"API jellyfin_user_avatar_proxy: Unexpected error for user {user_id}: {e}", exc_info=True)
        abort(500)

@bp.route('/media/sessions/terminate', methods=['POST'])
@login_required
@csrf.exempt
@permission_required('kill_stream')
def terminate_session():
    """Terminate a media session (Plex, Jellyfin, etc.)"""
    session_key = request.form.get('session_key')
    service_type = request.form.get('service_type')
    server_name = request.form.get('server_name')
    message = request.form.get('message', None)

    if not session_key:
        current_app.logger.error("API terminate_session: Missing 'session_key'.")
        return jsonify(success=False, error="Session key is required."), 400

    if not service_type:
        current_app.logger.error("API terminate_session: Missing 'service_type'.")
        return jsonify(success=False, error="Service type is required."), 400

    try:
        # Get the appropriate service based on service type
        if service_type.lower() == 'plex':
            servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX)
        elif service_type.lower() == 'jellyfin':
            servers = MediaServiceManager.get_servers_by_type(ServiceType.JELLYFIN)
        else:
            return jsonify(success=False, error=f"Unsupported service type: {service_type}"), 400
        
        if not servers:
            return jsonify(success=False, error=f"{service_type} service not found."), 500
        
        # Find the specific server by name if provided, otherwise use the first one
        target_server = None
        if server_name:
            target_server = next((s for s in servers if s.server_nickname == server_name), None)
        if not target_server:
            target_server = servers[0]  # Use first available server
        
        service = MediaServiceFactory.create_service_from_db(target_server)
        if not service:
            return jsonify(success=False, error=f"{service_type} service not available."), 500

        current_app.logger.info(f"Terminating {service_type} session {session_key} on server {target_server.server_nickname}")
        success = service.terminate_session(session_key, message)
        
        if success:
            return jsonify(success=True, message=f"Termination command sent for {service_type} session {session_key}.")
        else:
            return jsonify(success=False, error=f"Failed to send termination command ({service_type} connection issue?)."), 500
            
    except Exception as e:
        current_app.logger.error(f"API terminate_session: Exception: {e}", exc_info=True)
        return jsonify(success=False, error=str(e)), 500

@bp.route('/media/plex/sessions/terminate', methods=['POST'])
@login_required
@csrf.exempt
@permission_required('kill_stream')
def terminate_plex_session():
    """Legacy endpoint for Plex session termination - redirects to universal endpoint"""
    # Redirect to the new universal endpoint for backward compatibility
    session_key = request.form.get('session_key')
    message = request.form.get('message', None)
    
    # Create new form data for the universal endpoint
    from werkzeug.datastructures import ImmutableMultiDict
    new_form_data = ImmutableMultiDict([
        ('session_key', session_key),
        ('service_type', 'plex'),
        ('message', message)
    ])
    
    # Replace the form data and call the universal endpoint
    request.form = new_form_data
    return terminate_session()

# =============================================================================
# STREAMING API
# =============================================================================

@bp.route('/streaming/sessions/count')
@login_required
def get_session_count():
    """Get the current count of active streaming sessions - real-time data, no caching"""
    try:
        current_app.logger.debug("API: Fetching real-time session count")
        
        # Get active sessions from all services (no caching)
        active_sessions_data = MediaServiceManager.get_all_active_sessions()
        
        # Count total sessions
        total_sessions = len(active_sessions_data)
        current_app.logger.debug(f"API: Real-time session count: {total_sessions}")
        
        return jsonify({
            'success': True,
            'count': total_sessions,
            'cached': False,
            'real_time': True
        })
    except Exception as e:
        current_app.logger.error(f"Error getting session count: {e}")
        return jsonify({
            'success': False,
            'count': 0,
            'error': str(e)
        }), 500

# =============================================================================
# INVITES API
# =============================================================================

@bp.route('/invites/guild-check', methods=['GET'])
@login_required
@csrf.exempt
def check_guild_invites():
    """Check for active, usable invites that would be affected by guild membership settings"""
    now = db.func.now()
    affected_invites = Invite.query.filter(
        Invite.is_active == True,
        (Invite.expires_at == None) | (Invite.expires_at > now),
        (Invite.max_uses == None) | (Invite.current_uses < Invite.max_uses),
        Invite.force_guild_membership.is_(None)
    ).all()

    if not affected_invites:
        return jsonify(affected=False, invites=[])

    invites_data = [
        {
            "id": invite.id,
            "path": invite.custom_path or invite.token,
            "created_at": invite.created_at.isoformat()
        } for invite in affected_invites
    ]
    
    return jsonify(affected=True, invites=invites_data)

# =============================================================================
# PLUGINS API
# =============================================================================

@bp.route('/plugins/reload', methods=['POST'])
@login_required
@csrf.exempt
def reload_plugins():
    """Reload all plugins"""
    try:
        from app.services.plugin_manager import plugin_manager
        plugin_manager.reload_all_plugins()
        return jsonify({'success': True, 'message': 'Plugins reloaded successfully'})
    except Exception as e:
        current_app.logger.error(f"Error reloading plugins: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@bp.route('/plugins/refresh-servers-count', methods=['POST'])
@login_required
@csrf.exempt
def refresh_plugins_servers_count():
    """Refresh the servers count for all plugins"""
    try:
        from app.services.plugin_manager import plugin_manager
        plugin_manager.refresh_servers_count()
        return jsonify({'success': True, 'message': 'Plugin servers count refreshed'})
    except Exception as e:
        current_app.logger.error(f"Error refreshing plugin servers count: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

# =============================================================================
# NETWORK API
# =============================================================================

@bp.route('/network/geoip/<ip_address>')
@login_required
def geoip_lookup(ip_address):
    """Look up GeoIP information for a given IP address and return HTML partial"""
    plex_servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX)
    if not plex_servers:
        abort(503)
    
    # Use the first active Plex server
    plex_service = MediaServiceFactory.create_service_from_db(plex_servers[0])
    if not plex_service:
        abort(503)
    geoip_data = plex_service.get_geoip_info(ip_address)
    return render_template('components/modals/geoip_modal.html', geoip_data=geoip_data, ip_address=ip_address)
"""DEPRECATED: Legacy admin API endpoints (v1/SSR helpers).

React admin relies exclusively on `/api/v2` (OpenAPI 3) now.
This module is retained only for reference and can be removed later.
"""