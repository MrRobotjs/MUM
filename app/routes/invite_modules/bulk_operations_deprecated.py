"""
DEPRECATED: Admin invite bulk operations (SSR/legacy).
Use v2 endpoint: POST /admin/api/v2/invites/bulk (see app/routes/api_v2/invites_bulk.py).
"""

from flask import request, jsonify, current_app
from flask_login import login_required, current_user
from app.models import User, UserType, Invite, EventType
from app.extensions import db
from app.utils.helpers import setup_required, permission_required, log_event
from . import invites_admin_bp as invites_bp

@invites_bp.route("/delete_multiple", methods=["POST"])
@login_required
@setup_required
@permission_required("delete_invites")
def delete_multiple():
    """Delete multiple invites"""
    invite_ids = request.form.getlist("invite_ids")
    
    if not invite_ids:
        return jsonify({"success": False, "message": "No invites selected"}), 400
    
    try:
        # Convert to integers and validate
        invite_ids = [int(id) for id in invite_ids]
        
        # Get invite details for logging before deletion
        invites_to_delete = Invite.query.filter(Invite.id.in_(invite_ids)).all()
        invite_details = [(inv.id, inv.custom_path or inv.token) for inv in invites_to_delete]
        
        # Delete the invites
        deleted_count = Invite.query.filter(Invite.id.in_(invite_ids)).delete(synchronize_session=False)
        db.session.commit()
        
        # Log the bulk deletion
        for invite_id, path_or_token in invite_details:
            log_event(EventType.INVITE_DELETED, 
                      f"Invite \"{path_or_token}\" deleted (bulk operation).", 
                      invite_id=invite_id,
                      admin_id=current_user.id)
        
        return jsonify({
            "success": True, 
            "message": f"Successfully deleted {deleted_count} invite(s)",
            "deleted_count": deleted_count
        })
        
    except ValueError:
        return jsonify({"success": False, "message": "Invalid invite IDs"}), 400
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error deleting multiple invites: {e}")
        return jsonify({"success": False, "message": "Error deleting invites"}), 500

@invites_bp.route("/disable_multiple", methods=["POST"])
@login_required
@setup_required
@permission_required("edit_invites")
def disable_multiple():
    """Disable multiple invites"""
    invite_ids = request.form.getlist("invite_ids")
    
    if not invite_ids:
        return jsonify({"success": False, "message": "No invites selected"}), 400
    
    try:
        # Convert to integers and validate
        invite_ids = [int(id) for id in invite_ids]
        
        # Get invite details for logging
        invites_to_disable = Invite.query.filter(Invite.id.in_(invite_ids)).all()
        invite_details = [(inv.id, inv.custom_path or inv.token) for inv in invites_to_disable]
        
        # Disable the invites
        disabled_count = Invite.query.filter(Invite.id.in_(invite_ids)).update(
            {"is_active": False}, synchronize_session=False
        )
        db.session.commit()
        
        # Log the bulk disable
        for invite_id, path_or_token in invite_details:
            log_event(EventType.SETTING_CHANGE, 
                      f"Invite \"{path_or_token}\" disabled (bulk operation).", 
                      invite_id=invite_id,
                      admin_id=current_user.id)
        
        return jsonify({
            "success": True, 
            "message": f"Successfully disabled {disabled_count} invite(s)",
            "disabled_count": disabled_count
        })
        
    except ValueError:
        return jsonify({"success": False, "message": "Invalid invite IDs"}), 400
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error disabling multiple invites: {e}")
        return jsonify({"success": False, "message": "Error disabling invites"}), 500

@invites_bp.route("/toggle_multiple", methods=["POST"])
@login_required
@setup_required
@permission_required("edit_invites")
def toggle_multiple():
    """Toggle (enable/disable) multiple invites"""
    invite_ids = request.form.getlist("invite_ids")
    action = request.form.get("action", "disable")  # Default to disable for backwards compatibility
    
    if not invite_ids:
        return jsonify({"success": False, "message": "No invites selected"}), 400
    
    try:
        # Convert to integers and validate
        invite_ids = [int(id) for id in invite_ids]
        
        # Determine the new status based on action
        new_status = action == "enable"
        action_text = "enabled" if new_status else "disabled"
        
        # Get invite details for logging
        invites_to_toggle = Invite.query.filter(Invite.id.in_(invite_ids)).all()
        invite_details = [(inv.id, inv.custom_path or inv.token) for inv in invites_to_toggle]
        
        # Toggle the invites
        updated_count = Invite.query.filter(Invite.id.in_(invite_ids)).update(
            {"is_active": new_status}, synchronize_session=False
        )
        db.session.commit()
        
        # Log the bulk toggle
        for invite_id, path_or_token in invite_details:
            log_event(EventType.SETTING_CHANGE, 
                      f"Invite \"{path_or_token}\" {action_text} (bulk operation).", 
                      invite_id=invite_id,
                      admin_id=current_user.id)
        
        return jsonify({
            "success": True, 
            "message": f"Successfully {action_text} {updated_count} invite(s)",
            "count": updated_count,
            "action": action
        })
        
    except ValueError:
        return jsonify({"success": False, "message": "Invalid invite IDs"}), 400
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error toggling multiple invites: {e}")
        return jsonify({"success": False, "message": f"Error {action}ing invites"}), 500
