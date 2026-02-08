"""Background Emby WebSocket monitor that feeds the unified realtime pipeline.

Connects to Emby's base websocket endpoint (same URL as HTTP with ws/wss scheme)
and subscribes to SessionsStart messages. When session events are received,
triggers the unified task monitor to process and broadcast.
"""
from __future__ import annotations

import json
import logging
from logging.handlers import RotatingFileHandler
import os
import threading
from datetime import datetime
from typing import Dict, List, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from flask import current_app
from websocket import WebSocketApp

from app.models_media_services import MediaServer, ServiceType
from app.services.media_service_manager import MediaServiceManager
from app.services.task_service import _run_media_session_monitor
from app.services import realtime_session_cache

_MONITOR_INSTANCE: Optional["EmbyWebsocketMonitor"] = None
_MONITOR_LOCK = threading.Lock()


def _extract_sessions_from_message(payload: dict | list | str | bytes) -> List[dict]:
    """Extract session list from Emby websocket message."""
    try:
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8", errors="ignore")
        if isinstance(payload, str):
            payload = json.loads(payload)
    except Exception:
        return []

    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []

    # Emby sends: {"MessageType": "Sessions", "Data": [...]}
    msg_type = payload.get("MessageType", "")
    if msg_type.lower() != "sessions":
        return []

    data_block = payload.get("Data")
    if isinstance(data_block, str):
        try:
            data_block = json.loads(data_block)
        except Exception:
            return []

    if isinstance(data_block, list):
        return data_block

    return []


