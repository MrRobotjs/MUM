"""Library synchronization functionality"""

from flask import current_app, make_response, json, render_template
from flask_login import login_required, current_user
from app.utils.helpers import setup_required, permission_required
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.models_media_services import MediaLibrary
from app.extensions import db
from datetime import datetime
from . import libraries_bp


@libraries_bp.route('/sync', methods=['POST'])
@login_required
@setup_required
@permission_required('sync_libraries')
def sync_libraries():
    """Sync libraries from all media servers and store in database"""
    current_app.logger.info("Starting library synchronization.")
    
    try:
        sync_result = {
            'success': True,
            'servers_synced': 0,
            'libraries_added': 0,
            'libraries_updated': 0,
            'libraries_removed': 0,
            'errors': 0,
            'error_messages': [],
            'added_libraries': [],
            'updated_libraries': [],
            'removed_libraries': []
        }
        
        all_servers = MediaServiceManager().get_all_servers(active_only=True)
        current_library_ids_by_server = {}  # Track current libraries to detect removals
        
        for server in all_servers:
            try:
                current_app.logger.info(f"Syncing libraries for {server.server_nickname} ({server.service_type.value})")
                service = MediaServiceFactory.create_service_from_db(server)
                
                if not service:
                    sync_result['errors'] += 1
                    sync_result['error_messages'].append(f"Could not create service for {server.server_nickname}")
                    continue
                
                # Get libraries from API
                api_libraries = service.get_libraries()
                current_library_ids_by_server[server.id] = []
                
                for lib_data in api_libraries:
                    external_id = lib_data.get('external_id') or lib_data.get('id')
                    if not external_id:
                        continue
                    
                    current_library_ids_by_server[server.id].append(external_id)
                    
                    # Check if library already exists
                    existing_library = MediaLibrary.query.filter_by(
                        server_id=server.id,
                        external_id=external_id
                    ).first()
                    
                    if existing_library:
                        # Update existing library
                        updated = False
                        changes = []
                        if existing_library.name != lib_data.get('name', 'Unknown'):
                            existing_library.name = lib_data.get('name', 'Unknown')
                            changes.append('Name updated')
                            updated = True
                        if existing_library.library_type != lib_data.get('type'):
                            existing_library.library_type = lib_data.get('type')
                            changes.append('Type updated')
                            updated = True
                        if existing_library.item_count != lib_data.get('item_count'):
                            existing_library.item_count = lib_data.get('item_count')
                            changes.append('Item count updated')
                            updated = True
                        
                        if updated:
                            existing_library.updated_at = datetime.utcnow()
                            sync_result['libraries_updated'] += 1
                            sync_result['updated_libraries'].append({
                                'name': existing_library.name,
                                'server_name': server.server_nickname,
                                'changes': changes
                            })
                    else:
                        # Create new library
                        new_library = MediaLibrary(
                            server_id=server.id,
                            external_id=external_id,
                            name=lib_data.get('name', 'Unknown'),
                            library_type=lib_data.get('type'),
                            item_count=lib_data.get('item_count'),
                            last_scanned=lib_data.get('last_scanned')
                        )
                        db.session.add(new_library)
                        sync_result['libraries_added'] += 1
                        sync_result['added_libraries'].append({
                            'name': lib_data.get('name', 'Unknown'),
                            'server_name': server.server_nickname,
                            'type': lib_data.get('type'),
                            'item_count': lib_data.get('item_count')
                        })
                
                sync_result['servers_synced'] += 1
                
            except Exception as e:
                current_app.logger.error(f"Error syncing libraries for {server.server_nickname}: {e}")
                sync_result['errors'] += 1
                sync_result['error_messages'].append(f"Error syncing {server.server_nickname}: {str(e)}")
        
        # Remove libraries that no longer exist on servers
        for server_id, current_lib_ids in current_library_ids_by_server.items():
            removed_libraries = MediaLibrary.query.filter(
                MediaLibrary.server_id == server_id,
                ~MediaLibrary.external_id.in_(current_lib_ids)
            ).all()
            
            for removed_lib in removed_libraries:
                current_app.logger.info(f"Removing library {removed_lib.name} (no longer exists on server)")
                sync_result['removed_libraries'].append({
                    'name': removed_lib.name,
                    'server_name': removed_lib.server.server_nickname
                })
                db.session.delete(removed_lib)
                sync_result['libraries_removed'] += 1
        
        # Commit all changes
        db.session.commit()
        
        # Check if there are any changes to determine response type
        has_changes = (sync_result['libraries_added'] > 0 or 
                      sync_result['libraries_updated'] > 0 or 
                      sync_result['libraries_removed'] > 0 or 
                      sync_result['errors'] > 0)
        
        if has_changes:
            # Show modal for changes or errors
            modal_html = render_template('library/_partials/sync_results_modal.html',
                                       sync_result=sync_result)
            
            if sync_result['errors'] == 0:
                message = f"Library sync complete. {sync_result['libraries_added']} added, {sync_result['libraries_updated']} updated, {sync_result['libraries_removed']} removed."
                category = "success"
            else:
                message = f"Library sync completed with {sync_result['errors']} errors. See details."
                category = "warning"
            
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
            trigger_payload = {
                "showToastEvent": {"message": "Library sync complete. No changes were made.", "category": "success"},
                "refreshLibrariesPage": True
            }
            headers = {
                'HX-Trigger': json.dumps(trigger_payload)
            }
            return make_response("", 200, headers)
        
    except Exception as e:
        current_app.logger.error(f"Critical error during library synchronization: {e}", exc_info=True)
        
        # Return error response
        toast_payload = {
            "showToastEvent": {
                "message": f"Library sync failed: {str(e)}",
                "category": "error"
            }
        }
        
        return make_response("", 500, {'HX-Trigger': json.dumps(toast_payload)})
"""DEPRECATED: SSR sync views for libraries. Use v2 sync endpoints from React."""
