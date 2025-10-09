# File: app/services/task_service.py
from flask import current_app
from app.extensions import scheduler 
from app.models import Setting, EventType, User, UserType
from app.models_media_services import ServiceType, MediaStreamHistory
from app.utils.helpers import log_event
from . import user_service # user_service is needed for deleting users
from app.services.media_service_manager import MediaServiceManager
from datetime import datetime, timezone, timedelta 
from app.extensions import db

_active_stream_sessions = {}

# --- Scheduled Tasks ---

def monitor_media_sessions_task():
    """
    Statefully monitors media sessions from all services (Plex, Jellyfin, etc.), with corrected session tracking and duration calculation.
    - Creates a new MediaStreamHistory record when a new session starts.
    - Continuously updates the view offset (progress) on the SAME record for an ongoing session.
    - Correctly calculates final playback duration from the last known viewOffset when the session stops.
    - Enforces "No 4K Transcoding" user setting with improved detection.
    """
    global _active_stream_sessions
    with scheduler.app.app_context():
        current_app.logger.info("=== MEDIA SESSION MONITOR TASK STARTING ===")
        
        # Check for any active media servers from the database
        all_servers = MediaServiceManager.get_all_servers(active_only=True)
        current_app.logger.debug(f"Found {len(all_servers)} active media servers in database")
        
        for server in all_servers:
            current_app.logger.debug(f"Server - Name: {server.server_nickname}, Type: {server.service_type.value}, Active: {server.is_active}")
        
        if not all_servers:
            current_app.logger.warning("No active media servers configured in the database. Skipping task.")
            return

        try:
            # This gets sessions from all active servers (Plex, Jellyfin, etc.)
            current_app.logger.debug("Calling MediaServiceManager.get_all_active_sessions()...")
            active_sessions = MediaServiceManager.get_all_active_sessions()
            now_utc = datetime.now(timezone.utc)
            current_app.logger.debug(f"Retrieved {len(active_sessions)} active sessions from MediaServiceManager")
            
            if len(active_sessions) == 0:
                current_app.logger.debug("No active sessions found - this could be normal if no one is streaming")
            else:
                current_app.logger.debug(f"Active sessions details:")
                for i, session in enumerate(active_sessions):
                    if isinstance(session, dict):
                        current_app.logger.debug(f"  Session {i+1}: Jellyfin session ID {session.get('Id', 'unknown')}")
                    else:
                        current_app.logger.debug(f"  Session {i+1}: Plex session key {getattr(session, 'sessionKey', 'unknown')}")
            
            current_app.logger.info(f"Found {len(active_sessions)} active sessions across all servers.")

            # Handle both Plex and Jellyfin session formats
            current_sessions_dict = {}
            for session in active_sessions:
                # Extract session key based on session type
                if isinstance(session, dict):
                    # Jellyfin session (dict format)
                    session_key = session.get('Id')
                else:
                    # Plex session (object format)
                    session_key = getattr(session, 'sessionKey', None)
                
                if session_key:
                    current_sessions_dict[session_key] = session
                else:
                    session_type = "Jellyfin" if isinstance(session, dict) else "Plex"
                    current_app.logger.warning(f"Session missing key: {session_type} - {type(session)}")
            
            current_session_keys = set(current_sessions_dict.keys())

            # Step 1: Check for stopped streams
            stopped_session_keys = set(_active_stream_sessions.keys()) - current_session_keys
            if stopped_session_keys:
                current_app.logger.info(f"Found {len(stopped_session_keys)} stopped sessions: {list(stopped_session_keys)}")
                for session_key in stopped_session_keys:
                    stream_history_id = _active_stream_sessions.pop(session_key, None)
                    if stream_history_id:
                        history_record = db.session.get(MediaStreamHistory, stream_history_id)
                        if history_record and not history_record.stopped_at:
                            final_duration = history_record.view_offset_at_end_seconds
                            history_record.duration_seconds = final_duration if final_duration and final_duration > 0 else 0
                            history_record.stopped_at = now_utc
                            current_app.logger.info(f"DURATION DEBUG: Session {session_key} stopped - view_offset_at_end_seconds: {history_record.view_offset_at_end_seconds}s, final duration_seconds: {history_record.duration_seconds}s")
                            current_app.logger.info(f"Marked session {session_key} (DB ID: {stream_history_id}) as stopped. Final duration: {history_record.duration_seconds}s.")
                        else:
                            current_app.logger.warning(f"Could not find or already stopped history record for DB ID {stream_history_id}")
            
            # Step 2: Check for new and ongoing streams
            if not current_sessions_dict:
                current_app.logger.info("No new or ongoing sessions to process.")
            else:
                current_app.logger.info(f"Processing {len(current_sessions_dict)} new or ongoing sessions...")

            # Import MediaServer for both Plex and Jellyfin session handling
            from app.models_media_services import MediaServer
            
            for session_key, session in current_sessions_dict.items():
                # Handle different session formats for user lookup
                mum_user = None
                user_media_access = None
                
                if isinstance(session, dict):
                    # Jellyfin session - look up by username
                    jellyfin_username = session.get('UserName')
                    if jellyfin_username:
                        # Find service user for Jellyfin username on the correct server
                        jellyfin_server = MediaServer.query.filter_by(service_type=ServiceType.JELLYFIN).first()
                        if jellyfin_server:
                            user_media_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                                server_id=jellyfin_server.id,
                                external_username=jellyfin_username
                            ).first()
                            if user_media_access:
                                # Check if it's linked to a local user account
                                current_app.logger.debug(f"LINKED: Found service user for Jellyfin username '{jellyfin_username}' (ID: {user_media_access.id})")
                                current_app.logger.debug(f"LINKED: linkedUserId = {user_media_access.linkedUserId}")
                                current_app.logger.debug(f"LINKED: external_username = {user_media_access.external_username}")
                                current_app.logger.debug(f"LINKED: server = {user_media_access.server.server_nickname}")
                                
                                # In unified model, get linked user via linkedUserId
                                mum_user = None
                                if user_media_access.linkedUserId:
                                    mum_user = User.query.filter_by(userType=UserType.LOCAL, uuid=user_media_access.linkedUserId).first()
                                current_app.logger.debug(f"LINKED: linked user = {mum_user}")
                                
                                if not mum_user:
                                    current_app.logger.info(f"Found standalone service user for Jellyfin username '{jellyfin_username}' (ID: {user_media_access.id}). Processing as standalone user.")
                                else:
                                    current_app.logger.info(f"Found linked service user for Jellyfin username '{jellyfin_username}' (ID: {user_media_access.id}) linked to local user (ID: {mum_user.id}, username: {mum_user.localUsername}). Processing as linked user.")
                            else:
                                current_app.logger.warning(f"No service user found for Jellyfin username '{jellyfin_username}' on server '{jellyfin_server.server_nickname}'. Skipping session.")
                                continue
                        else:
                            current_app.logger.warning(f"No Jellyfin server configured. Skipping session {session_key}.")
                            continue
                    else:
                        current_app.logger.warning(f"Jellyfin session {session_key} is missing UserName. Skipping.")
                        continue
                else:
                    # Plex session - look up by user ID via service user
                    user_id_from_session = None
                    
                    # Try different ways to get user ID from Plex session
                    if hasattr(session, 'user') and session.user:
                        if hasattr(session.user, 'id'):
                            user_id_from_session = session.user.id
                        else:
                            current_app.logger.warning(f"Plex session {session_key} user object has no 'id' attribute")
                    elif hasattr(session, 'userId'):
                        user_id_from_session = session.userId
                    else:
                        current_app.logger.warning(f"Plex session {session_key} has no user information. Available attributes: {[attr for attr in dir(session) if not attr.startswith('_')]}")
                        continue
                    
                    if user_id_from_session:
                        # Look up user by external_user_id in service user for Plex server
                        plex_server = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
                        if plex_server:
                            user_media_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                                server_id=plex_server.id,
                                external_user_id=str(user_id_from_session)
                            ).first()
                            if user_media_access:
                                # Check if it's linked to a local user account
                                current_app.logger.debug(f"LINKED: Found service user for Plex User ID {user_id_from_session} (ID: {user_media_access.id})")
                                current_app.logger.debug(f"LINKED: linkedUserId = {user_media_access.linkedUserId}")
                                current_app.logger.debug(f"LINKED: external_username = {user_media_access.external_username}")
                                current_app.logger.debug(f"LINKED: server = {user_media_access.server.server_nickname}")
                                
                                # In unified model, get linked user via linkedUserId
                                mum_user = None
                                if user_media_access.linkedUserId:
                                    mum_user = User.query.filter_by(userType=UserType.LOCAL, uuid=user_media_access.linkedUserId).first()
                                current_app.logger.debug(f"LINKED: linked user = {mum_user}")
                                
                                if not mum_user:
                                    current_app.logger.info(f"Found standalone service user for Plex User ID {user_id_from_session} (ID: {user_media_access.id}). Processing as standalone user.")
                                else:
                                    current_app.logger.info(f"Found linked service user for Plex User ID {user_id_from_session} (ID: {user_media_access.id}) linked to local user (ID: {mum_user.id}, username: {mum_user.localUsername}). Processing as linked user.")
                            else:
                                current_app.logger.warning(f"Could not find service user for Plex User ID {user_id_from_session} from session {session_key}. Skipping.")
                                continue
                        else:
                            current_app.logger.warning(f"No Plex server configured. Skipping session {session_key}.")
                            continue
                    else:
                        current_app.logger.warning(f"Could not extract user ID from Plex session {session_key}. Skipping.")
                        continue
                
                # Process session for user

                # If the session is new, create the history record
                if session_key not in _active_stream_sessions:
                    current_app.logger.info(f"New session detected: {session_key}. Creating history record.")
                    
                    # Handle different session formats (Plex vs Jellyfin)
                    if hasattr(session, 'player'):
                        # Plex session format
                        media_duration_ms = getattr(session, 'duration', 0)
                        media_duration_s = int(media_duration_ms / 1000) if media_duration_ms else 0
                        
                        platform = getattr(session.player, 'platform', 'N/A')
                        product = getattr(session.player, 'product', 'N/A')
                        player_title = getattr(session.player, 'title', 'N/A')
                        ip_address = getattr(session.player, 'address', 'N/A')
                        is_lan = getattr(session.player, 'local', False)
                        media_title = getattr(session, 'title', "Unknown")
                        media_type = getattr(session, 'type', "Unknown")
                        grandparent_title = getattr(session, 'grandparentTitle', None)
                        parent_title = getattr(session, 'parentTitle', None)
                        rating_key = str(getattr(session, 'ratingKey', None))
                        view_offset_ms = getattr(session, 'viewOffset', 0)
                        view_offset_s = int(view_offset_ms / 1000) if view_offset_ms else 0
                        
                        # Extract external_media_item_id from Plex session
                        external_media_item_id = None
                        if hasattr(session, 'media') and session.media:
                            # For movies and episodes, use the media ID from the media array
                            first_media = session.media[0]
                            if hasattr(first_media, 'id'):
                                external_media_item_id = str(first_media.id)
                        
                        # For shows, external_media_item_id remains None (we use rating_key for shows)
                        
                        # Extract library name from Plex session
                        library_name = getattr(session, 'librarySectionTitle', None)
                    else:
                        # Jellyfin session format (dict)
                        now_playing = session.get('NowPlayingItem', {})
                        play_state = session.get('PlayState', {})
                        
                        # Duration in ticks (100ns units) for Jellyfin
                        runtime_ticks = now_playing.get('RunTimeTicks', 0)
                        media_duration_s = int(runtime_ticks / 10000000) if runtime_ticks else 0  # Convert ticks to seconds
                        
                        platform = session.get('Client', 'N/A')
                        product = session.get('ApplicationVersion', 'N/A')
                        player_title = session.get('DeviceName', 'N/A')
                        ip_address = session.get('RemoteEndPoint', 'N/A')
                        is_lan = session.get('IsLocal', True)  # Jellyfin's IsLocal field indicates local connection
                        media_title = now_playing.get('Name', "Unknown")
                        media_type = now_playing.get('Type', "Unknown")
                        grandparent_title = now_playing.get('SeriesName', None)
                        parent_title = now_playing.get('SeasonName', None)
                        rating_key = str(now_playing.get('Id', None))
                        
                        # For Jellyfin, the Id is already the correct external_media_item_id
                        external_media_item_id = rating_key
                        
                        # Position in ticks for Jellyfin
                        position_ticks = play_state.get('PositionTicks', 0)
                        view_offset_s = int(position_ticks / 10000000) if position_ticks else 0  # Convert ticks to seconds
                        
                        # Extract library name from Jellyfin session
                        # For Jellyfin, we might need to look up the library name by ParentId or LibraryId
                        library_name = now_playing.get('ParentName', None)  # This might contain library info
                        if not library_name:
                            # Try alternative fields that might contain library information
                            library_name = now_playing.get('ChannelName', None) or now_playing.get('CollectionType', None)

                    # Determine which server this session belongs to
                    if isinstance(session, dict):
                        # Jellyfin session - find Jellyfin server
                        jellyfin_server = MediaServer.query.filter_by(service_type=ServiceType.JELLYFIN).first()
                        current_server = jellyfin_server
                    else:
                        # Plex session - find Plex server
                        plex_server = MediaServer.query.filter_by(service_type=ServiceType.PLEX).first()
                        current_server = plex_server
                    
                    if not current_server:
                        current_app.logger.warning(f"Could not find server for session {session_key}. Skipping.")
                        continue
                    
                    # Safety check to ensure we have either a linked user or standalone user
                    if not mum_user and not user_media_access:
                        current_app.logger.warning(f"No user found for session {session_key}. Skipping.")
                        continue
                    
                    if mum_user:
                        current_app.logger.debug(f"Creating new MediaStreamHistory record for linked user session {session_key}")
                        current_app.logger.debug(f"Linked User: {mum_user.localUsername} (ID: {mum_user.id})")
                        user_display_name = mum_user.localUsername
                        user_id = mum_user.id
                    else:
                        current_app.logger.debug(f"Creating new MediaStreamHistory record for standalone user session {session_key}")
                        current_app.logger.debug(f"Standalone User: {user_media_access.get_display_name()} (Service User ID: {user_media_access.id})")
                        user_display_name = user_media_access.get_display_name()
                        user_id = user_media_access.id
                    
                    current_app.logger.debug(f"Server: {current_server.server_nickname} (ID: {current_server.id})")
                    current_app.logger.debug(f"Media: {media_title} ({media_type})")
                    current_app.logger.debug(f"Platform: {platform}, Player: {player_title}")
                    
                    new_history_record = MediaStreamHistory(
                        user_uuid=user_media_access.uuid,  # Use unified user_uuid field
                        server_id=current_server.id,
                        session_key=str(session_key),
                        rating_key=rating_key,
                        external_media_item_id=external_media_item_id,
                        started_at=now_utc,
                        platform=platform,
                        product=product,
                        player=player_title,
                        ip_address=ip_address,
                        is_lan=is_lan,
                        media_title=media_title,
                        media_type=media_type,
                        grandparent_title=grandparent_title,
                        parent_title=parent_title,
                        library_name=library_name,
                        media_duration_seconds=media_duration_s,
                        view_offset_at_end_seconds=view_offset_s
                    )
                    
                    current_app.logger.debug(f"About to add MediaStreamHistory record to database...")
                    db.session.add(new_history_record)
                    
                    current_app.logger.debug(f"About to flush database session...")
                    db.session.flush() # Flush to get the ID
                    
                    _active_stream_sessions[session_key] = new_history_record.id
                    current_app.logger.debug(f"Successfully created MediaStreamHistory record (ID: {new_history_record.id}) for session {session_key}.")
                    current_app.logger.debug(f"Added session {session_key} to _active_stream_sessions tracking")
                
                # If the session is ongoing, update its progress
                else:
                    current_app.logger.debug(f"Updating existing session {session_key}")
                    history_record_id = _active_stream_sessions.get(session_key)
                    if history_record_id:
                        current_app.logger.debug(f"Found history record ID {history_record_id} for session {session_key}")
                        history_record = db.session.get(MediaStreamHistory, history_record_id)
                        if history_record:
                            # Handle different session formats for progress updates
                            if hasattr(session, 'player'):
                                # Plex session format
                                view_offset_ms = getattr(session, 'viewOffset', 0)
                                current_offset_s = int(view_offset_ms / 1000) if view_offset_ms else 0
                            else:
                                # Jellyfin session format (dict)
                                play_state = session.get('PlayState', {})
                                position_ticks = play_state.get('PositionTicks', 0)
                                current_offset_s = int(position_ticks / 10000000) if position_ticks else 0  # Convert ticks to seconds
                            
                            current_app.logger.debug(f"Updating progress from {history_record.view_offset_at_end_seconds}s to {current_offset_s}s")
                            history_record.view_offset_at_end_seconds = current_offset_s
                            current_app.logger.debug(f"Successfully updated existing MediaStreamHistory record (ID: {history_record_id})")
                        else:
                            current_app.logger.debug(f"Could not find existing MediaStreamHistory record with ID {history_record_id} for ongoing session {session_key}.")
                    else:
                        current_app.logger.error(f"CRITICAL: Session {session_key} was in tracked keys but had no DB ID!")

                # Update the user's last activity/streamed time
                if mum_user:
                    # For linked users, update the local user last_streamed_at
                    current_app.logger.debug(f"Updating last_streamed_at for linked user {mum_user.localUsername} (ID: {mum_user.id})")
                    user_service.update_user_last_streamed_by_id(mum_user.id, now_utc)
                else:
                    # For standalone users, update the service user last_activity_at
                    current_app.logger.debug(f"Updating last_activity_at for standalone user {user_media_access.get_display_name()} (Service User ID: {user_media_access.id})")
                    user_media_access.last_activity_at = now_utc
                    db.session.add(user_media_access)

            # Commit all changes for this cycle
            current_app.logger.debug("About to commit all database changes...")
            db.session.commit()
            current_app.logger.debug("Database commit successful!")
            current_app.logger.info("=== MEDIA SESSION MONITOR TASK FINISHED ===")
            
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"Fatal error in monitor_plex_sessions_task: {e}", exc_info=True)

