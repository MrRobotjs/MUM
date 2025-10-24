"""
Core invite functionality - Public invite processing and main routes
"""

import uuid
from flask import render_template, redirect, url_for, flash, request, current_app, session, g
from markupsafe import Markup
from datetime import datetime, timezone
from app.utils.timezone_utils import utcnow
from urllib.parse import urlencode, quote as url_quote, urlparse, parse_qs, urlunparse 
from flask_login import current_user
from app.models import User, UserType, Invite, Setting, EventType
from app.extensions import db
from app.utils.helpers import log_event, setup_required
from app.services.media_service_factory import MediaServiceFactory
from app.services.media_service_manager import MediaServiceManager
from . import invites_public_bp as invites_bp

# Add DISCORD_API_BASE_URL constant
DISCORD_API_BASE_URL = 'https://discord.com/api/v10'

@invites_bp.route('/invite/<invite_path_or_token>', methods=['GET'])
@setup_required
def process_invite_form(invite_path_or_token):
    """Serve React SPA for invite acceptance page"""
    from flask import send_from_directory
    import os

    # Log invite view for valid invites
    from app.services import invite_service
    invite, error_message = invite_service.validate_invite_usability(invite_path_or_token)
    if invite and not error_message:
        log_event(EventType.INVITE_VIEWED, f"Invite '{invite.custom_path or invite.token}' (ID: {invite.id}) viewed/accessed.", invite_id=invite.id)

    # Serve React SPA regardless of invite validity - React will handle validation via API
    dist_path = os.path.join(current_app.root_path, 'static', 'dist')
    index_path = os.path.join(dist_path, 'index.html')

    if not os.path.exists(index_path):
        current_app.logger.error("React SPA build not found at %s", index_path)
        return (
            "<h1>React App Not Built</h1>"
            "<p>The React admin interface has not been built yet.</p>"
            "<p>Please run: <code>cd frontend && npm run build</code></p>"
        ), 500

    current_app.logger.debug("Serving React SPA for invite page: %s", invite_path_or_token)
    return send_from_directory(dist_path, 'index.html')

@invites_bp.route('/success') # Path is /invites/success
@setup_required 
def invite_success():
    username = request.args.get('username', 'there')
    servers = request.args.get('servers', '')
    allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    
    # Parse server names and determine service types
    server_list = [s.strip() for s in servers.split(',') if s.strip()] if servers else []
    
    # Get server information from the database to determine service types
    media_service_manager = MediaServiceManager()
    all_servers = media_service_manager.get_all_servers(active_only=True)
    
    configured_servers = []
    has_plex = False
    has_jellyfin = False
    has_other = False
    
    for server_name in server_list:
        # Find the server in the database
        server = next((s for s in all_servers if s.server_nickname == server_name), None)
        if server:
            configured_servers.append({
                'name': server.server_nickname,
                'type': server.service_type.name.upper(),
                'url': get_server_url(server)
            })
            
            if server.service_type.name.upper() == 'PLEX':
                has_plex = True
            elif server.service_type.name.upper() == 'JELLYFIN':
                has_jellyfin = True
            else:
                has_other = True
    
    return render_template('invite/steps/_success.html', 
                         username=username, 
                         configured_servers=configured_servers,
                         has_plex=has_plex,
                         has_jellyfin=has_jellyfin,
                         has_other=has_other,
                         allow_user_accounts=allow_user_accounts)

@invites_bp.route('/') # Defines the base /invites/ path
@setup_required 
def invite_landing_page(): # Renamed from placeholder
    flash("Please use a specific invite link.", "info")
    if current_user.is_authenticated: 
        return redirect(url_for('dashboard.index'))
    # If not authenticated and no specific invite, perhaps redirect to admin login or a generic info page
    return redirect(url_for('auth.app_login'))

@invites_bp.route('/invite/', methods=['GET', 'POST'])
@setup_required
def invite_code_entry():
    """Landing page where users can enter their invite code"""
    from flask_wtf import FlaskForm
    from wtforms import StringField, SubmitField
    from wtforms.validators import DataRequired, Length
    from app.services import invite_service
    
    class InviteCodeForm(FlaskForm):
        invite_code = StringField('Invite Code', 
                                validators=[DataRequired(), Length(min=1, max=100)],
                                render_kw={"placeholder": "Enter your invite code", "class": "input input-bordered w-full"})
        submit = SubmitField('Access Invite', render_kw={"class": "btn btn-primary w-full"})
    
    form = InviteCodeForm()
    error_message = None
    
    if form.validate_on_submit():
        invite_code = form.invite_code.data.strip()
        
        # Validate the invite code before redirecting
        invite, error_message_from_validation = invite_service.validate_invite_usability(invite_code)
        
        if error_message_from_validation or not invite:
            # Invalid invite - show error message and stay on the page
            error_message = error_message_from_validation or "Invalid invite code. Please check your code and try again."
        else:
            # Valid invite - redirect to the invite process
            return redirect(url_for('invites.process_invite_form', invite_path_or_token=invite_code))
    
    return render_template('invite/index.html', form=form, error_message=error_message) 

def get_server_url(server):
    """Get the appropriate URL for a server based on its type"""
    if server.service_type.name.upper() == 'PLEX':
        return "https://app.plex.tv"
    elif server.service_type.name.upper() == 'JELLYFIN':
        return server.url
    elif server.service_type.name.upper() == 'EMBY':
        return server.url
    else:
        return server.url