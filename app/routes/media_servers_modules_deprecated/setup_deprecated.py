# File: app/routes/media_servers_modules/setup.py
"""DEPRECATED: Legacy SSR setup wizard routes for media servers.

Replaced by React SPA under /setup/ui and API v2 endpoints:
- /admin/api/v2/servers...
- /admin/api/v2/setup/plugins/<plugin_id>/test-connection
"""
from flask import Blueprint, render_template, redirect, url_for, flash, request, current_app, jsonify
from flask_login import login_required, current_user
from app.models_media_services import MediaServer, ServiceType
from app.models_plugins import Plugin
from app.forms import MediaServerForm
from app.extensions import db
from app.utils.helpers import log_event, setup_required, permission_required
from app.extensions import csrf
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.models import User, UserType, EventType

# Create a blueprint for setup routes (no prefix - will be handled in app/__init__.py)
bp = Blueprint('media_servers_setup', __name__)


@bp.route('/setup/plugins/<string:plugin_id>/servers', methods=['GET'])
def setup_list_servers(plugin_id):
    """List servers for a specific plugin during setup."""
    from app.utils.setup_helpers import get_completed_steps
    
    plugin = Plugin.query.filter_by(plugin_id=plugin_id).first_or_404()
    servers = [s for s in MediaServiceManager.get_all_servers(active_only=False) if s.service_type.value == plugin_id]
    
    return render_template(
        'setup/plugins/plugins_servers_list.html',
        servers=servers,
        plugin=plugin,
        completed_steps=get_completed_steps(),
        current_step_id='plugins'
    )


@bp.route('/setup/plugins/<string:plugin_id>/servers/add', methods=['GET', 'POST'])
def add_server_setup(plugin_id):
    """Add a new server during setup."""
    from app.utils.setup_helpers import get_completed_steps
    
    plugin = Plugin.query.filter_by(plugin_id=plugin_id).first_or_404()
    form = MediaServerForm()
    
    # Set the service type based on plugin_id
    form.service_type.data = plugin_id
    
    if form.validate_on_submit():
        server = MediaServer()
        form.populate_obj(server)
        
        # Fix field mapping: form.name -> server.server_nickname
        server.server_nickname = form.name.data
        
        # Set the service type from the plugin_id
        server.service_type = ServiceType(plugin_id)
        
        try:
            # Test the connection before saving
            service = MediaServiceFactory.create_service_from_db(server)
            success, message = service.test_connection()
            
            if success:
                # Connection successful, save the server
                db.session.add(server)
                
                # Enable the plugin if this is the first server and plugin is disabled
                if plugin.servers_count == 0:
                    from app.models_plugins import PluginStatus
                    plugin.status = PluginStatus.ENABLED
                    db.session.add(plugin)
                    current_app.logger.info(f"Automatically enabled plugin '{plugin_id}' during setup after adding first server")
                
                db.session.commit()
                
                flash(f'Server "{server.server_nickname}" added successfully!', 'success')
                # Only log event if user is authenticated (during setup, user might not be fully authenticated)
                if current_user.is_authenticated:
                    log_event(EventType.SETTING_CHANGE, f"Added {server.service_type.name} server '{server.server_nickname}'", admin_id=current_user.id)
                
                return redirect(url_for('media_servers_setup.setup_list_servers', plugin_id=plugin_id))
            else:
                # Connection failed
                flash(f'Connection test failed: {message}', 'danger')
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error adding server: {e}")
            flash(f'Error adding server: {str(e)}', 'danger')
    
    return render_template(
        'setup/plugins/plugins_add_server.html',
        form=form,
        plugin=plugin,
        completed_steps=get_completed_steps(),
        current_step_id='plugins'
    )


