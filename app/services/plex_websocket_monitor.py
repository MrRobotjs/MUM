"""Background Plex WebSocket monitor that triggers session processing on real-time events."""

from __future__ import annotations

import ssl
import threading
import time
from typing import Dict, List, Optional
from urllib.parse import urlparse

from flask import current_app
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

    def _handle_message(self, server_id: int, message) -> None:
        text = message.decode("utf-8", errors="ignore") if isinstance(message, bytes) else str(message)
        now = time.time()
        last_refresh = self.last_refresh_at.get(server_id, 0)
        if now - last_refresh < 2:
            return
        self.last_refresh_at[server_id] = now

        with self.app.app_context():
            current_app.logger.debug(
                "PlexWebsocketMonitor: Message from server %s (truncated): %s",
                server_id,
                text[:200],
            )
            try:
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
