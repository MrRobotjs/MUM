# File: app/services/invite_service.py

from flask import current_app
from datetime import datetime, timezone, timedelta
from sqlalchemy.exc import IntegrityError
from app.models import Invite, User, UserType, InviteUsage, EventType, Setting
from app.extensions import db
from app.utils.helpers import log_event
from app.models_media_services import ServiceType
from . import user_service # Use . to import from current package
from .media_service_factory import MediaServiceFactory
from .media_service_manager import MediaServiceManager


def _get_server_feature_state(invite: Invite, server_id: int) -> dict:
    """Resolve per-server feature flags, falling back to invite-level defaults."""
    feature = next((f for f in getattr(invite, "server_features", []) or [] if f.server_id == server_id), None)
    return {
        "allow_downloads": feature.allow_downloads if feature and feature.allow_downloads is not None else bool(invite.allow_downloads),
        "invite_to_plex_home": feature.invite_to_plex_home if feature and feature.invite_to_plex_home is not None else bool(invite.invite_to_plex_home),
        "allow_live_tv": feature.allow_live_tv if feature and feature.allow_live_tv is not None else bool(invite.allow_live_tv),
        "allow_4k_transcode": feature.allow_4k_transcode if feature and feature.allow_4k_transcode is not None else bool(invite.allow_4k_transcode),
    }


def _resolve_invite_library_id_for_server(library_token: str, server_id: int) -> str | None:
    """
    Resolve an invite library token to a raw library id for a specific server.

    Token format: "<server_id>::<library_id>"
    """
    if library_token is None:
        return None

    token = str(library_token)
    separator = "::"
    if separator not in token:
        return None

    server_part, library_part = token.split(separator, 1)
    if not server_part.isdigit() or not library_part:
        return None

    return library_part if int(server_part) == int(server_id) else None

def validate_invite_usability(invite_path_or_token):
    """
    Validates an invite based on its path or token.
    Returns (Invite object, None) if valid and usable.
    Returns (None, error_message) if invalid or not usable.
    """
    if not invite_path_or_token:
        return None, "Invite identifier missing."

    # Try finding by custom path first, then by token
    invite = Invite.query.filter(
        (Invite.custom_path == invite_path_or_token) | (Invite.token == invite_path_or_token)
    ).first()

    if not invite:
        log_event(EventType.INVITE_VIEWED, f"Invite '{invite_path_or_token}' not found.", details={'identifier': invite_path_or_token})
        return None, "Invite link is invalid or does not exist."

    if not invite.is_active:
        log_event(EventType.INVITE_VIEWED, f"Invite '{invite_path_or_token}' (ID: {invite.id}) is deactivated.", invite_id=invite.id)
        return None, "This invite link has been deactivated."
    
    if invite.is_expired:
        log_event(EventType.INVITE_EXPIRED, f"Invite '{invite_path_or_token}' (ID: {invite.id}) has expired.", invite_id=invite.id)
        return None, "This invite link has expired."

    if invite.has_reached_max_uses:
        log_event(EventType.INVITE_MAX_USES_REACHED, f"Invite '{invite_path_or_token}' (ID: {invite.id}) has reached its maximum number of uses.", invite_id=invite.id)
        return None, "This invite link has reached its maximum number of uses."
    
    # Log that the valid invite was viewed (attempted to be used)
    # More detailed usage logging happens upon auth attempts or acceptance.
    log_event(EventType.INVITE_VIEWED, f"Invite '{invite_path_or_token}' (ID: {invite.id}) viewed/accessed.", invite_id=invite.id)
    return invite, None


