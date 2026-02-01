# File: app/routes/user_modules/history_deprecated.py
"""DEPRECATED: Legacy SSR user history routes (replaced by SPA at /user)."""

from flask import render_template, redirect, url_for, flash, request, current_app, make_response, abort
from flask_login import login_required, current_user
from datetime import datetime, timezone, timedelta
from app.models import User, UserType
from app.models_media_services import MediaStreamHistory
from app.extensions import db
from app.utils.helpers import permission_required
from . import user_bp
import urllib.parse
import json


@user_bp.route('/<username>/delete_history', methods=['POST'])
@user_bp.route('/<server_nickname>/<server_username>/delete_history', methods=['POST'])
@login_required
@permission_required('edit_user')  # Or a more specific permission if you add one
def delete_stream_history(username=None, server_nickname=None, server_username=None):
    """Delete streaming history for users - handles both local and service users"""
    # Determine if this is a local user or service user based on parameters
    if username and not server_nickname and not server_username:
        # Local user route
        user = User.query.filter_by(userType=UserType.LOCAL).filter_by(username=urllib.parse.unquote(username)).first()
        if not user:
            current_app.logger.error(f"Local user not found: {username}")
            return make_response("<!-- error -->", 400)
        actual_id = user.id
        user_type = "user_app_access"
    elif server_nickname and server_username:
        # Service user route
        from app.models_media_services import MediaServer
        server = MediaServer.query.filter_by(server_nickname=urllib.parse.unquote(server_nickname)).first()
        if not server:
            current_app.logger.error(f"Server not found: {server_nickname}")
            return make_response("<!-- error -->", 400)
        
        access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
            server_id=server.id,
            external_username=urllib.parse.unquote(server_username)
        ).first()
        if not access:
            current_app.logger.error(f"Service user not found: {server_username} on {server_nickname}")
            return make_response("<!-- error -->", 400)
        actual_id = access.id
        user_type = "user_media_access"
    else:
        current_app.logger.error("Invalid parameters for delete_stream_history route")
        return make_response("<!-- error -->", 400)
    
    try:
        # Get the time period from form data
        time_period = request.form.get('time_period', '30')
        
        # Calculate the date threshold
        current_time = datetime.now(timezone.utc)
        if time_period == 'all':
            # Delete all history
            date_threshold = None
        else:
            # Delete history older than X days
            days = int(time_period)
            date_threshold = current_time - timedelta(days=days)
        
        if user_type == "user_app_access":
            # Delete history for local user (both direct and linked account history)
            query = MediaStreamHistory.query.filter(
                MediaStreamHistory.user_uuid == user.uuid
            )
            
            # Also include linked account history (service accounts linked to this local user)
            linked_service_users = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=user.uuid).all()
            linked_uuids = [sa.uuid for sa in linked_service_users]
            
            if linked_uuids:
                linked_query = MediaStreamHistory.query.filter(MediaStreamHistory.user_uuid.in_(linked_uuids))
            else:
                linked_query = MediaStreamHistory.query.filter(MediaStreamHistory.user_uuid == None)  # Empty query
            
            if date_threshold:
                query = query.filter(MediaStreamHistory.started_at <= date_threshold)
                linked_query = linked_query.filter(MediaStreamHistory.started_at <= date_threshold)
            
            # Count records to be deleted
            direct_count = query.count()
            linked_count = linked_query.count()
            total_count = direct_count + linked_count
            
            # Delete the records
            query.delete(synchronize_session=False)
            linked_query.delete(synchronize_session=False)
            
            log_message = f"Deleted {total_count} streaming history records for user '{user.get_display_name()}'"
            
        else:  # user_media_access
            # Delete history for service user only
            query = MediaStreamHistory.query.filter(
                MediaStreamHistory.user_uuid == access.uuid
            )
            
            if date_threshold:
                query = query.filter(MediaStreamHistory.started_at <= date_threshold)
            
            # Count and delete
            count = query.count()
            query.delete(synchronize_session=False)
            
            log_message = f"Deleted {count} streaming history records for service user '{access.external_username}' on {server.server_nickname}"
        
        db.session.commit()
        
        # Log the action
        
        current_app.logger.info(log_message)
        
        # Return success response for HTMX
        return make_response("<!-- success -->", 200)
        
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error deleting stream history: {e}")
        return make_response("<!-- error -->", 500)