class EmbyWebsocketMonitor:
    """Maintain WebSocket listeners for each configured Emby server.

    Follows the unified architecture:
    1. Connect to Emby's base websocket endpoint
    2. Send SessionsStart subscription on connect
    3. On message, cache sessions and trigger _run_media_session_monitor
    """

    def __init__(self, app):
        self.app = app
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.threads: Dict[int, threading.Thread] = {}
        self.server_stop_events: Dict[int, threading.Event] = {}
        self.wsapps: Dict[int, WebSocketApp] = {}
        self.logger = app.logger
        self.log_date = None
        self._ensure_file_logger()

    def _create_file_handler_for_date(self, target_date: datetime) -> RotatingFileHandler | None:
        date_str = target_date.strftime("%Y-%m-%d")
        log_path = None

        override_path = os.getenv("EMBY_WS_LOG_PATH")
        if override_path:
            try:
                os.makedirs(os.path.dirname(override_path), exist_ok=True)
                log_path = override_path
            except Exception as exc:
                self.logger.error(
                    "EmbyWebsocketMonitor: Failed to create log directory for override path %s: %s",
                    override_path,
                    exc,
                    exc_info=True,
                )
                log_path = None
        else:
            try:
                inst_dir = self.app.instance_path
                logs_dir = os.path.join(inst_dir, "logs", "emby_websocket")
                os.makedirs(logs_dir, exist_ok=True)
                log_path = os.path.join(logs_dir, f"emby-{date_str}.log")
            except Exception as exc:
                self.logger.error(
                    "EmbyWebsocketMonitor: Failed to create instance log directory %s: %s. File logging disabled.",
                    inst_dir,
                    exc,
                    exc_info=True,
                )
                return None

        try:
            test_file = open(log_path, "a")
            test_file.close()
        except Exception as exc:
            self.logger.error(
                "EmbyWebsocketMonitor: Cannot write to log file %s: %s. Falling back to app logger.",
                log_path,
                exc,
                exc_info=True,
            )
            return None

        try:
            handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3)
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            return handler
        except Exception as exc:
            self.logger.error(
                "EmbyWebsocketMonitor: Failed to create file handler for %s: %s. Falling back to app logger.",
                log_path,
                exc,
                exc_info=True,
            )
            return None

    def _ensure_file_logger(self) -> None:
        """Initialize a rotating file logger, preferring instance/logs/jellyfin_websocket."""
        logger_name = "emby_ws_monitor"
        self.file_logger = logging.getLogger(logger_name)

        try:
            target_date = datetime.now().date()
            handler = self._create_file_handler_for_date(datetime.combine(target_date, datetime.min.time()))

            if handler:
                for existing in list(self.file_logger.handlers):
                    if isinstance(existing, RotatingFileHandler):
                        try:
                            self.file_logger.removeHandler(existing)
                            existing.close()
                        except Exception:
                            pass

                self.file_logger.addHandler(handler)
                self.file_logger.setLevel(logging.DEBUG)
                self.file_logger.propagate = False
                self.file_logger.info("EmbyWebsocketMonitor file logger initialized for %s", target_date)
                self.log_date = target_date
            else:
                self.file_logger = self.logger
        except Exception as exc:
            self.logger.error(
                "EmbyWebsocketMonitor: Unexpected error initializing file logger: %s. Falling back to app logger.",
                exc,
                exc_info=True,
            )
            self.file_logger = self.logger

    def _ensure_daily_log_file(self) -> None:
        try:
            today = datetime.now().date()
            if self.log_date == today:
                return
            self._ensure_file_logger()
        except Exception as exc:
            self.logger.warning("EmbyWebsocketMonitor: Failed to rotate daily log file: %s", exc, exc_info=True)

    def _log_message(self, server_id: int, text: str) -> None:
        # Default is 0 (no truncation). Set EMBY_WS_LOG_BYTES to truncate.
        limit = current_app.config.get("EMBY_WS_LOG_BYTES")
        if limit is None:
            try:
                env_limit = os.getenv("EMBY_WS_LOG_BYTES")
                limit = int(env_limit) if env_limit is not None else 0
            except Exception:
                limit = 0

        try:
            limit_int = int(limit)
        except Exception:
            limit_int = 0

        server = MediaServer.query.get(server_id)
        server_nickname = server.server_nickname if server else None
        nickname_suffix = f" [{server_nickname}]" if server_nickname else ""

        msg_type = ""
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                msg_type = str(parsed.get("MessageType") or "")
        except Exception:
            msg_type = ""
        type_prefix = f" {msg_type}" if msg_type else ""

        if limit_int and limit_int > 0:
            snippet = text[:limit_int]
            suffix = " (truncated)" if len(text) > limit_int else ""
            msg = f"EmbyWebsocketMonitor: Message from server {server_id}{nickname_suffix}{type_prefix}{suffix}: {snippet}"
        else:
            msg = f"EmbyWebsocketMonitor: Message from server {server_id}{nickname_suffix}{type_prefix}: {text}"

        try:
            self._ensure_daily_log_file()
            if hasattr(self, "file_logger") and self.file_logger is not None and len(self.file_logger.handlers) > 0:
                self.file_logger.debug(msg)
                for handler in self.file_logger.handlers:
                    if isinstance(handler, RotatingFileHandler):
                        try:
                            handler.flush()
                        except Exception:
                            pass
            else:
                if not hasattr(self, "_file_logger_warning_logged"):
                    current_app.logger.warning(
                        "EmbyWebsocketMonitor: file_logger not initialized/has no handlers. Messages will only be logged to app logger."
                    )
                    self._file_logger_warning_logged = True
        except Exception as log_exc:
            if not hasattr(self, "_file_logger_error_logged"):
                current_app.logger.error(
                    "EmbyWebsocketMonitor: Error writing to file logger: %s",
                    log_exc,
                    exc_info=True,
                )
                self._file_logger_error_logged = True

    def start(self) -> None:
        """Spin up listeners for all active Emby servers."""
        with self.app.app_context():
            servers = MediaServiceManager.get_effective_servers_by_type(ServiceType.EMBY)
            if not servers:
                self.logger.info("EmbyWebsocketMonitor: No active Emby servers found; listener not started.")
                return
            self.logger.info("EmbyWebsocketMonitor: Starting WebSocket listeners for %d Emby server(s).", len(servers))

        for server in servers:
            self.start_for_server(server.id)

    def _ensure_server_stop_event(self, server_id: int, reset: bool = False) -> threading.Event:
        with self.lock:
            event = self.server_stop_events.get(server_id)
            if event is None or (reset and event.is_set()):
                event = threading.Event()
                self.server_stop_events[server_id] = event
            return event

    def start_for_server(self, server_id: int) -> None:
        server_stop_event = self._ensure_server_stop_event(server_id, reset=True)
        if server_stop_event.is_set():
            server_stop_event.clear()
        self._start_for_server(server_id)

    def stop_for_server(self, server_id: int) -> None:
        with self.lock:
            event = self.server_stop_events.get(server_id)
            if event:
                event.set()
            wsapp = self.wsapps.get(server_id)
        if wsapp:
            try:
                wsapp.close()
            except Exception:
                self.logger.debug("EmbyWebsocketMonitor: Failed to close websocket for server %s", server_id, exc_info=True)

    def _start_for_server(self, server_id: int) -> None:
        with self.lock:
            thread = self.threads.get(server_id)
            if thread and thread.is_alive():
                return
            thread = threading.Thread(
                target=self._run_for_server,
                args=(server_id,),
                name=f"emby-ws-{server_id}",
                daemon=True,
            )
            self.threads[server_id] = thread
            thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def _build_websocket_url(self, server: MediaServer) -> str:
        """Build Emby WebSocket URL.

        Emby uses the base HTTP URL with the scheme swapped (http -> ws, https -> wss).
        """
        base_url = server.url.rstrip('/')
        parsed = urlparse(base_url)

        # Convert HTTP scheme to WebSocket scheme
        scheme = 'wss' if parsed.scheme == 'https' else 'ws'
        netloc = parsed.netloc or parsed.path
        path = parsed.path

        if not netloc:
            raise ValueError(f"Invalid Emby server URL: {server.url}")

        query_params = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query_params['api_key'] = server.api_key
        query_params['deviceId'] = 'mum'
        query = urlencode(query_params, doseq=True)

        return urlunparse((scheme, netloc, path, '', query, ''))

    def _is_session_event(self, message_text: str) -> bool:
        """Check if message is session-related to avoid processing unrelated events."""
        try:
            data = json.loads(message_text)
            msg_type = data.get("MessageType", "")
            # Emby sends SessionsStart, Sessions, SessionEnded, PlaybackStart, PlaybackStopped, etc.
            session_types = ["sessions", "sessionstart", "sessionended", "playbackstart", "playbackstopped", "playbackprogress"]
            return msg_type.lower() in session_types
        except Exception:
            return True  # Process unknown messages by default

    def _run_for_server(self, server_id: int) -> None:
        backoff = 5
        max_backoff = 60
        server_stop_event = self._ensure_server_stop_event(server_id)

        while not self.stop_event.is_set() and not server_stop_event.is_set():
            with self.app.app_context():
                server = MediaServer.query.get(server_id)
                if not server or not MediaServiceManager.is_server_effectively_active(server):
                    self.logger.info(
                        "EmbyWebsocketMonitor: Server %s inactive or plugin disabled; retrying in 60s.",
                        server_id,
                    )
                    if self.stop_event.wait(60) or server_stop_event.is_set():
                        return
                    continue

                if not server.api_key or not server.url:
                    self.logger.warning("EmbyWebsocketMonitor: Server %s missing URL or API key; retrying in 60s.", server_id)
                    if self.stop_event.wait(60) or server_stop_event.is_set():
                        return
                    continue

                ws_url = self._build_websocket_url(server)
                self.logger.info("EmbyWebsocketMonitor: Connecting to %s for server %s", ws_url, server.server_nickname)

                def on_open(wsapp):
                    """Subscribe to session updates on connect."""
                    try:
                        # Emby requires a SessionsStart message to begin receiving session updates
                        start_payload = json.dumps({
                            "MessageType": "SessionsStart",
                            "Data": "0,1500"
                        })
                        wsapp.send(start_payload)
                        self.logger.info("EmbyWebsocketMonitor: Subscribed to sessions for server %s", server_id)
                    except Exception as err:
                        self.logger.warning(
                            "EmbyWebsocketMonitor: Failed to send SessionsStart for server %s: %s",
                            server_id,
                            err,
                            exc_info=True,
                        )

                def on_message(wsapp, message):
                    """Process session events by caching and triggering unified monitor."""
                    text = message.decode("utf-8", errors="ignore") if isinstance(message, bytes) else str(message)

                    # Filter non-session events
                    if not self._is_session_event(text):
                        return

                    with self.app.app_context():
                        try:
                            self._log_message(server_id, text)
                            # Step 1: Extract and cache sessions from websocket payload
                            sessions = _extract_sessions_from_message(message)

                            # Filter out idle sessions (no active playback)
                            # Only keep sessions that have NowPlayingItem
                            active_sessions = [s for s in sessions if s.get("NowPlayingItem")]

                            realtime_session_cache.set_sessions(ServiceType.EMBY.value, server_id, active_sessions)

                            self.logger.debug(
                                "EmbyWebsocketMonitor: Cached %d active sessions for server %s (filtered from %d total)",
                                len(active_sessions),
                                server_id,
                                len(sessions),
                            )

                            # Step 2: Trigger unified session monitor
                            # This fetches from cache, formats, normalizes, and broadcasts
                            _run_media_session_monitor(
                                include_service_types={ServiceType.EMBY},
                                source=f"emby-websocket:{server_id}",
                                live_service_types={ServiceType.EMBY},
                            )
                        except Exception as err:
                            current_app.logger.error(
                                "EmbyWebsocketMonitor: Failed to process event for server %s: %s",
                                server_id,
                                err,
                                exc_info=True,
                            )

                def on_error(wsapp, error):
                    self.logger.warning("EmbyWebsocketMonitor: WebSocket error on server %s: %s", server_id, error)

                def on_close(wsapp, code, msg):
                    self.logger.info(
                        "EmbyWebsocketMonitor: WebSocket closed for server %s (code=%s, message=%s)",
                        server_id,
                        code,
                        msg,
                    )

                wsapp = WebSocketApp(
                    ws_url,
                    on_open=on_open,
                    on_message=on_message,
                    on_error=on_error,
                    on_close=on_close,
                )
                with self.lock:
                    self.wsapps[server_id] = wsapp

                try:
                    wsapp.run_forever(ping_interval=30, ping_timeout=10)
                    backoff = 5  # Reset backoff after successful run
                except Exception as err:
                    self.logger.warning(
                        "EmbyWebsocketMonitor: Unexpected error for server %s: %s",
                        server_id,
                        err,
                        exc_info=True,
                    )
                finally:
                    with self.lock:
                        self.wsapps.pop(server_id, None)

            if self.stop_event.wait(backoff) or server_stop_event.is_set():
                return
            backoff = min(max_backoff, backoff * 2)

        with self.lock:
            thread = self.threads.get(server_id)
            if thread is threading.current_thread():
                self.threads.pop(server_id, None)
            self.server_stop_events.pop(server_id, None)
            self.wsapps.pop(server_id, None)


def start_emby_websocket_monitor(app) -> None:
    global _MONITOR_INSTANCE
    with _MONITOR_LOCK:
        if _MONITOR_INSTANCE is not None:
            app.logger.debug("EmbyWebsocketMonitor: Already active; skipping start.")
            return
        monitor = EmbyWebsocketMonitor(app)
        _MONITOR_INSTANCE = monitor
        threading.Thread(target=monitor.start, name="emby-ws-main", daemon=True).start()