def record_invite_usage_attempt(invite_id, ip_address, plex_user_info=None, discord_user_info=None, status_message=None):
    """Records an attempt to use an invite, even if not fully successful yet."""
    usage = InviteUsage(invite_id=invite_id, ip_address=ip_address, status_message=status_message)
    if plex_user_info:
        usage.plex_user_uuid = plex_user_info.get('uuid')
        usage.plex_username = plex_user_info.get('username')
        usage.plex_email = plex_user_info.get('email')
        usage.plex_thumb = plex_user_info.get('thumb')
        usage.plex_auth_successful = True # Assume if info is passed, auth was okay for this stage
    if discord_user_info:
        usage.discord_user_id = discord_user_info.get('id')
        usage.discord_username = discord_user_info.get('username')
        usage.discord_auth_successful = True
    
    db.session.add(usage)
    db.session.commit()
    return usage # Return the usage record in case it needs to be updated (e.g. with mum_user_id)


def accept_invite_and_grant_access(invite: Invite, plex_user_uuid: str, plex_username: str, plex_email: str, plex_thumb: str,
                                   discord_user_info: dict,
                                   ip_address: str = None, app_user=None):
    """
    Processes invite acceptance:
    1. Checks if Plex user already exists in MUM or on Plex server.
    2. If new, invites/shares with Plex server (respecting allow_downloads from invite).
    3. Creates/updates MUM User record, setting access_expires_at and whitelist statuses if specified in invite.
    4. Updates Invite usage counts and links MUM user to InviteUsage.
    Returns (True, "Success message" or User object) or (False, "Error message")
    """
    current_app.logger.info(f"=== ACCEPT INVITE AND GRANT ACCESS STARTED ===")
    current_app.logger.info(f"Invite ID: {invite.id}, Plex user: {plex_username}, App user: {app_user.localUsername if app_user else 'None'}")
    current_app.logger.info(f"Invite servers: {[s.server_nickname for s in invite.servers]}")
    current_app.logger.info(f"Invite grant_library_ids: {invite.grant_library_ids}")
    if not invite.is_usable:
        log_event(EventType.INVITE_VIEWED, f"Attempt to use unusable invite '{invite.custom_path or invite.token}' (ID: {invite.id}).", invite_id=invite.id, details={'reason': 'not usable'})
        return False, "This invite is no longer valid (expired, maxed out, or deactivated)."

    effective_servers = [
        server for server in (invite.servers or [])
        if MediaServiceManager.is_server_effectively_active(server)
    ]
    if invite.servers and not effective_servers:
        log_event(
            EventType.INVITE_VIEWED,
            f"Attempt to use paused invite '{invite.custom_path or invite.token}' (ID: {invite.id}).",
            invite_id=invite.id,
            details={'reason': 'no active servers'},
        )
        return False, "This invite is temporarily unavailable because all servers are disabled."

    # Look for existing user by Plex UUID via service user
    existing_mum_user = None
    if plex_user_uuid:
        from app.models_media_services import MediaServer
        plex_server = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
        if plex_server:
            access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                server_id=plex_server.id,
                external_user_alt_id=plex_user_uuid
            ).first()
            if access:
                # Get the linked local user if it exists
                existing_mum_user = None
                if access.linkedUserId:
                    existing_mum_user = User.query.filter_by(userType=UserType.LOCAL, uuid=access.linkedUserId).first()
    if existing_mum_user:
        updated_existing = False
        # If the user already exists, but re-links their Discord, update their info
        if discord_user_info and discord_user_info.get('id') and not existing_mum_user.discord_user_id:
            existing_mum_user.discord_user_id = discord_user_info.get('id')
            existing_mum_user.discord_username = discord_user_info.get('username')
            existing_mum_user.discord_avatar_hash = discord_user_info.get('avatar')
            existing_mum_user.discord_email = discord_user_info.get('email')
            existing_mum_user.discord_email_verified = discord_user_info.get('verified')
            updated_existing = True
        
        if updated_existing:
            existing_mum_user.updated_at = datetime.now(timezone.utc)
        
        plex_user_info = {'uuid': plex_user_uuid, 'username': plex_username, 'email': plex_email, 'thumb': plex_thumb}
        usage_log = record_invite_usage_attempt(invite.id, ip_address, plex_user_info=plex_user_info, discord_user_info=discord_user_info, status_message="User already managed by MUM.")
        usage_log.userId = existing_mum_user.uuid
        usage_log.accepted_invite = True 
        
        invite.current_uses += 1
        db.session.add(usage_log)
        db.session.add(invite)
        try:
            db.session.commit()
            log_event(EventType.INVITE_USED_ACCOUNT_LINKED, f"Existing user {plex_username} used invite {invite.id} (Discord linked/re-confirmed).", user_id=existing_mum_user.id, invite_id=invite.id)
        except Exception as e_commit:
            db.session.rollback()
            current_app.logger.error(f"Error committing usage for existing user on invite {invite.id}: {e_commit}")
            return False, "Database error during invite processing for existing user."

        return False, f"You ({plex_username}) are already a member of this Plex server."

    # User is new to MUM. Grant access to all servers associated with the invite.
    servers_to_grant_access = effective_servers
    
    if not servers_to_grant_access:
        log_event(EventType.ERROR_GENERAL, f"No servers found for invite {invite.id} when trying to grant access to {plex_username}", invite_id=invite.id)
        return False, "No servers are configured for this invite. Please contact admin."
    
    # Grant access to each server
    successful_servers = []
    failed_servers = []
    
    for server in servers_to_grant_access:
        try:
            current_app.logger.debug(f"Invite service - Processing server: {server.server_nickname}, service_type: {server.service_type}, id: {server.id}")
            service = MediaServiceFactory.create_service_from_db(server)
            if not service:
                current_app.logger.error(f"Invite service - Failed to create service for server {server.server_nickname} with service_type: {server.service_type}")
                failed_servers.append(f"{server.server_nickname} (service creation failed)")
                continue
                
            # For now, we'll use the invite_user_to_plex_server method for all services
            # This assumes all services have this method or we need service-specific logic
            current_app.logger.debug(f"Invite service - Service created successfully: {service}")
            current_app.logger.debug(f"Invite service - Service has invite_user_to_plex_server: {hasattr(service, 'invite_user_to_plex_server')}")
            current_app.logger.debug(f"Invite service - Service has add_user: {hasattr(service, 'add_user')}")
            feature_state = _get_server_feature_state(invite, server.id)
            
            # Extract library IDs for this specific server from the invite's grant_library_ids
            server_library_ids = []
            if invite.grant_library_ids:
                current_app.logger.debug(f"Invite service - Processing grant_library_ids: {invite.grant_library_ids}")
                seen_library_ids = set()
                for library_token in invite.grant_library_ids:
                    lib_id = _resolve_invite_library_id_for_server(library_token, server.id)
                    if not lib_id:
                        continue
                    from app.models_media_services import MediaLibrary
                    
                    if server.service_type.value == 'kavita':
                        # Check by internal_id for Kavita
                        db_library = MediaLibrary.query.filter_by(
                            server_id=server.id
                        ).filter(MediaLibrary.internal_id == lib_id).first()
                    else:
                        # Check by external_id for other services
                        db_library = MediaLibrary.query.filter_by(
                            server_id=server.id,
                            external_id=lib_id
                        ).first()
                    
                    if db_library:
                        canonical_lib_id = (
                            str(db_library.internal_id)
                            if server.service_type.value == 'kavita'
                            else str(db_library.external_id)
                        )
                        if canonical_lib_id in seen_library_ids:
                            continue
                        seen_library_ids.add(canonical_lib_id)
                        server_library_ids.append(canonical_lib_id)
                        current_app.logger.debug(f"Invite service - Added library {lib_id} for server {server.server_nickname}")
                    else:
                        current_app.logger.debug(f"Invite service - Skipped library {lib_id} - not found in server {server.server_nickname}")
            
            current_app.logger.debug(f"Invite service - Final library IDs for server {server.server_nickname}: {server_library_ids}")

            # Handle different service types appropriately
            if server.service_type.name.upper() == 'PLEX':
                # For Plex, we need to either invite a new user or update existing friend
                if not plex_username:
                    current_app.logger.error(f"Invite service - Cannot grant Plex access: no Plex username provided for server {server.server_nickname}")
                    failed_servers.append(f"{server.server_nickname} (no Plex username - user must authenticate with Plex first)")
                    continue

                # First, check if user is already a friend on the Plex server
                is_existing_friend = False
                try:
                    if hasattr(service, '_get_admin_account'):
                        admin_account = service._get_admin_account()
                        if admin_account:
                            existing_user = admin_account.user(plex_username)
                            is_existing_friend = existing_user is not None
                            current_app.logger.debug(f"Invite service - Plex user {plex_username} is_existing_friend: {is_existing_friend}")
                except Exception as e:
                    current_app.logger.debug(f"Invite service - Could not check if Plex user exists: {e}")
                    is_existing_friend = False

                if is_existing_friend:
                    # User is already a friend - update their library access
                    if hasattr(service, 'update_user_access'):
                        current_app.logger.debug(f"Invite service - Updating existing Plex friend {plex_username}")
                        success = service.update_user_access(
                            user_id=plex_username,
                            library_ids=server_library_ids
                        )
                        if not success:
                            raise Exception("Failed to update user access for existing friend")
                        current_app.logger.debug(f"Invite service - Successfully updated Plex friend {plex_username}")
                    else:
                        raise Exception("Plex service missing update_user_access method")
                else:
                    # User is not a friend - invite them to the server
                    if hasattr(service, 'create_user'):
                        current_app.logger.debug(f"Invite service - Inviting new Plex user {plex_username} (email: {plex_email})")
                        result = service.create_user(
                            username=plex_username,
                            email=plex_email or plex_username,
                            library_ids=server_library_ids,
                            allow_downloads=feature_state.get('allow_downloads', False)
                        )
                        if isinstance(result, dict) and result.get('error'):
                            raise Exception(result['error'])
                        current_app.logger.debug(f"Invite service - Successfully invited Plex user {plex_username}")
                    else:
                        raise Exception("Plex service missing create_user method")
            else:
                # For other services (Jellyfin, Emby, etc.), create a new user
                if hasattr(service, 'create_user'):
                    # Determine the username and email for this service - check server-specific credentials first
                    from flask import session
                    server_credentials = session.get(f'invite_{invite.id}_server_{server.id}_credentials')
                    server_is_romm = server.service_type == ServiceType.ROMM
                    service_password = ''
                    
                    if server_credentials and server_credentials.get('username'):
                        # Use server-specific credentials if available (entered during invite process)
                        service_username = server_credentials['username']
                        service_password = server_credentials.get('password') or ''
                        provided_email = (server_credentials.get('email') or '').strip()
                        if server_is_romm:
                            service_email = provided_email or None
                        else:
                            service_email = provided_email or f"{service_username}@example.com"
                        current_app.logger.info(f"Using server-specific credentials for {server.service_type.name} creation: username={service_username}, email={service_email}")
                    elif app_user:
                        # Use local user account credentials if user accounts are enabled
                        service_username = app_user.localUsername
                        if server_is_romm:
                            service_email = (app_user.email or '').strip() or None
                        else:
                            service_email = app_user.email or f"{app_user.localUsername}@example.com"
                        current_app.logger.info(f"Using local user credentials for {server.service_type.name} creation: username={service_username}, email={service_email}")
                    else:
                        # Last resort fallback to plex username if no app user or server credentials
                        service_username = plex_username or f"user_{int(datetime.now().timestamp())}"
                        if server_is_romm:
                            service_email = (plex_email or '').strip() or None
                        else:
                            service_email = plex_email or f"{service_username}@example.com"
                        current_app.logger.info(f"Using fallback credentials for {server.service_type.name} creation: username={service_username}, email={service_email}")
                    
                    current_app.logger.debug(f"Invite service - Calling create_user for {server.service_type.name} user {service_username}")
                    # Step 1: Create user without library access (like manual process)
                    result = service.create_user(
                        username=service_username,
                        email=service_email,
                        password=service_password
                    )
                    if isinstance(result, dict) and result.get('error'):
                        raise Exception(result['error'])
                    elif isinstance(result, dict) and not result.get('success', True):
                        raise Exception(f"User creation failed: {result}")
                    
                    # Extract the user ID from the result
                    current_app.logger.debug(f"Invite service - create_user result: {result}")
                    external_user_id = None
                    if isinstance(result, dict):
                        external_user_id = (
                            result.get('user_id')
                            or result.get('id')
                            or result.get('Id')
                        )
                        if external_user_id is not None:
                            external_user_id = str(external_user_id).strip() or None
                        current_app.logger.debug(f"Invite service - Extracted user_id from result: {external_user_id}")
                    else:
                        current_app.logger.warning(f"Invite service - create_user result is not a dict: {type(result)}")
                    current_app.logger.debug(f"Invite service - Successfully created {server.service_type.name} user, external_user_id: {external_user_id}")
                    
                    # Step 2: Set library access using update_user_access (like manual process)
                    if external_user_id and hasattr(service, 'update_user_access'):
                        current_app.logger.debug(f"Invite service - Setting library access for {server.service_type.name} user {external_user_id}")
                        try:
                            success = service.update_user_access(
                                user_id=external_user_id,  # Use the external user ID returned from create_user
                                library_ids=server_library_ids  # Use filtered library IDs for this server
                            )
                            if success:
                                current_app.logger.debug(f"Invite service - Successfully set library access for {server.service_type.name} user {external_user_id}")
                            else:
                                current_app.logger.warning(f"Invite service - Failed to set library access for {server.service_type.name} user {external_user_id}")
                        except Exception as e:
                            current_app.logger.error(f"Invite service - Error setting library access for {server.service_type.name} user {external_user_id}: {e}")
                    elif not external_user_id:
                        current_app.logger.error(f"Invite service - Cannot set library access: external_user_id is None for {server.service_type.name}")
                    elif not hasattr(service, 'update_user_access'):
                        current_app.logger.error(f"Invite service - Service {server.service_type.name} does not have update_user_access method")
                    
                    # Store the external user ID for later service user creation
                    if external_user_id:
                        if not hasattr(server, '_temp_external_user_id'):
                            server._temp_external_user_id = external_user_id
                        current_app.logger.debug(f"Invite service - Stored external_user_id {external_user_id} for server {server.server_nickname}")
                    else:
                        current_app.logger.warning(f"Invite service - No user_id returned from create_user for {server.service_type.name}")
                else:
                    current_app.logger.error(f"Invite service - Service {service} has no create_user method")
                    failed_servers.append(f"{server.server_nickname} (missing create_user method)")
                    continue
                
            successful_servers.append(server.server_nickname)
            log_event(
                EventType.PLEX_USER_ADDED,
                f"User '{plex_username}' granted access to {server.server_nickname}. Downloads: {'enabled' if feature_state['allow_downloads'] else 'disabled'}.",
                invite_id=invite.id,
                details={
                    'plex_user': plex_username,
                    'server': server.server_nickname,
                    'allow_downloads': feature_state["allow_downloads"],
                    'allow_4k_transcode': feature_state["allow_4k_transcode"],
                    'allow_live_tv': feature_state["allow_live_tv"],
                    'invite_to_plex_home': feature_state["invite_to_plex_home"],
                },
            )
            
        except Exception as e:
            failed_servers.append(f"{server.server_nickname} ({str(e)})")
            log_event(EventType.ERROR_PLEX_API, f"Failed to grant access to {server.server_nickname} for {plex_username} via invite {invite.id}: {e}", invite_id=invite.id)
    
    # Check if any servers were successful
    if not successful_servers:
        error_details = "; ".join(failed_servers)
        return False, f"Could not grant access to any servers: {error_details}. Please contact admin."
    
    # Log partial success if some servers failed
    if failed_servers:
        current_app.logger.warning(f"Partial success for invite {invite.id}: Access granted to {successful_servers}, but failed for {failed_servers}")
        log_event(EventType.ERROR_GENERAL, f"Partial success for invite {invite.id}: granted access to {successful_servers}, failed for {failed_servers}", invite_id=invite.id)

    # Create service accounts and link them to local user
    try:
        user_access_expires_at = None
        if invite.membership_duration_days and invite.membership_duration_days > 0:
            user_access_expires_at = datetime.now(timezone.utc) + timedelta(days=invite.membership_duration_days)
            current_app.logger.info(f"User access from invite {invite.id} will expire on {user_access_expires_at}.")

        # Check if user accounts are enabled
        allow_user_accounts = Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
        
        # Create single local user record for MUM login only if user accounts are enabled
        current_app.logger.info(f"=== INVITE SERVICE DEBUG: Creating service users for {len(servers_to_grant_access)} servers ===")
        current_app.logger.info(f"App user: {app_user.localUsername if app_user else 'None'} (ID: {app_user.id if app_user else 'None'})")
        current_app.logger.info(f"Plex user: {plex_username} (UUID: {plex_user_uuid})")
        current_app.logger.info(f"Allow user accounts: {allow_user_accounts}")
        
        # Use existing app_user or create new local user only if user accounts are enabled
        user_app_access = None
        if app_user:
            user_app_access = app_user
            current_app.logger.info(f"Using existing local user: {user_app_access.localUsername} (ID: {user_app_access.id})")
        elif allow_user_accounts:
            # Create new local user record only when user accounts are enabled
            base_username = plex_username or f"user_{int(datetime.now().timestamp())}"
            base_email = plex_email or f"{base_username}@example.com"
            
            user_app_access = User(
                userType=UserType.LOCAL,
                localUsername=base_username,
                email=base_email,
                allow_4k_transcode=bool(invite.allow_4k_transcode),
                used_invite_id=invite.id,
                access_expires_at=user_access_expires_at,
                notes=f"Created via invite {invite.id} (service-only)"
            )
            
            # Add Discord info to local user if provided (global Discord linking)
            if discord_user_info:
                user_app_access.discord_user_id = discord_user_info.get('id')
                user_app_access.discord_username = discord_user_info.get('username')
                user_app_access.discord_avatar_hash = discord_user_info.get('avatar')
                user_app_access.discord_email = discord_user_info.get('email')
                user_app_access.discord_email_verified = discord_user_info.get('verified')
            
            # Add local user to session
            db.session.add(user_app_access)
            db.session.flush()  # Get the ID
            current_app.logger.info(f"Created new local user: {user_app_access.localUsername} (ID: {user_app_access.id})")
        else:
            current_app.logger.info("User accounts are disabled - creating service-only accounts without local user record")
        
        created_user_media_accesses = []
        
        # Create service user records for each server
        for server in servers_to_grant_access:
            current_app.logger.info(f"--- Processing server: {server.server_nickname} (Type: {server.service_type.name}) ---")
            feature_state = _get_server_feature_state(invite, server.id)
            
            # Extract library IDs for this specific server from the invite's grant_library_ids
            server_library_ids = []
            if invite.grant_library_ids:
                current_app.logger.debug(f"Invite service - Processing grant_library_ids for {server.server_nickname}: {invite.grant_library_ids}")
                seen_library_ids = set()
                for library_token in invite.grant_library_ids:
                    lib_id = _resolve_invite_library_id_for_server(library_token, server.id)
                    if not lib_id:
                        continue
                    try:
                        from app.models_media_services import MediaLibrary
                        
                        if server.service_type.value == 'kavita':
                            # Check by internal_id for Kavita
                            db_library = MediaLibrary.query.filter_by(
                                server_id=server.id
                            ).filter(MediaLibrary.internal_id == lib_id).first()
                        else:
                            # Check by external_id for other services  
                            db_library = MediaLibrary.query.filter_by(
                                server_id=server.id,
                                external_id=lib_id
                            ).first()
                        
                        if db_library:
                            canonical_lib_id = (
                                str(db_library.internal_id)
                                if server.service_type.value == 'kavita'
                                else str(db_library.external_id)
                            )
                            if canonical_lib_id in seen_library_ids:
                                continue
                            seen_library_ids.add(canonical_lib_id)
                            server_library_ids.append(canonical_lib_id)
                            current_app.logger.info(f"Added validated library {lib_id} for server {server.server_nickname}")
                        else:
                            current_app.logger.debug(f"Skipped library {lib_id} - not found in server {server.server_nickname}")
                    except Exception as e:
                        current_app.logger.error(f"Database error validating library {lib_id} for server {server.server_nickname}: {e}")
            
            current_app.logger.info(f"Final library IDs for {server.server_nickname}: {server_library_ids}")
            
            # Determine service-specific username and email
            if server.service_type.name.upper() == 'PLEX':
                # For Plex, use the authenticated Plex user info
                if not plex_username:
                    current_app.logger.warning(f"No Plex username provided for Plex server {server.server_nickname}")
                    continue
                service_username = plex_username
                service_email = plex_email
                current_app.logger.info(f"Plex server - using username: {service_username}, email: {service_email}")
            else:
                # For other services, check for server-specific credentials first
                from flask import session
                server_credentials = session.get(f'invite_{invite.id}_server_{server.id}_credentials')
                
                if server_credentials and server_credentials.get('username'):
                    # Use server-specific credentials if available
                    service_username = server_credentials['username']
                    provided_email = (server_credentials.get('email') or '').strip()
                    if server.service_type == ServiceType.ROMM:
                        service_email = provided_email or None
                    else:
                        service_email = provided_email or f"{service_username}@example.com"
                    current_app.logger.info(f"Non-Plex server - using server-specific credentials: username={service_username}, email={service_email}")
                else:
                    # Fallback to local user credentials or plex user info
                    if user_app_access and user_app_access.localUsername:
                        service_username = user_app_access.localUsername
                        if server.service_type == ServiceType.ROMM:
                            service_email = (user_app_access.email or '').strip() or None
                        else:
                            service_email = user_app_access.email or f"{service_username}@example.com"
                        current_app.logger.info(f"Non-Plex server - using local user credentials: username={service_username}, email={service_email}")
                    else:
                        # Last resort: use plex username if available
                        service_username = plex_username or f"user_{int(datetime.now().timestamp())}"
                        if server.service_type == ServiceType.ROMM:
                            service_email = (plex_email or '').strip() or None
                        else:
                            service_email = plex_email or f"{service_username}@example.com"
                        current_app.logger.info(f"Non-Plex server - using fallback credentials: username={service_username}, email={service_email}")
            
            # Create service user record for this specific server
            user_media_access = User(
                userType=UserType.SERVICE,
                linkedUserId=user_app_access.uuid if user_app_access else None,
                server_id=server.id,
                external_user_id=str(plex_user_uuid) if server.service_type.name.upper() == 'PLEX' else getattr(server, '_temp_external_user_id', None),
                external_username=service_username,
                external_email=service_email,
                allowed_library_ids=server_library_ids,  # Use server-specific library IDs
                allow_downloads=bool(feature_state["allow_downloads"]),
                allow_4k_transcode=bool(feature_state["allow_4k_transcode"]),
                used_invite_id=invite.id,
                service_join_date=datetime.now(timezone.utc),
                is_discord_bot_whitelisted=bool(invite.grant_bot_whitelist),
                is_purge_whitelisted=bool(invite.grant_purge_whitelist)
            )
            
            # Add service-specific fields
            if server.service_type.name.upper() == 'PLEX':
                user_media_access.external_user_alt_id = plex_user_uuid
                user_media_access.external_avatar_url = plex_thumb
            if server.service_type in {ServiceType.PLEX, ServiceType.JELLYFIN, ServiceType.EMBY}:
                user_media_access.sync_downloads_role(user_media_access.allow_downloads)
            
            # Add service user to session
            db.session.add(user_media_access)
            created_user_media_accesses.append((user_media_access, server))
            current_app.logger.info(f"✅ Created service user for {service_username} (Local User ID: {user_app_access.id if user_app_access else 'None'}) on server {server.server_nickname}")
            current_app.logger.debug(f"Service user details - ID: {user_media_access.id}, username: {user_media_access.external_username}, email: {user_media_access.external_email}")
        
        # Use the local user as the primary user reference, or the first service user if no local user
        if not created_user_media_accesses:
            raise Exception("No user media access records created")
        
        new_user = user_app_access if user_app_access else created_user_media_accesses[0][0]
        
        invite.current_uses += 1
        
        plex_user_info = {'uuid': plex_user_uuid, 'username': plex_username, 'email': plex_email, 'thumb': plex_thumb}
        usage_log = record_invite_usage_attempt(invite.id, ip_address, plex_user_info=plex_user_info, discord_user_info=discord_user_info, status_message="Invite accepted successfully.")
        
        local_users_count = 1 if user_app_access else 0
        current_app.logger.info(f"=== COMMITTING SESSION - {local_users_count} local user and {len(created_user_media_accesses)} service user records ===")
        
        # Log all created user media access records
        for user_media_access, server in created_user_media_accesses:
            current_app.logger.info(f"Service user - ID: {user_media_access.id}, external_username: {user_media_access.external_username}, server: {server.server_nickname}")
        
        # Set usage log user ID
        usage_log.userId = new_user.uuid
        usage_log.accepted_invite = True
        db.session.add(usage_log)
        db.session.add(invite)

        current_app.logger.info(f"=== COMMITTING TRANSACTION ===")
        current_app.logger.info(f"About to commit: {local_users_count} local user, {len(created_user_media_accesses)} service user records, usage log, invite update")
        
        db.session.commit()
        current_app.logger.info("✅ All changes committed to database")
        
        # Get whitelist info from service user for logging
        first_media_access = created_user_media_accesses[0][0] if created_user_media_accesses else None
        purge_whitelisted = first_media_access.is_purge_whitelisted if first_media_access else False
        bot_whitelisted = first_media_access.is_discord_bot_whitelisted if first_media_access else False

        log_event(EventType.INVITE_USER_ACCEPTED_AND_SHARED, 
                  f"User '{plex_username}' accepted invite '{invite.id}'. Purge WL: {purge_whitelisted}, Bot WL: {bot_whitelisted}. Access expires: {user_access_expires_at.strftime('%Y-%m-%d') if user_access_expires_at else 'Permanent'}.", 
                  user_id=new_user.id, invite_id=invite.id)
        
        return True, new_user 

    except IntegrityError as ie_user:
        db.session.rollback()
        current_app.logger.error(f"Database integrity error creating MUM user {plex_username} from invite {invite.id}: {ie_user}", exc_info=True)
        log_event(EventType.ERROR_GENERAL, f"DB integrity error creating user {plex_username} from invite {invite.id}: {ie_user}", invite_id=invite.id)
        return False, "A database error occurred creating your user account. This could be due to a conflict. Please contact admin."
    except Exception as e_user:
        db.session.rollback()
        current_app.logger.error(f"Failed to create MUM user {plex_username} from invite {invite.id} after Plex share: {e_user}", exc_info=True)
        log_event(EventType.ERROR_GENERAL, f"Error creating MUM user {plex_username} from invite {invite.id} after Plex share: {e_user}", invite_id=invite.id)
        return False, f"An unexpected error occurred creating your user account after Plex access was granted: {e_user}. Please contact admin."
