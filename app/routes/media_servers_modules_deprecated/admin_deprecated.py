# File: app/routes/media_servers_modules/admin.py
"""DEPRECATED: Legacy SSR admin routes for media servers. Replaced by React SPA + /admin/api/v2/servers.*"""
from flask import Blueprint, redirect, url_for, flash, current_app, jsonify
from flask_login import login_required, current_user
from app.models_media_services import MediaServer
from app.extensions import db
from app.utils.helpers import log_event, setup_required, permission_required
from app.models import User, UserType, EventType

# Create a blueprint for admin routes (prefix will be added in app/__init__.py)
bp = Blueprint('media_servers_admin', __name__)


@bp.route('/servers/<int:server_id>/delete', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_plugins')
def delete_server(server_id):
    """Delete a server from the system"""
    server = MediaServer.query.get_or_404(server_id)
    
    # Store info for logging
    server_name = server.server_nickname
    server_type = server.service_type.value
    
    try:
        db.session.delete(server)
        db.session.commit()
        
        flash(f'Server "{server_name}" deleted successfully!', 'success')
        log_event(EventType.SETTING_CHANGE, f"Deleted {server.service_type.name} server '{server_name}'", admin_id=current_user.id)
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error deleting server {server_id}: {e}")
        flash(f'Failed to delete server "{server_name}": {str(e)}', 'danger')
    
    # Redirect back to plugin configuration page
    return redirect(url_for('plugin_management.configure', plugin_id=server_type))


@bp.route('/servers/<int:server_id>/enable', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_plugins')
def enable_server(server_id):
    """Enable a specific server"""
    server = MediaServer.query.get_or_404(server_id)
    
    try:
        server.is_active = True
        db.session.commit()
        
        flash(f'Server "{server.server_nickname}" enabled successfully!', 'success')
        log_event(EventType.SETTING_CHANGE, f"Server '{server.server_nickname}' enabled", admin_id=current_user.id)
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error enabling server {server_id}: {e}")
        flash(f'Failed to enable server "{server.server_nickname}": {str(e)}', 'danger')
    
    # Redirect back to plugin configuration page
    return redirect(url_for('plugin_management.configure', plugin_id=server.service_type.value))


@bp.route('/servers/<int:server_id>/disable', methods=['POST'])
@login_required
@setup_required
@permission_required('manage_plugins')
def disable_server(server_id):
    """Disable a specific server"""
    server = MediaServer.query.get_or_404(server_id)
    
    try:
        server.is_active = False
        db.session.commit()
        
        flash(f'Server "{server.server_nickname}" disabled successfully!', 'success')
        log_event(EventType.SETTING_CHANGE, f"Server '{server.server_nickname}' disabled", admin_id=current_user.id)
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error disabling server {server_id}: {e}")
        flash(f'Failed to disable server "{server.server_nickname}": {str(e)}', 'danger')
    
    # Redirect back to plugin configuration page
    return redirect(url_for('plugin_management.configure', plugin_id=server.service_type.value))
