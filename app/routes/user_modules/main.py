# File: app/routes/user_modules/main.py
"""Core dashboard and index functionality for user module"""

from flask import render_template, redirect, url_for, flash, request
from flask_login import login_required, current_user
from app.extensions import db
from . import user_bp
from .helpers import _generate_streaming_chart_data


@user_bp.route('/')
@user_bp.route('/index')
@user_bp.route('/dashboard')
@login_required
def index():
    """User dashboard/index page for regular user accounts - accessible at /user/dashboard"""
    # Ensure this is a regular user, not an owner
    from app.models import User, UserType
    if current_user.userType == UserType.OWNER:
        return redirect('/admin/dashboard')
    
    # Ensure this is a LOCAL user account
    if current_user.userType != UserType.LOCAL:
        flash('Access denied. Please log in with a valid user account.', 'danger')
        return redirect(url_for('auth.app_login'))
    
    # Get application name for welcome message
    from app.models import User, UserType, Setting
    app_name = Setting.get('APP_NAME', 'MUM')
    
    # Get date range from query parameter
    days_param = request.args.get('days', '30')
    try:
        if days_param == 'all':
            days = -1
        else:
            days = int(days_param)
            # Validate days parameter
            if days not in [7, 30, 90, 365]:
                days = 30
    except (ValueError, TypeError):
        days = 30
    
    # Get group by parameter
    group_by = request.args.get('group_by', 'library_type')
    if group_by not in ['library_type', 'library_name']:
        group_by = 'library_type'
    
    # Generate streaming history chart data
    chart_data = _generate_streaming_chart_data(current_user, days, group_by)
    
    # Enhanced debug logging for chart data
    from flask import current_app
    current_app.logger.info(f"=== CHART DEBUG: User Dashboard Chart Data Generation ===")
    current_app.logger.info(f"CHART DEBUG: User UUID: {current_user.uuid}")
    current_app.logger.info(f"CHART DEBUG: Days parameter: {days}")
    
    if chart_data:
        current_app.logger.info(f"CHART DEBUG: Chart data generated successfully")
        current_app.logger.info(f"CHART DEBUG: Total services: {len(chart_data.get('services', []))}")
        current_app.logger.info(f"CHART DEBUG: Total streams: {chart_data.get('total_streams', 0)}")
        current_app.logger.info(f"CHART DEBUG: Total duration: {chart_data.get('total_duration', '0m')}")
        current_app.logger.info(f"CHART DEBUG: Most active service: {chart_data.get('most_active_service', 'None')}")
        current_app.logger.info(f"CHART DEBUG: Chart data points: {len(chart_data.get('chart_data', []))}")
        
        # Log detailed service information
        for i, service in enumerate(chart_data.get('services', [])):
            current_app.logger.info(f"CHART DEBUG: Service {i+1}: {service.get('name')} ({service.get('type')}) - {service.get('watch_time')} - {service.get('count')} streams")
        
        # Log sample chart data points
        chart_data_list = chart_data.get('chart_data', [])
        current_app.logger.info(f"CHART DEBUG: Sample chart data points (first 5):")
        for i, point in enumerate(chart_data_list[:5]):
            current_app.logger.info(f"CHART DEBUG: Point {i+1}: {point}")
        
        # Log service-content combinations
        combinations = chart_data.get('service_content_combinations', [])
        current_app.logger.info(f"CHART DEBUG: Service-content combinations: {combinations}")
        
    else:
        current_app.logger.info("CHART DEBUG: No chart data generated")
    
    current_app.logger.info(f"=== END CHART DEBUG ===")
    
    # Ensure the user's media_accesses are loaded in the current session
    user_with_accesses = db.session.merge(current_user)
    
    return render_template('user_portal/dashboard.html', 
                         title="Dashboard", 
                         app_name=app_name,
                         user=user_with_accesses,
                         chart_data=chart_data,
                         selected_days=days,
                         selected_group_by=group_by)
