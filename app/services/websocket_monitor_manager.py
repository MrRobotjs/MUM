from __future__ import annotations

import threading
from typing import Optional

from app.models_media_services import MediaServer, ServiceType
from app.services.media_service_manager import MediaServiceManager

_WEBSOCKET_SERVICE_TYPES = {
    ServiceType.PLEX,
    ServiceType.JELLYFIN,
    ServiceType.EMBY,
}

_MANAGER_INSTANCE: Optional["WebsocketMonitorManager"] = None
_MANAGER_LOCK = threading.Lock()


class WebsocketMonitorManager:
    """Central coordinator for WebSocket monitors and per-server listeners."""

    def __init__(self, app) -> None:
        self.app = app
        self.logger = app.logger

    def set_app(self, app) -> None:
        self.app = app
        self.logger = app.logger

    def _supports_websocket(self, service_type: ServiceType) -> bool:
        return service_type in _WEBSOCKET_SERVICE_TYPES

    def _get_existing_monitor(self, service_type: ServiceType):
        if service_type == ServiceType.PLEX:
            from app.services import plex_websocket_monitor

            return plex_websocket_monitor._MONITOR_INSTANCE
        if service_type == ServiceType.JELLYFIN:
            from app.services import jellyfin_websocket_monitor

            return jellyfin_websocket_monitor._MONITOR_INSTANCE
        if service_type == ServiceType.EMBY:
            from app.services import emby_websocket_monitor

            return emby_websocket_monitor._MONITOR_INSTANCE
        return None

    def _get_monitor(self, service_type: ServiceType):
        if service_type == ServiceType.PLEX:
            from app.services import plex_websocket_monitor

            plex_websocket_monitor.start_plex_websocket_monitor(self.app)
            return plex_websocket_monitor._MONITOR_INSTANCE
        if service_type == ServiceType.JELLYFIN:
            from app.services import jellyfin_websocket_monitor

            jellyfin_websocket_monitor.start_jellyfin_websocket_monitor(self.app)
            return jellyfin_websocket_monitor._MONITOR_INSTANCE
        if service_type == ServiceType.EMBY:
            from app.services import emby_websocket_monitor

            emby_websocket_monitor.start_emby_websocket_monitor(self.app)
            return emby_websocket_monitor._MONITOR_INSTANCE
        return None

    def start_for_server(self, server: MediaServer) -> None:
        if not self._supports_websocket(server.service_type):
            return
        monitor = self._get_monitor(server.service_type)
        if monitor:
            monitor.start_for_server(server.id)

    def stop_for_server(self, service_type: ServiceType, server_id: int) -> None:
        if not self._supports_websocket(service_type):
            return
        monitor = self._get_existing_monitor(service_type)
        if monitor:
            monitor.stop_for_server(server_id)

    def reconcile_server(self, server_id: int) -> None:
        with self.app.app_context():
            server = MediaServer.query.get(server_id)
            if not server:
                return
            if not self._supports_websocket(server.service_type):
                return
            if MediaServiceManager.is_server_effectively_active(server):
                self.start_for_server(server)
            else:
                self.stop_for_server(server.service_type, server.id)

    def reconcile_service_type(self, service_type: ServiceType) -> None:
        if not self._supports_websocket(service_type):
            return
        with self.app.app_context():
            servers = MediaServer.query.filter_by(service_type=service_type).all()
            for server in servers:
                if MediaServiceManager.is_server_effectively_active(server):
                    self.start_for_server(server)
                else:
                    self.stop_for_server(service_type, server.id)

    def reconcile_all(self) -> None:
        for service_type in _WEBSOCKET_SERVICE_TYPES:
            self.reconcile_service_type(service_type)


def get_websocket_monitor_manager(app) -> WebsocketMonitorManager:
    global _MANAGER_INSTANCE
    with _MANAGER_LOCK:
        if _MANAGER_INSTANCE is None:
            _MANAGER_INSTANCE = WebsocketMonitorManager(app)
        else:
            _MANAGER_INSTANCE.set_app(app)
    return _MANAGER_INSTANCE
