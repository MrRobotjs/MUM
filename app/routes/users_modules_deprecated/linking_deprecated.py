"""DEPRECATED: Legacy SSR users module linking routes (replaced by React SPA)."""
"""User account linking and unlinking functionality"""

from flask import render_template, request, current_app, make_response
from flask_login import login_required, current_user
from app.models import User, UserType
from app.extensions import db
from app.utils.helpers import permission_required
from . import users_bp
import json


@users_bp.route('/local/<int:local_user_id>/edit')
@login_required
@permission_required('edit_user')
def get_local_user_edit_form(local_user_id):
    """Get edit form for local user"""
    local_user = User.query.filter_by(userType=UserType.LOCAL).get_or_404(local_user_id)
    
    # For now, return a simple form - this can be expanded later
    return f"""
    <div class="modal-box">
        <h3 class="font-bold text-lg">Edit Local User: {local_user.localUsername}</h3>
        <p class="py-4">Local user editing functionality coming soon...</p>
        <div class="modal-action">
            <button class="btn" onclick="this.closest('dialog').close()">Close</button>
        </div>
    </div>
    """


@users_bp.route('/local/<int:local_user_id>/linked-accounts')
@login_required
@permission_required('view_users')
def get_linked_accounts(local_user_id):
    """Get linked accounts view for local user"""
    local_user = User.query.filter_by(userType=UserType.LOCAL).get_or_404(local_user_id)
    
    linked_accounts_html = ""
    # Get linked UserMediaAccess records for this local user
    linked_accounts = User.query.filter_by(userType=UserType.SERVICE).filter_by(linkedUserId=local_user_id).all()
    
    for access in linked_accounts:
        # Get service badge info based on server type
        service_type = access.server.service_type.value if access.server else 'unknown'
        badge_info = {
            'plex': {'name': 'Plex', 'icon': 'fa-solid fa-play', 'color': 'bg-plex'},
            'jellyfin': {'name': 'Jellyfin', 'icon': 'fa-solid fa-cube', 'color': 'bg-jellyfin'},
            'emby': {'name': 'Emby', 'icon': 'fa-solid fa-play-circle', 'color': 'bg-emby'},
            'kavita': {'name': 'Kavita', 'icon': 'fa-solid fa-book', 'color': 'bg-kavita'},
            'audiobookshelf': {'name': 'AudioBookshelf', 'icon': 'fa-solid fa-headphones', 'color': 'bg-audiobookshelf'},
            'komga': {'name': 'Komga', 'icon': 'fa-solid fa-book-open', 'color': 'bg-komga'},
            'romm': {'name': 'RomM', 'icon': 'fa-solid fa-gamepad', 'color': 'bg-romm'}
        }.get(service_type, {'name': 'Unknown', 'icon': 'fa-solid fa-server', 'color': 'bg-gray-500'})
        
        # Get additional account info
        join_date = access.created_at
        join_date_str = join_date.strftime('%b %Y') if join_date else 'Unknown'
        
        # Server info is already available from access.server
        server_name = access.server.server_nickname if access.server else 'Unknown Server'
        
        linked_accounts_html += f"""
        <div class="group relative bg-base-100 rounded-xl border border-base-300/60 hover:border-base-300 transition-all duration-200 hover:shadow-lg hover:shadow-base-300/20">
            <div class="p-5">
                <div class="flex items-start justify-between gap-4">
                    <!-- Left Content -->
                    <div class="flex items-start gap-4 flex-1 min-w-0">
                        <!-- Service Avatar -->
                        <div class="relative flex-shrink-0">
                            <div class="w-12 h-12 rounded-xl {badge_info['color']} flex items-center justify-center shadow-lg">
                                <i class="{badge_info['icon']} text-white text-lg"></i>
                            </div>
                            <!-- Connection Status Indicator -->
                            <div class="absolute -bottom-1 -right-1 w-4 h-4 bg-success rounded-full border-2 border-base-100 flex items-center justify-center">
                                <i class="fa-solid fa-check text-white text-xs"></i>
                            </div>
                        </div>
                        
                        <!-- Account Details -->
                        <div class="flex-1 min-w-0">
                            <!-- Header Row -->
                            <div class="flex items-center gap-3 mb-2">
                                <h4 class="font-semibold text-base-content text-lg truncate">{access.external_username or 'Unknown User'}</h4>
                                <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-success/15 text-success border border-success/20">
                                    <div class="w-1.5 h-1.5 bg-success rounded-full"></div>
                                    Connected
                                </div>
                            </div>
                            
                            <!-- Service & Server Info -->
                            <div class="flex items-center gap-2 mb-3">
                                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-medium bg-base-200/80 text-base-content/80">
                                    <i class="{badge_info['icon']} text-xs"></i>
                                    {badge_info['name']}
                                </span>
                                <span class="text-base-content/40">•</span>
                                <span class="text-sm text-base-content/70 font-medium">{server_name}</span>
                            </div>
                            
                            <!-- Metadata Row -->
                            <div class="flex items-center gap-4 text-xs text-base-content/50">
                                <div class="flex items-center gap-1.5">
                                    <i class="fa-solid fa-hashtag text-xs"></i>
                                    <span class="font-mono">{access.id}</span>
                                </div>
                                {f'''<div class="flex items-center gap-1.5">
                                    <i class="fa-solid fa-envelope text-xs"></i>
                                    <span class="truncate max-w-[120px]">{access.external_email}</span>
                                </div>''' if access.external_email else ''}
                                <div class="flex items-center gap-1.5">
                                    <i class="fa-solid fa-calendar-plus text-xs"></i>
                                    <span>Joined {join_date_str}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Action Button -->
                    <div class="flex-shrink-0">
                        <button class="btn btn-sm btn-ghost text-error/70 hover:text-error hover:bg-error/10 border border-transparent hover:border-error/20 transition-all duration-200 group/btn" 
                                onclick="unlinkServiceAccount({access.id})"
                                title="Unlink this account">
                            <i class="fa-solid fa-unlink text-sm group-hover/btn:scale-110 transition-transform duration-200"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
        """
    
    if not linked_accounts_html:
        linked_accounts_html = f"""
        <div class="bg-base-100 rounded-xl border border-base-300/60 text-center overflow-hidden">
            <!-- Empty State Content -->
            <div class="p-8">
                <div class="w-16 h-16 rounded-2xl bg-base-200/80 flex items-center justify-center mx-auto mb-4">
                    <i class="fa-solid fa-link-slash text-base-content/40 text-2xl"></i>
                </div>
                <h4 class="font-semibold text-base-content text-lg mb-2">No Linked Accounts</h4>
                <p class="text-sm text-base-content/60 mb-6 max-w-sm mx-auto leading-relaxed">This user hasn't linked any service accounts yet.</p>
                
                <!-- Info Card -->
                <div class="bg-info/8 border border-info/15 rounded-xl p-4 max-w-md mx-auto">
                    <div class="flex items-start gap-3 text-left">
                        <div class="w-6 h-6 rounded-lg bg-info/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <i class="fa-solid fa-info text-info text-xs"></i>
                        </div>
                        <div>
                            <p class="text-sm text-base-content/70 leading-relaxed">
                                Service accounts are automatically linked when users accept invites to access media servers.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        """
    
    return f"""
    <div class="modal-box max-w-3xl bg-base-100 border border-base-300 shadow-2xl p-0">
        <!-- Professional Header -->
        <div class="flex items-center justify-between p-6 border-b border-base-300">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                    <i class="fa-solid fa-link text-primary text-lg"></i>
                </div>
                <div>
                    <h3 class="text-xl font-semibold text-base-content">Linked Accounts</h3>
                    <p class="text-sm text-base-content/60">{local_user.localUsername} • {len(linked_accounts)} connected service accounts</p>
                </div>
            </div>
            <form method="dialog">
                <button class="btn btn-sm btn-circle btn-ghost hover:bg-base-200" type="button" 
                        onclick="this.closest('dialog').close()">
                    <i class="fa-solid fa-times"></i>
                </button>
            </form>
        </div>

        <!-- Content -->
        <div class="p-6">
            <!-- Description Card -->
            <div class="bg-base-200/50 rounded-lg p-4 mb-6 border border-base-300">
                <div class="flex items-start gap-3">
                    <div class="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <i class="fa-solid fa-info text-primary text-sm"></i>
                    </div>
                    <div>
                        <h4 class="font-medium text-base-content mb-1">Account Linking Overview</h4>
                        <p class="text-sm text-base-content/70 leading-relaxed">
                            {f"This local user account is linked to {len(linked_accounts)} service accounts across your media servers." if len(linked_accounts) > 0 else "This local user account has no linked service accounts yet."}
                            Service accounts are automatically created and linked when users accept invites to access media servers.
                        </p>
                    </div>
                </div>
            </div>

            <!-- Linked Accounts List -->
            <div class="space-y-3">
                {linked_accounts_html}
            </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex items-center justify-end gap-3 p-6 border-t border-base-300">
            <button type="button" class="btn btn-ghost" 
                    onclick="this.closest('dialog').close()">
                <i class="fa-solid fa-times mr-2"></i>
                Close
            </button>
        </div>
    </div>
    """


