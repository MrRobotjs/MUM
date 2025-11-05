"""Background Plex WebSocket monitor that triggers session processing on real-time events.

Also mirrors incoming Plex WS messages to a dedicated file log at
multimediausermanager/logs/plex_websocket/YYYY-MM-DD.log for easier inspection.
"""

from __future__ import annotations

import ssl
import logging
from logging.handlers import RotatingFileHandler
import threading
import time
from datetime import datetime
from typing import Dict, List, Optional
from urllib.parse import urlparse
import json

from flask import current_app
import os
from websocket import WebSocketApp

from app.models_media_services import MediaServer, ServiceType
from app.services.media_service_manager import MediaServiceManager
from app.services.task_service import _run_media_session_monitor

_MONITOR_INSTANCE: Optional["PlexWebsocketMonitor"] = None
_MONITOR_LOCK = threading.Lock()


class PlexWebsocketMonitor:
    """Maintain WebSocket listeners for each configured Plex server."""

    def __init__(self, app):
        self.app = app
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.threads: Dict[int, threading.Thread] = {}
        self.last_refresh_at: Dict[int, float] = {}
        self.logger = app.logger
        self._ensure_file_logger()

    def _ensure_file_logger(self) -> None:
        """Initialize a rotating file logger, preferring multimediausermanager/..., with fallback."""
        logger_name = "plex_ws_monitor"
        self.file_logger = logging.getLogger(logger_name)
        
        try:
            # Allow override via env
            override_path = os.getenv("PLEX_WS_LOG_PATH")
            log_path = None
            if override_path:
                # Use directory from override
                try:
                    os.makedirs(os.path.dirname(override_path), exist_ok=True)
                    log_path = override_path
                except Exception as e:
                    self.logger.error(
                        "PlexWebsocketMonitor: Failed to create log directory for override path %s: %s",
                        override_path,
                        e,
                        exc_info=True,
                    )
                    log_path = None
            else:
                # Preferred: Use instance_path (usually /app/instance) which is mounted and persists to host
                # This matches the docker-compose.yml volume mount: ./multimediausermanager:/app/instance
                try:
                    inst_dir = self.app.instance_path
                    # Create logs/plex_websocket directory structure
                    logs_dir = os.path.join(inst_dir, "logs", "plex_websocket")
                    os.makedirs(logs_dir, exist_ok=True)
                    # Include date in filename: YYYY-MM-DD.log
                    date_str = datetime.now().strftime("%Y-%m-%d")
                    log_filename = f"{date_str}.log"
                    log_path = os.path.join(logs_dir, log_filename)
                except Exception as e:
                    self.logger.error(
                        "PlexWebsocketMonitor: Failed to create instance log directory %s: %s. File logging disabled.",
                        inst_dir,
                        e,
                        exc_info=True,
                    )
                    # Fall back to app logger
                    self.file_logger = self.logger
                    return

            # Test write permissions before creating handler
            try:
                test_file = open(log_path, 'a')
                test_file.close()
            except Exception as e:
                self.logger.error(
                    "PlexWebsocketMonitor: Cannot write to log file %s: %s. Falling back to app logger.",
                    log_path,
                    e,
                    exc_info=True,
                )
                self.file_logger = self.logger
                return

            # Check for existing handlers by normalizing the path comparison
            # Use os.path.normpath to handle path separators correctly
            log_path_normalized = os.path.normpath(log_path)
            existing_handlers = [
                h for h in self.file_logger.handlers
                if isinstance(h, RotatingFileHandler)
            ]
            has_existing_handler = any(
                os.path.normpath(getattr(h, "baseFilename", "")) == log_path_normalized
                for h in existing_handlers
            )
            
            if not has_existing_handler:
                try:
                    handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3)
                    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
                    self.file_logger.addHandler(handler)
                    self.file_logger.setLevel(logging.DEBUG)
                    self.file_logger.propagate = False
                    # Emit an initialization line to ensure file creation
                    self.file_logger.info("PlexWebsocketMonitor file logger initialized at %s", log_path)
                    # Force flush to ensure file is created and written
                    for h in self.file_logger.handlers:
                        if isinstance(h, RotatingFileHandler):
                            try:
                                h.flush()
                                # Also try to access the stream directly to force creation
                                if hasattr(h, 'stream') and h.stream:
                                    h.stream.flush()
                            except Exception as flush_err:
                                self.logger.warning("Failed to flush file handler during init: %s", flush_err)
                except Exception as e:
                    self.logger.error(
                        "PlexWebsocketMonitor: Failed to create file handler for %s: %s. Falling back to app logger.",
                        log_path,
                        e,
                        exc_info=True,
                    )
                    # Fall back to app logger
                    self.file_logger = self.logger
            else:
                # Handler already exists, just ensure level is set
                self.file_logger.setLevel(logging.DEBUG)
                self.file_logger.propagate = False
                # Verify the existing handler can write
                try:
                    for h in self.file_logger.handlers:
                        if isinstance(h, RotatingFileHandler):
                            h.flush()
                except Exception as e:
                    self.logger.warning(
                        "PlexWebsocketMonitor: Existing handler may not be writable: %s",
                        e,
                    )
        except Exception as e:
            # Fall back to app logger
            self.logger.error(
                "PlexWebsocketMonitor: Unexpected error initializing file logger: %s. Falling back to app logger.",
                e,
                exc_info=True,
            )
            self.file_logger = self.logger

    def start(self) -> None:
        """Spin up listeners for all active Plex servers."""
        with self.app.app_context():
            servers = MediaServiceManager.get_servers_by_type(ServiceType.PLEX, active_only=True)
            if not servers:
                self.logger.info("PlexWebsocketMonitor: No active Plex servers found; WebSocket listener not started.")
                return

            self.logger.info(
                "PlexWebsocketMonitor: Starting WebSocket listeners for %d Plex server(s).",
                len(servers),
            )

        for server in servers:
            self._start_for_server(server.id)

    def _start_for_server(self, server_id: int) -> None:
        with self.lock:
            thread = self.threads.get(server_id)
            if thread and thread.is_alive():
                return

            thread = threading.Thread(
                target=self._run_for_server,
                args=(server_id,),
                name=f"plex-ws-{server_id}",
                daemon=True,
            )
            self.threads[server_id] = thread
            thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def _run_for_server(self, server_id: int) -> None:
        backoff = 5
        max_backoff = 60

        while not self.stop_event.is_set():
            with self.app.app_context():
                server = MediaServer.query.get(server_id)
                if not server or not server.is_active:
                    self.logger.info(
                        "PlexWebsocketMonitor: Server %s inactive or missing; retrying in 60s.",
                        server_id,
                    )
                    if self.stop_event.wait(60):
                        return
                    continue

                if not server.api_key or not server.url:
                    self.logger.warning(
                        "PlexWebsocketMonitor: Server %s missing URL or API token; retrying in 60s.",
                        server.server_nickname,
                    )
                    if self.stop_event.wait(60):
                        return
                    continue

                ws_url = self._build_websocket_url(server)
                headers = self._build_headers(server)

            try:
                self.logger.debug(
                    "PlexWebsocketMonitor: Connecting to %s for server %s",
                    ws_url,
                    server_id,
                )

                ws_app = WebSocketApp(
                    ws_url,
                    header=headers,
                    on_message=lambda ws_sock, msg: self._handle_message(server_id, msg),
                    on_error=lambda ws_sock, err: self._handle_error(server_id, err),
                    on_close=lambda ws_sock, status_code, msg: self._handle_close(server_id, status_code, msg),
                )

                sslopt = {}
                if ws_url.startswith("wss://"):
                    sslopt = {"cert_reqs": ssl.CERT_NONE}

                ws_app.run_forever(sslopt=sslopt, ping_interval=30, ping_timeout=10)
                backoff = 5  # reset backoff after a successful run
            except Exception as exc:  # pragma: no cover - Ws library exceptions
                with self.app.app_context():
                    self.logger.error(
                        "PlexWebsocketMonitor: Unexpected error for server %s: %s",
                        server_id,
                        exc,
                        exc_info=True,
                    )

            if self.stop_event.wait(backoff):
                return
            backoff = min(backoff * 2, max_backoff)

        with self.app.app_context():
            current_app.logger.info("PlexWebsocketMonitor: Stop signal received for server %s", server_id)

    def _extract_message_type(self, text: str) -> str:
        """Extract message type identifier from Plex websocket message.
        
        Returns format like [transcodeSession.end], [playing:playing], [playing:buffering], etc.
        """
        try:
            data = json.loads(text)
            notification_container = data.get("NotificationContainer", {})
            msg_type = notification_container.get("type", "")
            
            if not msg_type:
                return ""
            
            # Special handling for "playing" type - check state
            if msg_type == "playing":
                play_session = notification_container.get("PlaySessionStateNotification", [])
                if play_session and isinstance(play_session, list) and len(play_session) > 0:
                    state = play_session[0].get("state", "")
                    if state:
                        return f"[playing:{state}]"
                    return "[playing]"
                return "[playing]"
            
            # Handle timeline events (progress updates)
            if msg_type == "timeline":
                return "[timeline]"
            
            # Handle activity events
            if msg_type == "activity":
                return "[activity]"
            
            # Handle transcode events
            if msg_type in ["transcodeSession.start", "transcodeSession.end"]:
                return f"[{msg_type}]"
            
            # For other types, use the type directly
            return f"[{msg_type}]"
        except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
            # If parsing fails, return empty string (fallback to no type indicator)
            return ""
    
    def _is_session_related_event(self, msg_type: str) -> bool:
        """Filter to only process session-related websocket events."""
        if not msg_type:
            return True  # Process unknown events by default
        
        session_events = [
            'playing',
            'playing:playing',
            'playing:paused',
            'playing:buffering',
            'playing:stopped',
            'transcodeSession.start',
            'transcodeSession.end',
            'timeline',
            'activity',
        ]
        
        # Check if message type matches any session event (remove brackets for comparison)
        msg_type_clean = msg_type.replace('[', '').replace(']', '')
        return any(msg_type_clean.startswith(evt) for evt in session_events)

    def _handle_message(self, server_id: int, message) -> None:
        text = message.decode("utf-8", errors="ignore") if isinstance(message, bytes) else str(message)
        # ✅ REMOVED: Rate limiting - process every websocket message immediately for instant updates
        
        # Extract message type early to filter non-session events (optimization)
        msg_type = self._extract_message_type(text)
        
        # Only process session-related events (like Tautulli does)
        if not self._is_session_related_event(msg_type):
            # Log skipped events only in debug mode to reduce noise
            return

        with self.app.app_context():
            # Configurable truncation of logged payloads
            # Default is 0 (no truncation). Set PLEX_WS_LOG_BYTES to a positive integer to truncate.
            limit = current_app.config.get("PLEX_WS_LOG_BYTES")
            if limit is None:
                try:
                    env_limit = os.getenv("PLEX_WS_LOG_BYTES")
                    limit = int(env_limit) if env_limit is not None else 0
                except Exception:
                    limit = 0

            try:
                limit_int = int(limit)
            except Exception:
                limit_int = 200

            # Get server nickname
            server = MediaServer.query.get(server_id)
            server_nickname = server.server_nickname if server else None
            nickname_suffix = f" [{server_nickname}]" if server_nickname else ""
            
            # Extract message type identifier
            msg_type = self._extract_message_type(text)
            type_prefix = f" {msg_type}" if msg_type else ""
            
            if limit_int and limit_int > 0:
                snippet = text[:limit_int]
                suffix = " (truncated)" if len(text) > limit_int else ""
                msg = f"PlexWebsocketMonitor: Message from server {server_id}{nickname_suffix}{type_prefix}{suffix}: {snippet}"
            else:
                msg = f"PlexWebsocketMonitor: Message from server {server_id}{nickname_suffix}{type_prefix}: {text}"
            
            # Always log to app logger
            current_app.logger.debug(msg)
            
            # Log to file logger with error handling
            try:
                # Ensure file_logger exists and has handlers
                if hasattr(self, 'file_logger') and self.file_logger is not None:
                    if len(self.file_logger.handlers) > 0:
                        self.file_logger.debug(msg)
                        # Force flush to ensure message is written immediately
                        for h in self.file_logger.handlers:
                            if isinstance(h, RotatingFileHandler):
                                try:
                                    h.flush()
                                except Exception:
                                    pass  # Ignore flush errors
                    else:
                        # No handlers, log a warning once
                        if not hasattr(self, '_file_logger_warning_logged'):
                            current_app.logger.warning(
                                "PlexWebsocketMonitor: file_logger has no handlers. Messages will only be logged to app logger."
                            )
                            self._file_logger_warning_logged = True
                else:
                    # file_logger not initialized
                    if not hasattr(self, '_file_logger_warning_logged'):
                        current_app.logger.warning(
                            "PlexWebsocketMonitor: file_logger not initialized. Messages will only be logged to app logger."
                        )
                        self._file_logger_warning_logged = True
            except Exception as log_exc:
                # Don't let file logging errors break message processing
                if not hasattr(self, '_file_logger_error_logged'):
                    current_app.logger.error(
                        "PlexWebsocketMonitor: Error writing to file logger: %s",
                        log_exc,
                        exc_info=True,
                    )
                    self._file_logger_error_logged = True
            
            try:
                # ✅ IMMEDIATE HTTP FETCH (like Tautulli)
                # Fetch fresh session data immediately when websocket fires
                server = MediaServer.query.get(server_id)
                websocket_received_at = time.time()
                
                if server and server.is_active:
                    from app.services.media_service_manager import MediaServiceFactory
                    service = MediaServiceFactory.create_service_from_db(server)
                    if service:
                        # Force immediate fresh fetch - don't rely on cached data
                        fresh_sessions = service.get_active_sessions()
                        http_fetch_completed_at = time.time()
                        current_app.logger.debug(
                            f"PlexWebsocketMonitor: Fetched {len(fresh_sessions)} fresh sessions immediately after websocket event "
                            f"(latency: {http_fetch_completed_at - websocket_received_at:.3f}s)"
                        )
                
                # Now process with fresh data
                _run_media_session_monitor(
                    include_service_types={ServiceType.PLEX},
                    source=f"plex-websocket:{server_id}",
                    live_service_types={ServiceType.PLEX},
                )
            except Exception as exc:  # pragma: no cover - defensive logging
                current_app.logger.error(
                    "PlexWebsocketMonitor: Failed to process Plex WebSocket event for server %s: %s",
                    server_id,
                    exc,
                    exc_info=True,
                )

    def _handle_error(self, server_id: int, error) -> None:
        with self.app.app_context():
            current_app.logger.warning(
                "PlexWebsocketMonitor: WebSocket error on server %s: %s",
                server_id,
                error,
            )

    def _handle_close(self, server_id: int, status_code, message) -> None:
        with self.app.app_context():
            current_app.logger.info(
                "PlexWebsocketMonitor: WebSocket closed for server %s (code=%s, message=%s)",
                server_id,
                status_code,
                message,
            )

    @staticmethod
    def _build_websocket_url(server: MediaServer) -> str:
        base_url = server.url.rstrip('/')
        parsed = urlparse(base_url)
        scheme = 'wss' if parsed.scheme == 'https' else 'ws'
        netloc = parsed.netloc or parsed.path
        path = parsed.path.rstrip('/')
        if not netloc:
            raise ValueError(f"Invalid Plex server URL: {server.url}")
        if path:
            path = f"{path}/:/websockets/notifications"
        else:
            path = "/:/websockets/notifications"
        token_query = f"?X-Plex-Token={server.api_key}"
        return f"{scheme}://{netloc}{path}{token_query}"

    @staticmethod
    def _build_headers(server: MediaServer) -> List[str]:
        return [
            f"X-Plex-Token: {server.api_key}",
            "X-Plex-Client-Identifier: mum-admin",
            "X-Plex-Device: MUM",
            "X-Plex-Device-Name: MUM",
            "X-Plex-Product: Multimedia User Manager",
            "X-Plex-Version: 1.0",
        ]


def start_plex_websocket_monitor(app) -> None:
    """Start the Plex WebSocket monitor if it isn't running yet."""
    global _MONITOR_INSTANCE
    with _MONITOR_LOCK:
        if _MONITOR_INSTANCE is None:
            monitor = PlexWebsocketMonitor(app)
            _MONITOR_INSTANCE = monitor
            monitor.start()
        else:
            app.logger.debug("PlexWebsocketMonitor: Already active; skipping start.")