def check_user_access_expirations_task():
    """
    Checks for users whose access has expired and removes them from MUM and Plex.
    This version correctly compares naive datetimes to ensure accuracy.
    """
    with scheduler.app.app_context():
        # Check for expired users
        now_naive = datetime.utcnow()
        expired_users = User.query.filter(
            User.userType == UserType.LOCAL,
            User.access_expires_at.isnot(None), 
            User.access_expires_at <= now_naive
        ).all()

        if not expired_users:
            return

        current_app.logger.info(f"Found {len(expired_users)} expired users, processing removals...")
        
        system_admin_id = None
        try:
            admin = User.get_owner()
            if admin:
                system_admin_id = admin.id
            pass
        except Exception as e_admin:
            current_app.logger.warning(f"Could not fetch admin_id for logging expiration task: {e_admin}")

        removal_count = 0
        for user in expired_users:
            username_for_log = user.get_display_name()
            mum_user_id_for_log = user.id
            original_expiry_for_log = user.access_expires_at
            
            try:
                current_app.logger.info(f"Removing expired user '{username_for_log}' (expired: {original_expiry_for_log})")
                
                # Use the unified user service for deletion
                from app.services.unified_user_service import UnifiedUserService
                UnifiedUserService.delete_user_completely(user_id=mum_user_id_for_log, admin_id=system_admin_id)
                removal_count += 1
                
                log_event(
                    EventType.MUM_USER_DELETED_FROM_MUM,
                    f"User '{username_for_log}' automatically removed due to expired invite-based access (expired: {original_expiry_for_log}).",
                    user_id=mum_user_id_for_log,
                    admin_id=system_admin_id, 
                    details={"reason": "Automated removal: invite access duration expired."}
                )
                current_app.logger.info(f"Successfully removed expired user '{username_for_log}'")
                
            except Exception as e:
                current_app.logger.error(f"Error removing expired user '{username_for_log}': {e}", exc_info=True)
                log_event(
                    EventType.ERROR_GENERAL,
                    f"Task failed to remove expired user '{username_for_log}': {e}",
                    user_id=mum_user_id_for_log,
                    admin_id=system_admin_id
                )
        
        current_app.logger.info(f"User expiration check complete. Removed: {removal_count}/{len(expired_users)} users.")

