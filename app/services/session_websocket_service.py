"""
Session WebSocket Service
Monitors media server sessions and broadcasts changes via WebSocket
"""
from flask import current_app
from typing import Dict, List, Any, Set
import time
import hashlib
import json


class SessionWebSocketService:
    """Service to monitor and broadcast session changes via WebSocket"""

    def __init__(self):
        self._last_session_hash = {}  # server_id -> hash of sessions
        self._monitoring = False

    def _hash_sessions(self, sessions: List[Dict[str, Any]]) -> str:
        """
        Create a hash of session data to detect changes
        Only includes fields that indicate meaningful changes
        """
        # Extract only the important fields for change detection
        session_keys = []
        for session in sessions:
            # Create a unique identifier for each session
            key_data = {
                'session_key': session.get('session_key'),
                'state': session.get('state'),
                'progress_percent': session.get('progress_percent_calc', 0),
                'user_display': session.get('user_display_name'),
                'media_title': session.get('media_title')
            }
            session_keys.append(json.dumps(key_data, sort_keys=True))

        # Sort to ensure consistent ordering
        session_keys.sort()

        # Create hash
        content = '|'.join(session_keys)
        return hashlib.md5(content.encode('utf-8')).hexdigest()

    def check_and_broadcast_changes(self):
        """
        Check all media servers for session changes and broadcast if detected
        Should be called periodically by a background task
        """
        from app.services.media_service_manager import MediaServiceManager
        from app.services.media_service_factory import MediaServiceFactory

        try:
            all_servers = MediaServiceManager.get_all_servers()
            changes_detected = False
            all_sessions = []

            for server in all_servers:
                # Only process Plex for now
                if server.service_type.value != 'plex':
                    continue

                service = MediaServiceFactory.create_service_from_db(server)
                if not service:
                    continue

                try:
                    # Get formatted sessions
                    formatted_sessions = service.get_formatted_sessions()
                    all_sessions.extend(formatted_sessions)

                    # Calculate hash for change detection
                    current_hash = self._hash_sessions(formatted_sessions)
                    previous_hash = self._last_session_hash.get(server.id)

                    # Check if sessions changed
                    if current_hash != previous_hash:
                        current_app.logger.debug(
                            f"Session change detected for {server.server_nickname}: "
                            f"hash {previous_hash} -> {current_hash}"
                        )
                        self._last_session_hash[server.id] = current_hash
                        changes_detected = True

                except Exception as e:
                    current_app.logger.error(
                        f"Error checking sessions for {server.server_nickname}: {e}"
                    )

            # Only emit if changes detected
            if changes_detected:
                self._emit_session_update(all_sessions)

        except Exception as e:
            current_app.logger.error(f"Error in check_and_broadcast_changes: {e}")

    def _emit_session_update(self, sessions: List[Dict[str, Any]]):
        """Emit session update to all connected clients"""
        try:
            # Import here to avoid circular dependency
            from app.extensions import socketio

            # Calculate summary stats
            summary_stats = self._calculate_summary_stats(sessions)

            # Emit to all connected clients in the 'streaming' room
            socketio.emit(
                'session_update',
                {
                    'sessions': sessions,
                    'summary_stats': summary_stats,
                    'timestamp': time.time()
                },
                room='streaming',
                namespace='/streaming'
            )

            current_app.logger.debug(
                f"Emitted session update: {len(sessions)} active sessions"
            )

        except Exception as e:
            current_app.logger.error(f"Error emitting session update: {e}")

    def _calculate_summary_stats(self, sessions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Calculate summary statistics from sessions"""
        summary = {
            "total_streams": len(sessions),
            "direct_play_count": 0,
            "transcode_count": 0,
            "total_bandwidth_mbps": 0.0,
            "lan_bandwidth_mbps": 0.0,
            "wan_bandwidth_mbps": 0.0
        }

        for session in sessions:
            # Count transcoding vs direct play
            if session.get('is_transcode_calc', False):
                summary["transcode_count"] += 1
            else:
                summary["direct_play_count"] += 1

            # Calculate bandwidth
            bitrate_calc = session.get('bitrate_calc', 0)
            bitrate_mbps = bitrate_calc / 1000.0 if bitrate_calc else 0.0

            summary["total_bandwidth_mbps"] += bitrate_mbps

            # LAN vs WAN bandwidth
            if session.get('location_type_calc') == 'LAN':
                summary["lan_bandwidth_mbps"] += bitrate_mbps
            else:
                summary["wan_bandwidth_mbps"] += bitrate_mbps

        # Round values
        summary["total_bandwidth_mbps"] = round(summary["total_bandwidth_mbps"], 1)
        summary["lan_bandwidth_mbps"] = round(summary["lan_bandwidth_mbps"], 1)
        summary["wan_bandwidth_mbps"] = round(summary["wan_bandwidth_mbps"], 1)

        return summary

    def force_update(self):
        """Force a session update broadcast (useful for manual refresh)"""
        # Clear hash cache to force detection of "changes"
        self._last_session_hash.clear()
        self.check_and_broadcast_changes()


# Global instance
session_ws_service = SessionWebSocketService()
