"""Background Emby WebSocket monitor that feeds the unified realtime pipeline.

Connects to Emby's /embywebsocket endpoint and subscribes to SessionsStart messages.
When session events are received, triggers the unified task monitor to process and broadcast.
"""
from __future__ import annotations

import json
import threading
from typing import Dict, List, Optional
from urllib.parse import urlparse

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
    1. Connect to Emby's /embywebsocket endpoint
    2. Send SessionsStart subscription on connect
    3. On message, cache sessions and trigger _run_media_session_monitor
    """

    def __init__(self, app):
        self.app = app
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.threads: Dict[int, threading.Thread] = {}
        self.logger = app.logger

    def start(self) -> None:
        """Spin up listeners for all active Emby servers."""
        with self.app.app_context():
            servers = MediaServiceManager.get_servers_by_type(ServiceType.EMBY, active_only=True)
            if not servers:
                self.logger.info("EmbyWebsocketMonitor: No active Emby servers found; listener not started.")
                return
            self.logger.info("EmbyWebsocketMonitor: Starting WebSocket listeners for %d Emby server(s).", len(servers))

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
                name=f"emby-ws-{server_id}",
                daemon=True,
            )
            self.threads[server_id] = thread
            thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def _build_websocket_url(self, server: MediaServer) -> str:
        """Build Emby WebSocket URL.

        Emby uses /embywebsocket endpoint.
        Converts http:// to ws:// and https:// to wss://.
        """
        base_url = server.url.rstrip('/')
        parsed = urlparse(base_url)

        # Convert HTTP scheme to WebSocket scheme
        scheme = 'wss' if parsed.scheme == 'https' else 'ws'
        netloc = parsed.netloc or parsed.path
        path = parsed.path.rstrip('/')

        if not netloc:
            raise ValueError(f"Invalid Emby server URL: {server.url}")

        # Build WebSocket URL with /embywebsocket endpoint
        if path:
            ws_path = f"{path}/embywebsocket"
        else:
            ws_path = "/embywebsocket"

        return f"{scheme}://{netloc}{ws_path}?api_key={server.api_key}&deviceId=mum"

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

        while not self.stop_event.is_set():
            with self.app.app_context():
                server = MediaServer.query.get(server_id)
                if not server or not server.is_active:
                    self.logger.info("EmbyWebsocketMonitor: Server %s inactive; retrying in 60s.", server_id)
                    if self.stop_event.wait(60):
                        return
                    continue

                if not server.api_key or not server.url:
                    self.logger.warning("EmbyWebsocketMonitor: Server %s missing URL or API key; retrying in 60s.", server_id)
                    if self.stop_event.wait(60):
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

            if self.stop_event.wait(backoff):
                return
            backoff = min(max_backoff, backoff * 2)


def start_emby_websocket_monitor(app) -> None:
    global _MONITOR_INSTANCE
    with _MONITOR_LOCK:
        if _MONITOR_INSTANCE is not None:
            app.logger.debug("EmbyWebsocketMonitor: Already active; skipping start.")
            return
        monitor = EmbyWebsocketMonitor(app)
        _MONITOR_INSTANCE = monitor
        threading.Thread(target=monitor.start, name="emby-ws-main", daemon=True).start()