@users_bp.route('/local/<int:local_user_id>/link/<int:service_user_id>', methods=['POST'])
@login_required
@permission_required('edit_user')
def link_service_to_local(local_user_id, service_user_id):
    """Link a service account to a local user"""
    local_user = User.query.filter_by(userType=UserType.LOCAL).get_or_404(local_user_id)
    
    # Get the UserMediaAccess record by ID
    service_access = User.query.filter_by(userType=UserType.SERVICE).get_or_404(service_user_id)
    
    try:
        # Check if service account is already linked to another local user
        if service_access.linkedUserId and service_access.linkedUserId != local_user_id:
            return make_response("Service account is already linked to another local user", 400)
        
        # Link the accounts
        service_access.linkedUserId = local_user_id
        db.session.commit()
        
        
        return make_response("", 200)
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error linking accounts: {e}")
        return make_response(f"Error linking accounts: {str(e)}", 500)


@users_bp.route('/service/<int:service_user_id>/unlink', methods=['POST'])
@login_required
@permission_required('edit_user')
def unlink_service_from_local(service_user_id):
    """Unlink a service account from its local user"""
    service_access = User.query.filter_by(userType=UserType.SERVICE).get_or_404(service_user_id)
    
    try:
        old_local_user = service_access.user_app_access
        service_access.linkedUserId = None
        db.session.commit()
        
        
        return make_response("", 200)
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Error unlinking account: {e}")
        return make_response(f"Error unlinking account: {str(e)}", 500)