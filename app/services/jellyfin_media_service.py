# File: app/services/jellyfin_media_service.py
"""
Jellyfin Media Service implementation.

Sessions are sourced exclusively from the websocket monitor (no HTTP polling).
"""
from typing import List, Dict, Any, Optional, Tuple
import requests
import json
from urllib.parse import urlencode
from flask import url_for

from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType
from app.models import User, UserType
from app.utils.timeout_helper import get_api_timeout_with_fallback
from app.utils.format_rate import format_bps_rate
from app.services import realtime_session_cache


class JellyfinMediaService(BaseMediaService):
    @property
    def service_type(self) -> ServiceType:
        return ServiceType.JELLYFIN

    def __init__(self, server_config: Dict[str, Any]):
        super().__init__(server_config)
        self.session = requests.Session()
        self.session.timeout = 30
        self._authenticated = False

    def _authenticate(self) -> bool:
        try:
            if not self.api_key:
                self.log_error("API key is required for Jellyfin authentication")
                return False
            self.session.headers.update(
                {
                    "X-Emby-Token": self.api_key,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                }
            )
            response = self.session.get(f"{self.url.rstrip('/')}/System/Info", timeout=get_api_timeout_with_fallback(10))
            response.raise_for_status()
            self._authenticated = True
            return True
        except Exception as e:
            self.log_error(f"Authentication failed: {e}")
            return False

    def test_connection(self) -> Tuple[bool, str]:
        try:
            if not self._authenticate():
                return False, "Authentication failed. Check API key and server URL."
            response = self.session.get(f"{self.url.rstrip('/')}/System/Info", timeout=get_api_timeout_with_fallback(10))
            response.raise_for_status()
            info = response.json()
            return True, f"Connected to Jellyfin '{info.get('ServerName','Unknown')}' (v{info.get('Version','Unknown')})"
        except Exception as e:
            return False, f"Connection failed: {e}"

    def get_libraries_raw(self) -> List[Dict[str, Any]]:
        try:
            if not self._authenticated and not self._authenticate():
                return []
            resp = self.session.get(f"{self.url.rstrip('/')}/Library/VirtualFolders", timeout=get_api_timeout_with_fallback(10))
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            self.log_error(f"Error retrieving raw libraries: {e}")
            return []

    def get_libraries(self) -> List[Dict[str, Any]]:
        try:
            raw = self.get_libraries_raw()
            result = []
            for lib in raw:
                result.append(
                    {
                        "id": lib.get("ItemId") or lib.get("Name"),
                        "name": lib.get("Name", "Unknown"),
                        "type": lib.get("CollectionType", "mixed").lower(),
                        "item_count": 0,
                        "external_id": lib.get("ItemId") or lib.get("Name"),
                    }
                )
            return result
        except Exception as e:
            self.log_error(f"Error processing libraries: {e}")
            return []

    def get_users(self) -> List[Dict[str, Any]]:
        try:
            if not self._authenticated and not self._authenticate():
                return []
            owner_user_id: Optional[str] = None
            if isinstance(self.config, dict):
                configured_owner_id = (self.config.get("jellyfin_owner_user_id") or "").strip()
                if configured_owner_id:
                    owner_user_id = configured_owner_id
                    self.log_info("Using configured Jellyfin owner ID for owner detection.")

            if not owner_user_id:
                try:
                    me_resp = self.session.get(
                        f"{self.url.rstrip('/')}/Users/Me",
                        timeout=get_api_timeout_with_fallback(10),
                    )
                    if me_resp.status_code == 400:
                        # API keys can be server-scoped and not owned by a user.
                        self.log_info("Jellyfin token is not owned by a user; owner detection skipped.")
                    else:
                        me_resp.raise_for_status()
                        me_payload = me_resp.json() or {}
                        owner_user_id = me_payload.get("Id")
                except Exception as me_err:
                    self.log_warning(f"Failed to resolve Jellyfin owner via /Users/Me: {me_err}")
            resp = self.session.get(f"{self.url.rstrip('/')}/Users", timeout=get_api_timeout_with_fallback(10))
            resp.raise_for_status()
            users = resp.json()
            result = []
            for user in users:
                user_id = user.get("Id")
                policy = user.get("Policy") or {}
                if not policy and user_id:
                    try:
                        policy_resp = self.session.get(
                            f"{self.url.rstrip('/')}/Users/{user_id}/Policy",
                            timeout=get_api_timeout_with_fallback(10),
                        )
                        policy_resp.raise_for_status()
                        policy = policy_resp.json()
                    except Exception:
                        policy = {}
                allow_downloads = bool(policy.get("EnableContentDownloading", False))
                is_media_server_owner = bool(owner_user_id and user_id == owner_user_id)
                result.append(
                    {
                        "id": user_id,
                        "uuid": user_id,
                        "username": user.get("Name"),
                        "email": user.get("PrimaryImageTag"),  # Jellyfin doesn't expose email by default
                        "thumb": None,
                        "is_home_user": False,
                        "allow_downloads": allow_downloads,
                        "is_media_server_owner": is_media_server_owner,
                        "raw_data": {
                            "user": user,
                            "policy": policy,
                            "is_media_server_owner": is_media_server_owner,
                            "owner_user_id": owner_user_id,
                        },
                    }
                )
            return result
        except Exception as e:
            self.log_error(f"Error fetching users: {e}")
            return []

    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        try:
            if not self._authenticated and not self._authenticate():
                return {}
            payload = {"Name": username, "Password": password or ""}
            resp = self.session.post(f"{self.url.rstrip('/')}/Users/New", json=payload, timeout=get_api_timeout_with_fallback(10))
            resp.raise_for_status()
            data = resp.json()
            return {"id": data.get("Id"), "username": username}
        except Exception as e:
            self.log_error(f"Error creating user: {e}")
            return {}

    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        try:
            if not self._authenticated and not self._authenticate():
                return False
            payload = {"EnableAllFolders": False, "EnabledFolders": library_ids or []}
            resp = self.session.post(f"{self.url.rstrip('/')}/Users/{user_id}/Policy", json=payload, timeout=get_api_timeout_with_fallback(10))
            resp.raise_for_status()
            return True
        except Exception as e:
            self.log_error(f"Error updating user access: {e}")
            return False

    def delete_user(self, user_id: str) -> bool:
        try:
            if not self._authenticated and not self._authenticate():
                return False
            resp = self.session.delete(f"{self.url.rstrip('/')}/Users/{user_id}", timeout=get_api_timeout_with_fallback(10))
            resp.raise_for_status()
            return True
        except Exception as e:
            self.log_error(f"Error deleting user {user_id}: {e}")
            return False

    def check_username_exists(self, username: str) -> bool:
        """Check if a username already exists in Jellyfin."""
        try:
            users = self.get_users()
            for user in users:
                if (user.get("username") or "").lower() == username.lower():
                    return True
            return False
        except Exception as e:
            self.log_error(f"Error checking username '{username}': {e}")
            return False

    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        try:
            if not self._authenticated and not self._authenticate():
                return False
            data = {"Reason": reason or "Terminated by administrator"}
            resp = self.session.post(
                f"{self.url.rstrip('/')}/Sessions/{session_id}/Playing/Stop",
                json=data,
                timeout=get_api_timeout_with_fallback(10),
            )
            resp.raise_for_status()
            return True
        except Exception as e:
            self.log_error(f"Error terminating session {session_id}: {e}")
            return False

    def send_session_message(
        self,
        session_id: str,
        text: str,
        header: str | None = None,
        timeout_ms: int | None = None,
    ) -> bool:
        try:
            if not self._authenticated and not self._authenticate():
                return False
            if not text:
                return False
            payload = {"Text": text, "Header": header or "MUM"}
            if timeout_ms is not None:
                payload["TimeoutMs"] = int(timeout_ms)
            resp = self.session.post(
                f"{self.url.rstrip('/')}/Sessions/{session_id}/Message",
                json=payload,
                timeout=get_api_timeout_with_fallback(10),
            )
            resp.raise_for_status()
            return True
        except Exception as e:
            self.log_error(f"Error sending session message {session_id}: {e}")
            return False

    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Sessions are sourced solely from the websocket monitor cache.

        This returns the raw sessions cached by the websocket monitor.
        For HTTP session polling (which we don't use for Jellyfin), this would make an API call.
        """
        return realtime_session_cache.get_sessions(ServiceType.JELLYFIN.value, self.server_id)

    def _format_sessions(self, raw_sessions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not raw_sessions:
            return []

        # Build lookup maps for both username and user ID
        jellyfin_usernames = {s.get("UserName") for s in raw_sessions if s.get("UserName")}
        jellyfin_user_ids = {s.get("UserId") for s in raw_sessions if s.get("UserId")}

        mum_users_map_by_username = {}
        mum_users_map_by_userid = {}

        if jellyfin_usernames or jellyfin_user_ids:
            # Query for users matching either by username or external user ID
            from sqlalchemy import or_
            conditions = []
            if jellyfin_usernames:
                conditions.append(User.external_username.in_(list(jellyfin_usernames)))
            if jellyfin_user_ids:
                conditions.append(User.external_user_id.in_(list(jellyfin_user_ids)))
                conditions.append(User.external_user_alt_id.in_(list(jellyfin_user_ids)))

            accesses = User.query.filter_by(
                userType=UserType.SERVICE,
                server_id=self.server_id
            ).filter(or_(*conditions)).all()

            for access in accesses:
                # Store the SERVICE user (primary), with linked LOCAL user as backup
                service_user = access
                linked_local_user = None
                if access.linkedUserId:
                    linked_local_user = User.query.filter_by(userType=UserType.LOCAL, uuid=access.linkedUserId).first()

                # Prioritize SERVICE user, fall back to linked LOCAL user
                user_to_store = service_user if service_user else linked_local_user

                if user_to_store:
                    if access.external_username:
                        mum_users_map_by_username[access.external_username] = user_to_store
                    if access.external_user_id:
                        mum_users_map_by_userid[access.external_user_id] = user_to_store
                    if access.external_user_alt_id:
                        mum_users_map_by_userid[access.external_user_alt_id] = user_to_store

        formatted: List[Dict[str, Any]] = []

        def get_standard_resolution(height_str):
            if not height_str:
                return "SD"
            try:
                height = int(height_str)
                if height <= 240: return "240p"
                if height <= 360: return "360p"
                if height <= 480: return "480p"
                if height <= 576: return "576p"
                if height <= 720: return "720p"
                if height <= 1080: return "1080p"
                if height <= 1440: return "1440p"
                if height <= 2160: return "4K"
                return f"{height}p"
            except Exception:
                return "SD"

        for raw_session in raw_sessions:
            try:
                # Skip sessions without active playback
                now_playing = raw_session.get("NowPlayingItem")
                if not now_playing:
                    continue

                user_name = raw_session.get("UserName", "Unknown User")
                play_state = raw_session.get("PlayState", {})
                player_title = raw_session.get("DeviceName", "Unknown Device")
                player_platform = raw_session.get("Client", "")
                product = raw_session.get("ApplicationVersion", "N/A")
                media_title = now_playing.get("Name", "Unknown Title")
                media_type = now_playing.get("Type", "unknown").capitalize()
                year = now_playing.get("ProductionYear")
                library_name = "Library"

                position_ticks = play_state.get("PositionTicks", 0)
                runtime_ticks = now_playing.get("RunTimeTicks", 0)
                progress = (position_ticks / runtime_ticks) * 100 if runtime_ticks else 0

                # Build thumb URL manually without url_for (to avoid request context issues)
                thumb_url = None
                item_id = now_playing.get("Id")
                if item_id:
                    # Build relative URL that the frontend can use
                    if media_type == "Episode" and now_playing.get("SeriesId"):
                        series_image_tag = now_playing.get("SeriesPrimaryImageTag") or (now_playing.get("ImageTags") or {}).get("SeriesPrimary")
                        thumb_url = f"/admin/api/v2/media/jellyfin/images/proxy?item_id={now_playing.get('SeriesId')}&image_type=Primary"
                        if series_image_tag:
                            thumb_url += f"&image_tag={series_image_tag}"
                    else:
                        primary_image_tag = now_playing.get("PrimaryImageTag") or (now_playing.get("ImageTags") or {}).get("Primary")
                        thumb_url = f"/admin/api/v2/media/jellyfin/images/proxy?item_id={item_id}&image_type=Primary"
                        if primary_image_tag:
                            thumb_url += f"&image_tag={primary_image_tag}"

                play_method_raw = play_state.get("PlayMethod") or ""
                play_method = str(play_method_raw).strip().lower()
                is_transcoding = play_method == "transcode"
                is_direct_stream = play_method == "directstream"
                transcoding_info = raw_session.get("TranscodingInfo", {})
                media_sources = now_playing.get("MediaSources", []) or []
                if isinstance(media_sources, dict):
                    media_sources = [media_sources]
                media_source = media_sources[0] if media_sources else {}
                media_streams = now_playing.get("MediaStreams", [])
                original_video_stream = next((s for s in media_streams if s.get("Type") == "Video"), None)
                original_audio_stream = next((s for s in media_streams if s.get("Type") == "Audio" and s.get("IsDefault")), None)

                if is_transcoding and transcoding_info:
                    hardware_accel = transcoding_info.get("HardwareAccelerationType", "none")
                    stream_details = f"Transcode (HW: {hardware_accel.upper()})" if hardware_accel and hardware_accel != "none" else "Transcode"
                    original_container = now_playing.get("Container", "Unknown").upper()
                    transcoded_container = transcoding_info.get("Container", "Unknown").upper()
                    if original_container != transcoded_container:
                        container_detail = f"Converting ({original_container} -> {transcoded_container})"
                    else:
                        container_detail = f"Container: {transcoded_container}"

                    is_video_direct = transcoding_info.get("IsVideoDirect", False)
                    if is_video_direct and original_video_stream:
                        original_height = original_video_stream.get("Height", 0)
                        original_res = get_standard_resolution(original_height)
                        original_codec = original_video_stream.get("Codec", "Unknown").upper()
                        video_detail = f"Direct Stream ({original_codec} {original_res})"
                    else:
                        original_height = original_video_stream.get("Height", 0) if original_video_stream else 0
                        original_res = get_standard_resolution(original_height)
                        original_codec = original_video_stream.get("Codec", "Unknown").upper() if original_video_stream else "Unknown"
                        transcoded_height = transcoding_info.get("Height", 0)
                        transcoded_res = get_standard_resolution(transcoded_height)
                        transcoded_codec = transcoding_info.get("VideoCodec", "Unknown").upper()
                        video_detail = f"Transcode ({original_codec} {original_res} -> {transcoded_codec} {transcoded_res})" if original_video_stream else f"Transcode (-> {transcoded_codec} {transcoded_res})"

                    is_audio_direct = transcoding_info.get("IsAudioDirect", False)
                    if is_audio_direct and original_audio_stream:
                        audio_detail = f"Direct Stream ({original_audio_stream.get('DisplayTitle','Unknown Audio')})"
                    else:
                        original_audio_display = original_audio_stream.get("DisplayTitle", "Unknown Audio") if original_audio_stream else "Unknown Audio"
                        transcoded_codec = transcoding_info.get("AudioCodec", "Unknown").upper()
                        transcoded_channels = transcoding_info.get("AudioChannels", 0)
                        channel_layout_map = {1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1"}
                        transcoded_layout = channel_layout_map.get(transcoded_channels, f"{transcoded_channels}ch")
                        transcoded_audio_display = f"{transcoded_codec} {transcoded_layout}"
                        audio_detail = f"Transcode ({original_audio_display} -> {transcoded_audio_display})"

                    transcoded_height = transcoding_info.get("Height", 0)
                    transcoded_res = get_standard_resolution(transcoded_height)
                    transcoded_bitrate = transcoding_info.get("Bitrate", 0)
                    transcoded_label = format_bps_rate(transcoded_bitrate)
                    quality_detail = (
                        f"{transcoded_res} ({transcoded_label})"
                        if transcoded_label
                        else f"{transcoded_res} (Transcoding)"
                    )
                else:
                    stream_details = "Direct Stream" if is_direct_stream else "Direct Play"
                    container_detail = now_playing.get("Container", "Unknown").upper()
                    if original_video_stream:
                        original_height = original_video_stream.get("Height", 0)
                        original_res = get_standard_resolution(original_height)
                        original_codec = original_video_stream.get("Codec", "Unknown").upper()
                        video_detail = f"{stream_details} ({original_codec} {original_res})"
                    else:
                        video_detail = f"{stream_details} (Unknown Video)"
                    if original_audio_stream:
                        audio_detail = f"{stream_details} ({original_audio_stream.get('DisplayTitle','Unknown Audio')})"
                    else:
                        audio_detail = f"{stream_details} (Unknown Audio)"
                    quality_detail = get_standard_resolution(original_video_stream.get("Height") if original_video_stream else None)

                def safe_int(value, default=0):
                    try:
                        if value is None:
                            return default
                        if isinstance(value, bool):
                            return default
                        if isinstance(value, (int, float)):
                            return int(value)
                        if isinstance(value, str) and value.strip():
                            return int(float(value.strip()))
                    except Exception:
                        return default
                    return default

                # Estimate bandwidth from bitrate:
                # - Match Plex/legacy behavior where `bitrate_calc` is in kbps.
                # - Jellyfin reports stream/transcode bitrates in bps.
                bitrate_bps = 0
                if isinstance(transcoding_info, dict):
                    bitrate_bps = safe_int(transcoding_info.get("Bitrate"), 0)
                if not bitrate_bps:
                    bitrate_bps += safe_int((original_video_stream or {}).get("BitRate"), 0)
                    if original_audio_stream:
                        bitrate_bps += safe_int(original_audio_stream.get("BitRate"), 0)
                    else:
                        first_audio_stream = next((s for s in media_streams if s.get("Type") == "Audio"), None)
                        bitrate_bps += safe_int((first_audio_stream or {}).get("BitRate"), 0)

                bitrate_calc_kbps = int(round(bitrate_bps / 1000.0)) if bitrate_bps else 0

                source_bitrate_bps = 0
                queue_items = raw_session.get("NowPlayingQueueFullItems") or []
                match_item = next(
                    (item for item in queue_items if item.get("Id") == now_playing.get("Id")),
                    None,
                )
                if match_item:
                    queue_sources = match_item.get("MediaSources", []) or []
                    if isinstance(queue_sources, dict):
                        queue_sources = [queue_sources]
                    queue_source = queue_sources[0] if queue_sources else {}
                    source_bitrate_bps = safe_int(queue_source.get("Bitrate"), 0)
                media_bitrate_kbps = int(round(source_bitrate_bps / 1000.0)) if source_bitrate_bps else None

                bandwidth_label = format_bps_rate(bitrate_bps)
                bandwidth_detail = (
                    bandwidth_label
                    if bandwidth_label
                    else f"Streaming via {'LAN' if raw_session.get('IsLocal', True) else 'WAN'}"
                )
                location_ip = raw_session.get("RemoteEndPoint", "N/A")
                is_local = raw_session.get("IsLocal", True)
                session_key = raw_session.get("Id", "")

                def format_time_ms(milliseconds):
                    if not milliseconds:
                        return "0:00"
                    seconds = int(milliseconds / 1000)
                    hours = seconds // 3600
                    minutes = (seconds % 3600) // 60
                    secs = seconds % 60
                    if hours > 0:
                        return f"{hours}:{minutes:02d}:{secs:02d}"
                    else:
                        return f"{minutes}:{secs:02d}"

                playback_position_ms = int(play_state.get("PositionTicks", 0) / 10000)
                runtime_ms = int(now_playing.get("RunTimeTicks", 0) / 10000) if now_playing.get("RunTimeTicks") else None
                current_time_formatted = format_time_ms(playback_position_ms) if playback_position_ms else "0:00"
                duration_formatted = format_time_ms(runtime_ms) if runtime_ms else "0:00"

                subtitle_index = play_state.get("SubtitleStreamIndex")
                subtitle_detail = None
                if subtitle_index is None or subtitle_index == -1:
                    subtitle_detail = "None"
                else:
                    subtitle_stream = next(
                        (s for s in media_streams if s.get("Type") == "Subtitle" and s.get("Index") == subtitle_index),
                        None,
                    )
                    if subtitle_stream:
                        display = subtitle_stream.get("DisplayTitle", "Unknown")
                        codec = subtitle_stream.get("Codec", "Unknown").upper()
                        subtitle_detail = f"{display} ({codec})"
                    else:
                        subtitle_detail = "None"

                # Match by UserId first (more reliable), then fall back to username
                jellyfin_user_id = raw_session.get("UserId")
                mum_user = None
                if jellyfin_user_id:
                    mum_user = mum_users_map_by_userid.get(jellyfin_user_id)
                if not mum_user:
                    mum_user = mum_users_map_by_username.get(user_name)

                mum_user_id = mum_user.id if mum_user else None
                mum_user_uuid = mum_user.uuid if mum_user else None

                formatted.append(
                    {
                        "user": user_name,
                        "mum_user_id": mum_user_id,
                        "mum_user_uuid": mum_user_uuid,
                        "player_title": player_title,
                        "player_platform": player_platform,
                        "product": product,
                        "media_title": media_title,
                        "grandparent_title": now_playing.get("SeriesName"),
                        "parent_title": now_playing.get("Album", now_playing.get("SeriesName")),
                        "media_type": media_type,
                        "library_name": library_name,
                        "year": year,
                        "state": "paused" if play_state.get("IsPaused") else "playing",
                        "progress": round(progress, 1),
                        "thumb_url": thumb_url,
                        "session_key": session_key,
                        "quality_detail": quality_detail,
                        "stream_detail": stream_details,
                        "container_detail": container_detail,
                        "video_detail": video_detail,
                        "audio_detail": audio_detail,
                        "subtitle_detail": subtitle_detail,
                        "transcode_reason": None,
                        "location_detail": f"{'LAN' if is_local else 'WAN'}: {location_ip}",
                        "location_ip": location_ip,
                        "is_public_ip": not is_local,
                        "bandwidth_detail": bandwidth_detail,
                        "bitrate_calc": bitrate_calc_kbps,
                        "location_type_calc": "LAN" if is_local else "WAN",
                        "is_transcode_calc": is_transcoding,
                        "raw_data_json": json.dumps(raw_session, indent=2),
                        "media_path": media_source.get("Path") or now_playing.get("Path"),
                        "media_duration": runtime_ms,
                        "media_bitrate": media_bitrate_kbps,
                        "media_width": media_source.get("Width") or (original_video_stream or {}).get("Width"),
                        "media_height": media_source.get("Height") or (original_video_stream or {}).get("Height"),
                        "media_aspect_ratio": media_source.get("AspectRatio") or (original_video_stream or {}).get("AspectRatio"),
                        "media_audio_channels": media_source.get("AudioChannels") or (original_audio_stream or {}).get("Channels"),
                        "media_audio_codec": media_source.get("AudioCodec") or (original_audio_stream or {}).get("Codec"),
                        "media_video_codec": media_source.get("VideoCodec") or (original_video_stream or {}).get("Codec"),
                        "media_video_resolution": media_source.get("VideoResolution") or media_source.get("Height"),
                        "media_container": media_source.get("Container") or now_playing.get("Container"),
                        "media_video_frame_rate": media_source.get("VideoFrameRate") or (original_video_stream or {}).get("FrameRate"),
                        "media_video_profile": media_source.get("VideoProfile") or (original_video_stream or {}).get("Profile"),
                        "media_has_voice_activity": media_source.get("HasVoiceActivity"),
                        "service_type": "jellyfin",
                        "server_name": self.name,
                        "current_time": current_time_formatted,
                        "duration": duration_formatted,
                    }
                )
            except Exception as e:
                self.log_error(f"Error formatting Jellyfin session: {e}")

        return formatted

    def format_sessions_from_payload(self, raw_sessions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return self._format_sessions(raw_sessions)

    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        cached = realtime_session_cache.get_sessions(ServiceType.JELLYFIN.value, self.server_id)
        return self._format_sessions(cached)

    def get_server_info(self) -> Dict[str, Any]:
        """Lightweight health check used by dashboards/settings."""
        try:
            if not self._authenticated and not self._authenticate():
                return {
                    "name": self.name,
                    "url": self.url,
                    "service_type": self.service_type.value,
                    "online": False,
                    "version": "Unknown",
                    "error": "Authentication failed",
                }
            resp = self.session.get(
                f"{self.url.rstrip('/')}/System/Info",
                timeout=get_api_timeout_with_fallback(10),
            )
            resp.raise_for_status()
            info = resp.json()
            return {
                "name": info.get("ServerName", self.name),
                "url": self.url,
                "service_type": self.service_type.value,
                "online": True,
                "version": info.get("Version", "Unknown"),
                "server_id": info.get("Id", ""),
            }
        except Exception as e:
            self.log_error(f"Error getting server info: {e}")
            return {
                "name": self.name,
                "url": self.url,
                "service_type": self.service_type.value,
                "online": False,
                "version": "Unknown",
                "error": str(e),
            }
