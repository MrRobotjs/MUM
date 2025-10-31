"""DEPRECATED: SSR library listing and overview (use React + v2 APIs)."""

from flask import render_template, flash, redirect, url_for, current_app, request
from flask_login import login_required, current_user
from app.utils.helpers import setup_required, permission_required
from app.models_media_services import MediaLibrary, MediaServer
from app.models import UserType
from app.extensions import db
from . import libraries_bp


@libraries_bp.route('/libraries')
@login_required
@setup_required
@permission_required('view_libraries')
def index():
    """Display libraries from stored database data instead of live API calls"""
    # Redirect AppUsers without admin permissions away from admin pages
    if current_user.userType == UserType.LOCAL and not current_user.has_permission('view_libraries'):
        flash('You do not have permission to access the libraries management page.', 'danger')
        return redirect(url_for('user.index'))
    
    libraries_by_service = {}
    
    # Get all servers and their stored libraries from database
    servers_with_libraries = db.session.query(MediaServer, MediaLibrary).outerjoin(
        MediaLibrary, MediaServer.id == MediaLibrary.server_id
    ).filter(MediaServer.is_active == True).all()
    
    # Group libraries by server and service type
    servers_dict = {}
    for server, library in servers_with_libraries:
        if server.id not in servers_dict:
            servers_dict[server.id] = {
                'server': server,
                'libraries': [],
                'has_data': False
            }
        
        if library:
            servers_dict[server.id]['libraries'].append({
                'id': library.external_id,
                'name': library.name,
                'type': library.library_type,
                'item_count': library.item_count,
                'last_scanned': library.last_scanned,
                'server_name': server.server_nickname,
                'service_type': server.service_type.value,
                'server_id': server.id,
                'external_id': library.external_id
            })
            servers_dict[server.id]['has_data'] = True
    
    # Build the display structure
    for server_data in servers_dict.values():
        server = server_data['server']
        service_type = server.service_type.value.upper()
        
        if service_type not in libraries_by_service:
            libraries_by_service[service_type] = {
                'servers': {},
                'total_libraries': 0,
                'service_display_name': service_type.title()
            }
        
        libraries_by_service[service_type]['servers'][server.server_nickname] = {
            'libraries': server_data['libraries'],
            'server_id': server.id,
            'online': server_data['has_data'],
            'needs_sync': not server_data['has_data'],
            'last_sync_at': server.last_sync_at
        }
        
        libraries_by_service[service_type]['total_libraries'] += len(server_data['libraries'])

    # Calculate total servers for layout decision
    total_servers = sum(len(service_data['servers']) for service_data in libraries_by_service.values())
    total_services = len(libraries_by_service)
    
    # If only one server/service, flatten the structure for simple display
    simple_libraries = []
    if total_servers == 1 and total_services == 1:
        for service_data in libraries_by_service.values():
            for server_data in service_data['servers'].values():
                simple_libraries.extend(server_data['libraries'])

    # Check if this is an HTMX request for just the content
    if request.headers.get('HX-Request'):
        return render_template(
            'libraries/_partials/libraries_content.html',
            libraries_by_service=libraries_by_service,
            simple_libraries=simple_libraries,
            total_servers=total_servers,
            total_services=total_services,
            use_simple_layout=(total_servers == 1 and total_services == 1)
        )
    
    return render_template(
        'libraries/index.html',
        title="Libraries",
        libraries_by_service=libraries_by_service,
        simple_libraries=simple_libraries,
        total_servers=total_servers,
        total_services=total_services,
        use_simple_layout=(total_servers == 1 and total_services == 1)
    )
