# File: app/services/task_service.py
from flask import current_app
from app.extensions import scheduler
from app.models import Setting, EventType, User, UserType
from app.models_media_services import MediaServer, MediaStreamHistory, ServiceType
from app.utils.helpers import log_event
from . import user_service  # user_service is needed for deleting users
from app.services.media_service_manager import MediaServiceManager
from datetime import datetime, timezone, timedelta
from app.extensions import db
from typing import Any, Dict, Iterable, Optional, Set, Union

# session_key -> {'history_id': int, 'service_type': str, 'server_id': Optional[int]}
_active_stream_sessions: Dict[str, Dict[str, Any]] = {}

def _normalize_service_type_set(
    types: Optional[Iterable[Union[ServiceType, str]]]
) -> Optional[Set[ServiceType]]:
    if types is None:
        return None
    normalized: Set[ServiceType] = set()
    for svc_type in types:
        if isinstance(svc_type, ServiceType):
            normalized.add(svc_type)
        elif isinstance(svc_type, str):
            try:
                normalized.add(ServiceType(svc_type.lower()))
            except ValueError:
                current_app.logger.warning(
                    "task_service: Ignoring unknown service type '%s' in filter",
                    svc_type,
                )
        else:
            current_app.logger.warning(
                "task_service: Unsupported service type filter value %s (%s)",
                svc_type,
                type(svc_type),
            )
    return normalized

def _get_total_tracked_session_count() -> int:
    return len(_active_stream_sessions)

# --- Scheduled Tasks ---

def monitor_media_sessions_task():
    """
    Background scheduler entry point. Delegates to _run_media_session_monitor with the standard
    configuration (exclude Plex, which is handled by the WebSocket monitor).
    """
    with scheduler.app.app_context():
        _run_media_session_monitor(
            source="scheduler",
            exclude_service_types={ServiceType.PLEX, ServiceType.EMBY, ServiceType.JELLYFIN},
        )