# Add this helper function to check scheduler status
def debug_scheduler_status():
    """Debug function to check scheduler status"""
    with scheduler.app.app_context():
        current_app.logger.info("=== SCHEDULER DEBUG INFO ===")
        current_app.logger.info(f"Scheduler running: {scheduler.running}")
        current_app.logger.info(f"Scheduler state: {scheduler.state}")
        
        jobs = scheduler.get_jobs()
        current_app.logger.info(f"Total jobs: {len(jobs)}")
        
        for job in jobs:
            current_app.logger.info(f"Job ID: {job.id}")
            current_app.logger.info(f"  Function: {job.func}")
            current_app.logger.info(f"  Next run: {job.next_run_time}")
            current_app.logger.info(f"  Trigger: {job.trigger}")
            
        # Check specific expiration job
        expiration_job = scheduler.get_job('check_user_expirations')
        if expiration_job:
            current_app.logger.info(f"Expiration job found:")
            current_app.logger.info(f"  Next run: {expiration_job.next_run_time}")
            current_app.logger.info(f"  Trigger: {expiration_job.trigger}")
        else:
            current_app.logger.warning("Expiration job NOT found in scheduler!")
        
        current_app.logger.info("=== END SCHEDULER DEBUG ===")

# Add this manual trigger function
def manually_trigger_expiration_check():
    """Manually trigger the expiration check for testing"""
    current_app.logger.info("MANUAL TRIGGER: Running expiration check manually...")
    check_user_access_expirations_task()
    current_app.logger.info("MANUAL TRIGGER: Expiration check completed.")