@bp.route('/setup/plugins/<string:plugin_id>/servers/<int:server_id>/edit', methods=['GET', 'POST'])
def setup_edit_server(plugin_id, server_id):
    """Edit a server during setup."""
    from app.utils.setup_helpers import get_completed_steps
    
    plugin = Plugin.query.filter_by(plugin_id=plugin_id).first_or_404()
    server = MediaServer.query.get_or_404(server_id)
    
    # Make sure the server belongs to this plugin
    if server.service_type.value != plugin_id:
        flash('Invalid server for this plugin', 'danger')
        return redirect(url_for('media_servers_setup.setup_list_servers', plugin_id=plugin_id))
    
    form = MediaServerForm(obj=server)
    
    if form.validate_on_submit():
        # Store the original URL for comparison
        original_url = server.url
        
        # Update server properties
        form.populate_obj(server)
        
        try:
            # If the URL changed, test the connection
            if original_url != server.url:
                service = MediaServiceFactory.create_service_from_db(server)
                success, message = service.test_connection()
                
                if not success:
                    flash(f'Connection test failed: {message}', 'warning')
                    # Continue anyway since this is an edit
            
            # Save changes
            db.session.commit()
            
            flash(f'Server "{server.server_nickname}" updated successfully!', 'success')
            # Only log event if user is authenticated 
            if current_user.is_authenticated:
                log_event(EventType.SETTING_CHANGE, f"Updated {server.service_type.name} server '{server.server_nickname}'", admin_id=current_user.id)
            
            return redirect(url_for('media_servers_setup.setup_list_servers', plugin_id=plugin_id))
        
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Error updating server {server_id}: {e}")
            flash(f'Error updating server: {str(e)}', 'danger')
    
    return render_template(
        'setup/plugins/plugins_edit_server.html',
        form=form,
        server=server,
        plugin=plugin,
        completed_steps=get_completed_steps(),
        current_step_id='plugins'
    )


@bp.route('/setup/plugins/<string:plugin_id>/test-connection', methods=['POST'])
def test_connection_setup(plugin_id):
    """Test connection for a server during setup."""
    from app.models_plugins import Plugin
    
    try:
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first_or_404()
        
        # Get JSON data
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'message': 'No data provided'}), 400
            
        server_name = data.get('name', '').strip()
        server_url = data.get('url', '').strip()
        api_key = data.get('api_key', '').strip()
        username = data.get('username', '').strip()
        password = data.get('password', '').strip()
        public_url = data.get('public_url', '').strip()
        
        if not server_url:
            return jsonify({'success': False, 'message': 'Server URL is required'}), 400
        
        # Create a temporary server object for testing
        from app.models_media_services import MediaServer, ServiceType
        temp_server = MediaServer()
        temp_server.server_nickname = server_name or 'Test Server'
        temp_server.url = server_url  # Correct field name is 'url', not 'server_url'
        temp_server.api_key = api_key
        temp_server.localUsername = username
        temp_server.password = password
        temp_server.public_url = public_url
        temp_server.service_type = ServiceType(plugin_id)
        
        # Test the connection
        service = MediaServiceFactory.create_service_from_db(temp_server)
        if not service:
            return jsonify({'success': False, 'message': f'Could not create service for {plugin_id}'}), 500
            
        # The test_connection() method returns a tuple (success: bool, message: str)
        success, message = service.test_connection()
        
        return jsonify({'success': success, 'message': message})
        
    except Exception as e:
        current_app.logger.error(f"Error testing connection during setup: {e}")
        return jsonify({'success': False, 'message': f'Connection test failed: {str(e)}'}), 500


@bp.route('/setup/plugins/<string:plugin_id>/servers/<int:server_id>/delete', methods=['POST'])
def delete_server_setup(plugin_id, server_id):
    """Delete a server during setup."""
    from app.utils.setup_helpers import get_completed_steps
    
    try:
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first_or_404()
        server = MediaServer.query.get_or_404(server_id)
        
        # Make sure the server belongs to this plugin
        if server.service_type.value != plugin_id:
            flash('Invalid server for this plugin', 'danger')
            return redirect(url_for('media_servers_setup.setup_list_servers', plugin_id=plugin_id))
        
        server_name = server.server_nickname
        
        # Delete the server
        db.session.delete(server)
        db.session.commit()
        
        flash(f'Server "{server_name}" deleted successfully!', 'success')
        
        # Only log event if user is authenticated 
        if current_user.is_authenticated:
            log_event(EventType.SETTING_CHANGE, f"Deleted {server.service_type.name} server '{server_name}'", admin_id=current_user.id)
        
        return redirect(url_for('media_servers_setup.setup_list_servers', plugin_id=plugin_id))
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error deleting server {server_id}: {e}")
        flash(f'Error deleting server: {str(e)}', 'danger')
        return redirect(url_for('media_servers_setup.setup_list_servers', plugin_id=plugin_id))
