# File: app/routes/plugins.py
from flask import Blueprint, render_template, redirect, url_for, flash, request, current_app, jsonify, make_response
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename
import os
from app.models_plugins import Plugin, PluginStatus, PluginType
from app.services.plugin_manager import plugin_manager
from app.extensions import db
from app.utils.helpers import setup_required, permission_required
from app.models import User, UserType
import json
from app.utils.setup_helpers import get_completed_steps

bp = Blueprint('plugins', __name__)

def refresh_plugin_servers_count():
    """Refresh plugin servers count to ensure accuracy"""
    try:
        from app.models_media_services import MediaServer, ServiceType
        
        plugins = Plugin.query.all()
        for plugin in plugins:
            try:
                # Find the corresponding ServiceType enum value
                service_type = None
                for st in ServiceType:
                    if st.value == plugin.plugin_id:
                        service_type = st
                        break
                
                if service_type:
                    # Count actual servers
                    actual_count = MediaServer.query.filter_by(service_type=service_type).count()
                    if plugin.servers_count != actual_count:
                        plugin.servers_count = actual_count
                        db.session.add(plugin)
                else:
                    # For plugins without corresponding ServiceType, set to 0
                    if plugin.servers_count != 0:
                        plugin.servers_count = 0
                        db.session.add(plugin)
            except Exception as e:
                current_app.logger.error(f"Error updating servers_count for plugin {plugin.plugin_id}: {e}")
        
        db.session.commit()
    except Exception as e:
        current_app.logger.error(f"Error refreshing plugin servers count: {e}")

# Removed list_plugins route - functionality moved to dashboard.settings_plugins