def _schedule_job_if_not_exists_or_reschedule(job_id, func, trigger_type, **trigger_args):
    """Helper to add or reschedule a job."""
    if not scheduler.running:
        current_app.logger.warning(f"Task_Service: APScheduler not running. Cannot schedule job '{job_id}'.")
        return False
    
    try:
        existing_job = scheduler.get_job(job_id)
        if existing_job:
            # Simple reschedule, more complex trigger comparison might be needed if triggers vary widely
            scheduler.reschedule_job(job_id, trigger=trigger_type, **trigger_args)
            current_app.logger.info(f"Rescheduled task: {job_id}")
        else:
            scheduler.add_job(id=job_id, func=func, trigger=trigger_type, **trigger_args)
            current_app.logger.info(f"Scheduled task: {job_id}")
        return True
    except Exception as e:
        current_app.logger.error(f"Task_Service: Error adding/rescheduling job '{job_id}': {e}", exc_info=True)
        try:
            log_event(EventType.ERROR_GENERAL, f"Failed to schedule/reschedule task '{job_id}': {e}")
        except Exception as e_log:
            current_app.logger.error(f"Task_Service: Failed to log scheduling error for '{job_id}' to DB: {e_log}")
        return False


def schedule_all_tasks():
    """Schedules all recurring tasks defined in the application."""
    # Get the session monitoring interval from settings
    try:
        interval_str = Setting.get('SESSION_MONITORING_INTERVAL_SECONDS', '30')
        session_interval_seconds = int(interval_str)
        if session_interval_seconds < 10: # Enforce minimum
             session_interval_seconds = 10
    except (ValueError, TypeError) as e:
        session_interval_seconds = 30
        current_app.logger.warning(f"Invalid session monitoring interval, using default: {session_interval_seconds}s")

    # 1. Media Session Monitoring (Plex, Jellyfin, etc.)
    if _schedule_job_if_not_exists_or_reschedule(
        job_id='monitor_media_sessions',
        func=monitor_media_sessions_task,
        trigger_type='interval',
        seconds=session_interval_seconds,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=10) # Start shortly after app start
    ):
        log_event(EventType.APP_STARTUP, f"Media session monitoring scheduled ({session_interval_seconds}s interval)")

    # 2. User Access Expiration Check
    if _schedule_job_if_not_exists_or_reschedule(
        job_id='check_user_expirations',
        func=check_user_access_expirations_task,
        trigger_type='interval',
        seconds=session_interval_seconds,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=30)
    ):
        log_event(EventType.APP_STARTUP, f"User expiration check scheduled ({session_interval_seconds}s interval)")
