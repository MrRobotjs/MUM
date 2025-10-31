"""DEPRECATED: Legacy SSR users module sync routes (replaced by React SPA)."""
"""User synchronization functionality"""

from flask import render_template, request, current_app, make_response
from flask_login import login_required
from app.utils.helpers import setup_required
from app.services.unified_user_service import UnifiedUserService
from . import users_bp
import json


@users_bp.route('/sync', methods=['POST'])
@login_required
@setup_required
def sync_all_users():
    """
    Performs Plex user synchronization and returns an HTML response
    with htmx headers to trigger modals and toasts.
    """
    current_app.logger.info("Starting Plex user synchronization.")

    # --- Part 1: Core Synchronization Logic ---
    try:
        # Use the new unified user service instead of the old plex_service
        sync_result = UnifiedUserService.sync_all_users()
        
        if not sync_result['success']:
            current_app.logger.error(f"User sync failed: {sync_result.get('message', 'Unknown error')}")
            # Show modal with the detailed error messages from the unified service
            modal_html = render_template('users/_partials/sync_results_modal.html',
                                       sync_result=sync_result)
            trigger_payload = {
                "showToastEvent": {"message": "Sync encountered errors. See details.", "category": "error"},
                "openSyncResultsModal": True,
                "refreshUserList": True
            }
            headers = {
                'HX-Retarget': '#syncResultModalContainer',
                'HX-Reswap': 'innerHTML',
                'HX-Trigger-After-Swap': json.dumps(trigger_payload)
            }
            return make_response(modal_html, 200, headers)
        else:
            # Check if there are actual changes to determine whether to show modal or just toast
            has_changes = (sync_result.get('added', 0) > 0 or 
                          sync_result.get('updated', 0) > 0 or 
                          sync_result.get('removed', 0) > 0 or 
                          sync_result.get('errors', 0) > 0)
            
            if has_changes:
                # Show modal for changes or errors
                modal_html = render_template('users/_partials/sync_results_modal.html',
                                           sync_result=sync_result)
                trigger_payload = {
                    "showToastEvent": {"message": sync_result.get('message', 'Sync completed'), "category": "success"},
                    "openSyncResultsModal": True,
                    "refreshUserList": True
                }
                headers = {
                    'HX-Retarget': '#syncResultModalContainer',
                    'HX-Reswap': 'innerHTML',
                    'HX-Trigger-After-Swap': json.dumps(trigger_payload)
                }
                return make_response(modal_html, 200, headers)
            else:
                # No changes - just show toast
                trigger_payload = {
                    "showToastEvent": {"message": "Sync complete. No changes were made.", "category": "success"},
                    "refreshUserList": True
                }
                headers = {
                    'HX-Trigger': json.dumps(trigger_payload)
                }
                return make_response("", 200, headers)
            
    except Exception as e:
        current_app.logger.error(f"Critical error during user synchronization: {e}", exc_info=True)
        # Create a sync result with the actual exception details
        sync_result = {
            'success': False,
            'added': 0,
            'updated': 0,
            'removed': 0,  # Add missing 'removed' key
            'errors': 1,
            'error_messages': [f"Critical synchronization error: {str(e)}"],
            'servers_synced': 0
        }
        modal_html = render_template('users/_partials/sync_results_modal.html',
                                     sync_result=sync_result)
        trigger_payload = {
            "showToastEvent": {"message": "Sync failed due to critical error. See details.", "category": "error"},
            "openSyncResultsModal": True,
            "refreshUserList": True
        }
        headers = {
            'HX-Retarget': '#syncResultModalContainer',
            'HX-Reswap': 'innerHTML',
            'HX-Trigger-After-Swap': json.dumps(trigger_payload)
        }
        return make_response(modal_html, 200, headers)