@bp.route('/plugins/<plugin_id>/enable', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_plugins')
def enable_plugin(plugin_id):
    """Enable a plugin"""
    success = plugin_manager.enable_plugin(plugin_id)
    
    if success:
        # Ensure database changes are committed and refresh session for immediate visibility
        db.session.commit()
        db.session.close()  # Force fresh data on next query
        
        # Check if plugin has servers that were auto-enabled
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
        if plugin and plugin.servers_count > 0:
            toast_message = f'Plugin "{plugin_id}" enabled successfully! {plugin.servers_count} associated server(s) have been activated.'
        else:
            toast_message = f'Plugin "{plugin_id}" enabled successfully!'
        toast_category = 'success'
    else:
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
        error_msg = plugin.last_error if plugin else "Plugin not found"
        toast_message = f'Failed to enable plugin "{plugin_id}": {error_msg}'
        toast_category = 'error'
    
    # Check if this is an HTMX request
    if request.headers.get('HX-Request'):
        # Refresh plugin servers count before returning template
        refresh_plugin_servers_count()
        
        # For HTMX requests, return updated plugins content with toast trigger
        available_plugins = plugin_manager.get_available_plugins()
        enabled_plugins = [p.plugin_id for p in plugin_manager.get_enabled_plugins()]
        
        response = make_response(render_template('settings/plugins/index.html', 
                                               available_plugins=available_plugins,
                                               enabled_plugins=enabled_plugins))
        response.headers['HX-Trigger'] = json.dumps({"showToastEvent": {"message": toast_message, "category": toast_category}})
        return response
    else:
        # For regular requests, return toast trigger
        response = make_response(redirect(url_for('plugin_management.index')))
        response.headers['HX-Trigger'] = json.dumps({"showToastEvent": {"message": toast_message, "category": toast_category}})
        return response

@bp.route('/plugins/<plugin_id>/disable', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_plugins')
def disable_plugin(plugin_id):
    """Disable a plugin"""
    success = plugin_manager.disable_plugin(plugin_id)
    
    if success:
        # Check if this was the last enabled plugin
        remaining_enabled = Plugin.query.filter_by(status=PluginStatus.ENABLED).count()
        if remaining_enabled == 0:
            toast_message = f'Plugin "{plugin_id}" disabled successfully! Warning: No plugins are now enabled. You must enable at least one plugin before leaving this page.'
            toast_category = 'warning'
        else:
            toast_message = f'Plugin "{plugin_id}" disabled successfully! Associated servers have been deactivated.'
            toast_category = 'success'
    else:
        plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
        error_msg = plugin.last_error if plugin else "Plugin not found"
        toast_message = f'Failed to disable plugin "{plugin_id}": {error_msg}'
        toast_category = 'error'
    
    # Check if this is an HTMX request
    if request.headers.get('HX-Request'):
        # Refresh plugin servers count before returning template
        refresh_plugin_servers_count()
        
        # For HTMX requests, return updated plugins content with toast trigger
        available_plugins = plugin_manager.get_available_plugins()
        enabled_plugins = [p.plugin_id for p in plugin_manager.get_enabled_plugins()]
        
        response = make_response(render_template('settings/plugins/index.html', 
                                               available_plugins=available_plugins,
                                               enabled_plugins=enabled_plugins))
        response.headers['HX-Trigger'] = json.dumps({"showToastEvent": {"message": toast_message, "category": toast_category}})
        return response
    else:
        # For regular requests, return toast trigger
        response = make_response(redirect(url_for('plugin_management.index')))
        response.headers['HX-Trigger'] = json.dumps({"showToastEvent": {"message": toast_message, "category": toast_category}})
        return response

@bp.route('/plugins/<plugin_id>/info')
@login_required
@setup_required
@permission_required('manage_plugins')
def plugin_info(plugin_id):
    """Get detailed plugin information with current database state"""
    from app.models_plugins import Plugin
    
    # Get plugin info from manager
    plugin_info = plugin_manager.get_plugin_info(plugin_id)
    
    if not plugin_info:
        return jsonify({'error': 'Plugin not found'}), 404
    
    # Ensure we get fresh data from database
    db.session.commit()  # Commit any pending changes
    db.session.close()   # Close current session to force fresh data
    
    # Get current state from database
    db_plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
    if db_plugin:
        # Override the enabled state with actual database state
        plugin_info['enabled'] = db_plugin.is_enabled
        plugin_info['servers_count'] = db_plugin.servers_count
        current_app.logger.debug(f"Plugin {plugin_id} - DB state: enabled={db_plugin.is_enabled}, servers={db_plugin.servers_count}")
    else:
        # Plugin not in database, so it's not enabled
        plugin_info['enabled'] = False
        plugin_info['servers_count'] = 0
        current_app.logger.debug(f"Plugin {plugin_id} - Not in database, setting enabled=False")
    
    return jsonify(plugin_info)

@bp.route('/plugins/install', methods=['GET', 'POST'])
@login_required
@setup_required
@permission_required('manage_plugins')
def install_plugin():
    """Install a plugin from file upload"""
    if request.method == 'POST':
        if 'plugin_file' not in request.files:
            flash('No file selected', 'danger')
            return redirect(request.url)
        
        file = request.files['plugin_file']
        if file.filename == '':
            flash('No file selected', 'danger')
            return redirect(request.url)
        
        if file and file.filename.endswith(('.zip', '.tar.gz')):
            filename = secure_filename(file.filename)
            upload_path = os.path.join(current_app.instance_path, 'temp', filename)
            
            # Ensure temp directory exists
            os.makedirs(os.path.dirname(upload_path), exist_ok=True)
            
            try:
                file.save(upload_path)
                
                success = plugin_manager.install_plugin_from_file(upload_path)
                
                if success:
                    flash('Plugin installed successfully!', 'success')
                else:
                    flash('Failed to install plugin. Check logs for details.', 'danger')
                
                # Clean up temp file
                if os.path.exists(upload_path):
                    os.remove(upload_path)
                
            except Exception as e:
                flash(f'Error installing plugin: {str(e)}', 'danger')
                current_app.logger.error(f"Plugin installation error: {e}")
        else:
            flash('Invalid file format. Please upload a .zip or .tar.gz file.', 'danger')
        
        return redirect(url_for('plugin_management.index'))
    
    return render_template('settings/index.html', 
                         title="Install Plugin",
                         active_tab='plugin_install')

@bp.route('/plugins/<plugin_id>/uninstall', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_plugins')
def uninstall_plugin(plugin_id):
    """Uninstall a plugin"""
    plugin = Plugin.query.filter_by(plugin_id=plugin_id).first()
    
    if not plugin:
        flash('Plugin not found', 'danger')
        return redirect(url_for('plugin_management.index'))
    
    if plugin.plugin_type == PluginType.CORE:
        flash('Cannot uninstall core plugins', 'danger')
        return redirect(url_for('plugin_management.index'))
    
    if not plugin.can_be_disabled():
        flash('Cannot uninstall plugin while it has active servers', 'danger')
        return redirect(url_for('plugin_management.index'))
    
    success = plugin_manager.uninstall_plugin(plugin_id)
    
    if success:
        flash(f'Plugin "{plugin_id}" uninstalled successfully!', 'success')
    else:
        flash(f'Failed to uninstall plugin "{plugin_id}"', 'danger')
    
    # Check if we're coming from settings page
    if request.referrer and 'settings/plugins' in request.referrer:
        return redirect(url_for('plugin_management.index'))
    else:
        return redirect(url_for('plugin_management.index'))



# DEPRECATED: Legacy Flask SSR plugins routes. Use React SPA admin settings/plugins.