def _run_media_session_monitor(
    include_service_types: Optional[Iterable[Union[ServiceType, str]]] = None,
    exclude_service_types: Optional[Iterable[Union[ServiceType, str]]] = None,
    source: str = "manual",
    live_service_types: Optional[Iterable[Union[ServiceType, str]]] = None,
    summary_data: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Core logic for processing active media sessions, parameterised so it can be invoked from the
    APScheduler job as well as real-time WebSocket monitors (e.g. Plex).
    """
    global _active_stream_sessions

    source_label = source.upper()
    current_app.logger.info("=== MEDIA SESSION MONITOR (%s) STARTING ===", source_label)

    target_include = _normalize_service_type_set(include_service_types)
    target_exclude = _normalize_service_type_set(exclude_service_types)
    live_service_filter = _normalize_service_type_set(live_service_types)

    def _is_plex_session_4k_source(plex_session: Any) -> bool:
        """Best-effort detection of a 4K source stream for Plex sessions."""
        try:
            media_items = getattr(plex_session, "media", None) or []
            original_media = None

            for media in media_items:
                if getattr(getattr(media, "_data", {}), "get", lambda *_: None)("selected") != "1":
                    original_media = media
                    break
            if original_media is None and media_items:
                original_media = media_items[0]

            if not original_media:
                return False

            if getattr(original_media, "videoResolution", None):
                if str(original_media.videoResolution).lower() == "4k":
                    return True

            height = getattr(original_media, "height", None)
            if height and int(height) >= 2160:
                return True

            parts = getattr(original_media, "parts", None) or []
            for part in parts:
                streams = getattr(part, "streams", None) or []
                for stream in streams:
                    if getattr(stream, "streamType", 0) != 1:
                        continue
                    display_title = getattr(stream, "displayTitle", "") or ""
                    if "4K" in display_title.upper():
                        return True
                    stream_height = getattr(stream, "height", None)
                    if stream_height and int(stream_height) >= 2160:
                        return True
            return False
        except Exception as err:
            current_app.logger.debug(f"[{source_label}] 4K detection failed for Plex session: {err}", exc_info=False)
            return False

    # Check for any active media servers from the database
    all_servers = MediaServiceManager.get_effective_servers(active_only=True)
    target_servers = []
    for server in all_servers:
        include_server = True
        if target_include is not None:
            include_server = server.service_type in target_include
        if include_server and target_exclude is not None:
            include_server = server.service_type not in target_exclude
        if include_server:
            target_servers.append(server)

    current_app.logger.debug(
        "[%s] Considering %d/%d active media servers for monitoring",
        source_label,
        len(target_servers),
        len(all_servers),
    )

    for server in target_servers:
        current_app.logger.debug(
            "[%s] Server - Name: %s, Type: %s, Active: %s",
            source_label,
            server.server_nickname,
            server.service_type.value,
            server.is_active,
        )

    if not target_servers:
        current_app.logger.warning(
            "[%s] No matching active media servers configured in the database. Skipping monitor.",
            source_label,
        )
        return

    try:
        target_service_types = {server.service_type for server in target_servers}
        live_services_payload = (
            sorted(service.value for service in live_service_filter)
            if live_service_filter
            else []
        )

        # This gets sessions from the targeted servers
        current_app.logger.debug(
            "[%s] Calling MediaServiceManager.get_all_active_sessions() for %s",
            source_label,
            ", ".join(sorted(s.value for s in target_service_types)),
        )
        active_sessions = MediaServiceManager.get_all_active_sessions(target_service_types)
        now_utc = datetime.now(timezone.utc)
        current_app.logger.debug(
            "[%s] Retrieved %d active sessions from MediaServiceManager",
            source_label,
            len(active_sessions),
        )

        if not active_sessions:
            current_app.logger.debug(
                "[%s] No active sessions found - this could be normal if no one is streaming",
                source_label,
            )
        else:
            current_app.logger.debug("[%s] Active sessions details:", source_label)
            for index, session in enumerate(active_sessions, start=1):
                if isinstance(session, dict):
                    session_id = session.get('Id') or session.get('id') or session.get('session_id') or 'unknown'
                    session_service = session.get('service_type', 'dict')
                    current_app.logger.debug(
                        "  Session %d: %s session ID %s",
                        index,
                        session_service,
                        session_id,
                    )
                else:
                    current_app.logger.debug(
                        "  Session %d: Plex session key %s",
                        index,
                        getattr(session, 'sessionKey', 'unknown'),
                    )

        current_app.logger.info(
            "[%s] Found %d active sessions across monitored servers.",
            source_label,
            len(active_sessions),
        )
        current_app.logger.debug(
            "[%s] Tracked sessions currently in memory: %d -> %s",
            source_label,
            len(_active_stream_sessions),
            list(_active_stream_sessions.keys()),
        )

        # Handle both Plex and Jellyfin session formats
        current_sessions_dict: Dict[str, Any] = {}
        session_service_map: Dict[str, str] = {}
        session_server_map: Dict[str, Optional[int]] = {}
        target_service_type_values = {svc.value for svc in target_service_types}
        server_lookup = {server.id: server for server in target_servers}

        for session in active_sessions:
            if isinstance(session, dict):
                session_key = session.get('Id') or session.get('id') or session.get('session_id')
                service_type_value = session.get('service_type') or ServiceType.JELLYFIN.value
                server_id = session.get('server_id')
            else:
                session_key = getattr(session, 'sessionKey', None)
                service_type_attr = getattr(session, 'service_type', None)
                if isinstance(service_type_attr, ServiceType):
                    service_type_value = service_type_attr.value
                elif isinstance(service_type_attr, str):
                    service_type_value = service_type_attr
                else:
                    service_type_value = ServiceType.PLEX.value
                server_id = getattr(session, 'server_id', None)

            if session_key:
                session_key_str = str(session_key)
                current_sessions_dict[session_key_str] = session
                session_service_map[session_key_str] = str(service_type_value).lower()
                if isinstance(server_id, int):
                    session_server_map[session_key_str] = server_id
                elif isinstance(server_id, str) and server_id.isdigit():
                    session_server_map[session_key_str] = int(server_id)
                else:
                    session_server_map[session_key_str] = None
            else:
                session_type = session.get('service_type', 'dict') if isinstance(session, dict) else "Plex"
                current_app.logger.warning(
                    "[%s] Session missing key: %s - %s",
                    source_label,
                    session_type,
                    type(session),
                )

        current_session_keys = set(current_sessions_dict.keys())

        # Step 1: Check for stopped streams (only for monitored service types)
        tracked_keys_in_scope = {
            key
            for key, meta in _active_stream_sessions.items()
            if meta.get('service_type') in target_service_type_values
        }
        stopped_session_keys = tracked_keys_in_scope - current_session_keys
        if stopped_session_keys:
            current_app.logger.info(
                "[%s] Found %d stopped sessions: %s",
                source_label,
                len(stopped_session_keys),
                list(stopped_session_keys),
            )
            for session_key in stopped_session_keys:
                session_meta = _active_stream_sessions.pop(session_key, None)
                if session_meta:
                    stream_history_id = session_meta.get('history_id')
                    if stream_history_id:
                        history_record = db.session.get(MediaStreamHistory, stream_history_id)
                        if history_record and not history_record.stopped_at:
                            final_duration = history_record.view_offset_at_end_seconds
                            history_record.duration_seconds = (
                                final_duration if final_duration and final_duration > 0 else 0
                            )
                            history_record.stopped_at = now_utc
                            current_app.logger.info(
                                "[%s] DURATION DEBUG: Session %s stopped - view_offset_at_end_seconds: %ss, final duration_seconds: %ss",
                                source_label,
                                session_key,
                                history_record.view_offset_at_end_seconds,
                                history_record.duration_seconds,
                            )
                            current_app.logger.info(
                                "[%s] Marked session %s (DB ID: %s) as stopped. Final duration: %ss.",
                                source_label,
                                session_key,
                                stream_history_id,
                                history_record.duration_seconds,
                            )
                        else:
                            current_app.logger.warning(
                                "[%s] Could not find or already stopped history record for DB ID %s",
                                source_label,
                                stream_history_id,
                            )
                else:
                    current_app.logger.debug(
                        "[%s] Session metadata missing when attempting to stop session %s",
                        source_label,
                        session_key,
                    )

        # Step 2: Check for new and ongoing streams
        if not current_sessions_dict:
            current_app.logger.info("[%s] No new or ongoing sessions to process.", source_label)

        if current_sessions_dict:
            current_app.logger.info(
                "[%s] Processing %d new or ongoing sessions...",
                source_label,
                len(current_sessions_dict),
            )

            for session_key, session in current_sessions_dict.items():
                service_type_value = session_service_map.get(session_key, ServiceType.PLEX.value)
                try:
                    service_type_enum = ServiceType(service_type_value)
                except ValueError:
                    service_type_enum = ServiceType.JELLYFIN if isinstance(session, dict) else ServiceType.PLEX

                server_id = session_server_map.get(session_key)
                current_server = None
                if server_id is not None:
                    current_server = server_lookup.get(server_id)
                if not current_server:
                    current_server = next(
                        (srv for srv in target_servers if srv.service_type == service_type_enum),
                        None,
                    )

                if not current_server:
                    current_app.logger.warning(
                        "[%s] Could not determine media server for session %s (service=%s). Skipping.",
                        source_label,
                        session_key,
                        service_type_enum.value,
                    )
                    continue

                # Handle different session formats for user lookup
                mum_user = None
                user_media_access = None
                
                if service_type_enum == ServiceType.JELLYFIN and isinstance(session, dict):
                    jellyfin_username = session.get('UserName')
                    if jellyfin_username:
                        user_media_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                            server_id=current_server.id,
                            external_username=jellyfin_username
                        ).first()
                        if user_media_access:
                            current_app.logger.debug(f"LINKED: Found service user for Jellyfin username '{jellyfin_username}' (ID: {user_media_access.id})")
                            current_app.logger.debug(f"LINKED: linkedUserId = {user_media_access.linkedUserId}")
                            current_app.logger.debug(f"LINKED: external_username = {user_media_access.external_username}")
                            current_app.logger.debug(f"LINKED: server = {user_media_access.server.server_nickname}")
                            
                            mum_user = None
                            if user_media_access.linkedUserId:
                                mum_user = User.query.filter_by(userType=UserType.LOCAL, uuid=user_media_access.linkedUserId).first()
                            current_app.logger.debug(f"LINKED: linked user = {mum_user}")
                            
                            if not mum_user:
                                current_app.logger.info(f"Found standalone service user for Jellyfin username '{jellyfin_username}' (ID: {user_media_access.id}). Processing as standalone user.")
                            else:
                                current_app.logger.info(f"Found linked service user for Jellyfin username '{jellyfin_username}' (ID: {user_media_access.id}) linked to local user (ID: {mum_user.id}, username: {mum_user.localUsername}). Processing as linked user.")
                        else:
                            current_app.logger.warning(f"No service user found for Jellyfin username '{jellyfin_username}' on server '{current_server.server_nickname}'. Skipping session.")
                            continue
                    else:
                        current_app.logger.warning(f"Jellyfin session {session_key} is missing UserName. Skipping.")
                        continue
                elif service_type_enum == ServiceType.AUDIOBOOKSHELF and isinstance(session, dict):
                    abs_user_id = session.get('userId')
                    abs_user_info = session.get('user') or {}
                    if not abs_user_id:
                        abs_user_id = abs_user_info.get('id')
                    abs_username = abs_user_info.get('username') or session.get('username')

                    if abs_user_id:
                        user_media_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                            server_id=current_server.id,
                            external_user_id=str(abs_user_id)
                        ).first()
                    if not user_media_access and abs_username:
                        user_media_access = User.query.filter_by(userType=UserType.SERVICE).filter_by(
                            server_id=current_server.id,
                            external_username=abs_username
                        ).first()

                    if user_media_access:
                        current_app.logger.debug(
                            "LINKED: Found service user for AudiobookShelf user ID %s (ID: %s)",
                            abs_user_id,
                            user_media_access.id,
                        )
                        current_app.logger.debug(f"LINKED: linkedUserId = {user_media_access.linkedUserId}")
                        current_app.logger.debug(f"LINKED: external_username = {user_media_access.external_username}")
                        current_app.logger.debug(f"LINKED: server = {user_media_access.server.server_nickname}")

                        mum_user = None
                        if user_media_access.linkedUserId:
                            mum_user = User.query.filter_by(
                                userType=UserType.LOCAL,
                                uuid=user_media_access.linkedUserId
                            ).first()
                        current_app.logger.debug(f"LINKED: linked user = {mum_user}")

                        if not mum_user:
                            current_app.logger.info(
                                "Found standalone service user for AudiobookShelf user '%s' (ID: %s). Processing as standalone user.",
                                abs_username or abs_user_id,
                                user_media_access.id,
                            )
                        else:
                            current_app.logger.info(
                                "Found linked service user for AudiobookShelf user '%s' (ID: %s) linked to local user (ID: %s, username: %s). Processing as linked user.",
                                abs_username or abs_user_id,
                                user_media_access.id,
                                mum_user.id,
                                mum_user.localUsername,
                            )
                    else:
                        current_app.logger.warning(
                            "No service user found for AudiobookShelf session %s (user_id=%s, username=%s) on server '%s'. Skipping session.",
                            session_key,
                            abs_user_id,
                            abs_username,
                            current_server.server_nickname,
                        )
                        continue
                elif service_type_enum == ServiceType.PLEX:
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
                        plex_server = current_server
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
                else:
                    current_app.logger.debug(
                        "[%s] Unsupported service type %s for session %s. Skipping.",
                        source_label,
                        service_type_enum.value,
                        session_key,
                    )
                    continue
                
                # Process session for user

                allow_4k_transcode_allowed = True
                if mum_user is not None and mum_user.allow_4k_transcode is not None:
                    allow_4k_transcode_allowed = bool(mum_user.allow_4k_transcode)
                elif user_media_access is not None and user_media_access.allow_4k_transcode is not None:
                    allow_4k_transcode_allowed = bool(user_media_access.allow_4k_transcode)

                if (
                    service_type_enum == ServiceType.PLEX
                    and not allow_4k_transcode_allowed
                    and hasattr(session, "transcodeSession")
                    and getattr(session.transcodeSession, "videoDecision", "").lower() == "transcode"
                ):
                    if _is_plex_session_4k_source(session):
                        reason = "4K transcoding is disabled for this user."
                        current_app.logger.warning(
                            "[%s] Terminating Plex session %s for user %s due to 4K transcode policy.",
                            source_label,
                            session_key,
                            user_media_access.external_username if user_media_access else getattr(mum_user, "localUsername", "unknown"),
                        )
                        terminated = False
                        try:
                            if current_server:
                                terminated = MediaServiceManager.terminate_session(current_server.id, str(session_key), reason=reason)
                        except Exception as term_err:
                            current_app.logger.error(
                                "[%s] Failed to terminate Plex session %s: %s",
                                source_label,
                                session_key,
                                term_err,
                                exc_info=True,
                            )
                        if terminated:
                            log_event(
                                EventType.STREAMING_SESSION_TERMINATED,
                                f"Terminated 4K transcode session for user {user_media_access.external_username if user_media_access else mum_user.get_display_name() if mum_user else 'unknown'}.",
                                user_id=(mum_user.id if mum_user else user_media_access.id if user_media_access else None),
                                details={"reason": reason, "session_key": str(session_key)},
                            )
                            _active_stream_sessions.pop(session_key, None)
                            continue
                        else:
                            current_app.logger.warning(
                                "[%s] Could not terminate Plex session %s for 4K policy; continuing to track.",
                                source_label,
                                session_key,
                            )

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

                        # Extract thumb for poster
                        thumb_url = getattr(session, 'thumb', None)
                    elif service_type_enum == ServiceType.AUDIOBOOKSHELF and isinstance(session, dict):
                        raw_duration = session.get('duration', 0)
                        try:
                            media_duration_s = int(float(raw_duration)) if raw_duration else 0
                        except (TypeError, ValueError):
                            media_duration_s = 0

                        device_info = session.get('deviceInfo') or {}
                        platform = device_info.get('osName', 'N/A')
                        product = device_info.get('clientName', 'N/A')
                        browser_name = device_info.get('browserName')
                        player_title = device_info.get('deviceName')
                        if not player_title:
                            if browser_name and platform:
                                player_title = f"{browser_name} on {platform}"
                            elif browser_name:
                                player_title = browser_name
                            else:
                                player_title = 'N/A'

                        ip_address = device_info.get('ipAddress', 'N/A')
                        if ip_address and ip_address.startswith('::ffff:'):
                            ip_address = ip_address[7:]

                        is_lan = False
                        if ip_address and ip_address not in ('N/A', 'localhost', '127.0.0.1', '::1'):
                            try:
                                import ipaddress

                                ip_value = ipaddress.ip_address(ip_address)
                                is_lan = ip_value.is_private or ip_value.is_loopback
                            except (ValueError, ipaddress.AddressValueError):
                                is_lan = False
                        else:
                            is_lan = True

                        media_metadata = session.get('mediaMetadata') or {}
                        media_title = session.get('displayTitle') or media_metadata.get('title', "Unknown")
                        media_type = session.get('mediaType', "Unknown")

                        display_author = session.get('displayAuthor')
                        if not display_author:
                            authors = media_metadata.get('authors', [])
                            if isinstance(authors, list) and authors:
                                first_author = authors[0]
                                if isinstance(first_author, dict):
                                    display_author = first_author.get('name')
                                else:
                                    display_author = str(first_author)
                        grandparent_title = None
                        parent_title = display_author

                        library_item_id = session.get('libraryItemId') or session.get('bookId')
                        rating_key = str(library_item_id or session_key)
                        external_media_item_id = str(library_item_id) if library_item_id else None

                        current_time = session.get('currentTime', 0)
                        try:
                            view_offset_s = int(float(current_time)) if current_time else 0
                        except (TypeError, ValueError):
                            view_offset_s = 0

                        library_name = session.get('libraryName')

                        cover_path = session.get('coverPath')
                        thumb_url = None
                        if library_item_id:
                            thumb_url = f"/api/v2/media/audiobookshelf/images/proxy?path=items/{library_item_id}/cover"
                        elif cover_path:
                            thumb_url = f"/api/v2/media/audiobookshelf/images/proxy?path={cover_path.lstrip('/')}"
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

                        # Extract thumb for poster from Jellyfin
                        # Jellyfin uses ImageTags with the Primary tag for posters
                        image_tags = now_playing.get('ImageTags', {})
                        thumb_url = None
                        if image_tags.get('Primary'):
                            # Build Jellyfin image URL: /Items/{Id}/Images/Primary
                            thumb_url = f"/Items/{rating_key}/Images/Primary"

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
                        thumb_url=thumb_url,
                        media_duration_seconds=media_duration_s,
                        view_offset_at_end_seconds=view_offset_s
                    )
                    
                    current_app.logger.debug(f"About to add MediaStreamHistory record to database...")
                    db.session.add(new_history_record)
                    
                    current_app.logger.debug(f"About to flush database session...")
                    db.session.flush() # Flush to get the ID
                    
                    _active_stream_sessions[session_key] = {
                        "history_id": new_history_record.id,
                        "service_type": service_type_enum.value,
                        "server_id": current_server.id if current_server else None,
                    }
                    current_app.logger.debug(f"Successfully created MediaStreamHistory record (ID: {new_history_record.id}) for session {session_key}.")
                    current_app.logger.debug(f"Added session {session_key} to _active_stream_sessions tracking")
                
                # If the session is ongoing, update its progress
                else:
                    current_app.logger.debug(f"Updating existing session {session_key}")
                    session_meta = _active_stream_sessions.get(session_key)
                    if session_meta is not None:
                        session_meta["server_id"] = current_server.id if current_server else session_meta.get("server_id")
                        session_meta["service_type"] = service_type_enum.value
                    history_record_id = session_meta.get("history_id") if session_meta else None
                    if history_record_id:
                        current_app.logger.debug(f"Found history record ID {history_record_id} for session {session_key}")
                        history_record = db.session.get(MediaStreamHistory, history_record_id)
                        if history_record:
                            # Handle different session formats for progress updates
                            if hasattr(session, 'player'):
                                # Plex session format
                                view_offset_ms = getattr(session, 'viewOffset', 0)
                                current_offset_s = int(view_offset_ms / 1000) if view_offset_ms else 0
                            elif service_type_enum == ServiceType.AUDIOBOOKSHELF and isinstance(session, dict):
                                current_time = session.get('currentTime', 0)
                                try:
                                    current_offset_s = int(float(current_time)) if current_time else 0
                                except (TypeError, ValueError):
                                    current_offset_s = 0
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

        # Broadcast WebSocket update with current active session count AND full session data
        # This runs regardless of whether there are sessions or not (to clear UI when all sessions stop)
        try:
            from app.routes.websockets import broadcast_streaming_update
            from app.services.media_service_manager import MediaServiceFactory
            active_count = _get_total_tracked_session_count()

            # ✅ FETCH AND FORMAT SESSION DATA FOR IMMEDIATE BROADCAST
            formatted_sessions = []
            try:
                # Get formatted sessions from all monitored servers
                for server in target_servers:
                    service = MediaServiceFactory.create_service_from_db(server)
                    if service:
                        try:
                            formatted = service.get_formatted_sessions()
                            if formatted:
                                for session in formatted:
                                    session.setdefault('server_id', server.id)
                                    session.setdefault('service_type', server.service_type.value)
                                    session.setdefault('server_name', server.server_nickname)
                                formatted_sessions.extend(formatted)
                        except Exception as format_err:
                            current_app.logger.warning(
                                f"[{source_label}] Failed to format sessions for {server.server_nickname}: {format_err}"
                            )
            except Exception as fetch_err:
                current_app.logger.warning(
                    f"[{source_label}] Failed to fetch formatted sessions for broadcast: {fetch_err}"
                )

            current_app.logger.info(
                "[%s] Broadcast debug: active_sessions=%d, tracked=%d, formatted=%d",
                source_label,
                len(active_sessions),
                len(_active_stream_sessions),
                len(formatted_sessions),
            )
            if formatted_sessions:
                try:
                    sample_states = [s.get('state') for s in formatted_sessions]
                    current_app.logger.debug("[%s] Formatted session states: %s", source_label, sample_states)
                except Exception:
                    pass

            # Broadcast with full session data (always broadcast, even if 0 sessions)
            # This ensures frontend always receives updates (like Tautulli)
            broadcast_streaming_update(
                sessions=formatted_sessions,  # ✅ Full session data (empty array if no sessions)
                live_services=live_services_payload,
                servers=target_servers,
                summary_data=summary_data,
            )
            current_app.logger.debug(
                f"Broadcasted WebSocket update: {active_count} active sessions, {len(formatted_sessions)} formatted sessions"
            )
        except Exception as ws_error:
            current_app.logger.warning(f"Failed to broadcast WebSocket update: {ws_error}")

        current_app.logger.info("=== MEDIA SESSION MONITOR (%s) FINISHED ===", source_label)

    except Exception as e:
        db.session.rollback()
        current_app.logger.error(
            "Fatal error in media session monitor (%s): %s",
            source_label,
            e,
            exc_info=True,
        )

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

def _schedule_job_if_not_exists_or_reschedule(
    job_id,
    func,
    trigger_type,
    misfire_grace_time: int = 10,
    coalesce: bool = True,
    **trigger_args,
):
    """Helper to add or reschedule a job, with sane misfire handling."""
    if not scheduler.running:
        current_app.logger.warning(f"Task_Service: APScheduler not running. Cannot schedule job '{job_id}'.")
        return False
    
    try:
        # Use replace_existing to ensure updated misfire/coalesce settings are applied
        scheduler.add_job(
            id=job_id,
            func=func,
            trigger=trigger_type,
            replace_existing=True,
            misfire_grace_time=misfire_grace_time,
            coalesce=coalesce,
            **trigger_args,
        )
        current_app.logger.info(f"Scheduled task: {job_id} (misfire_grace_time={misfire_grace_time}s, coalesce={coalesce})")
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
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=10), # Start shortly after app start
        misfire_grace_time=15,
        coalesce=True,
    ):
        log_event(EventType.APP_STARTUP, f"Media session monitoring scheduled ({session_interval_seconds}s interval)")

    # 2. User Access Expiration Check
    if _schedule_job_if_not_exists_or_reschedule(
        job_id='check_user_expirations',
        func=check_user_access_expirations_task,
        trigger_type='interval',
        seconds=session_interval_seconds,
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=30),
        misfire_grace_time=15,
        coalesce=True,
    ):
        log_event(EventType.APP_STARTUP, f"User expiration check scheduled ({session_interval_seconds}s interval)")
