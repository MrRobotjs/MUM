# File: app/services/emby_media_service.py
from typing import List, Dict, Any, Optional, Tuple
import requests

from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType
from app.utils.timeout_helper import get_api_timeout
from app.services import realtime_session_cache


class EmbyMediaService(BaseMediaService):
    """Emby implementation of BaseMediaService (sessions via websocket cache only)."""

    @property
    def service_type(self) -> ServiceType:
        return ServiceType.EMBY

    def _get_headers(self) -> Dict[str, str]:
        return {
            "X-Emby-Token": self.api_key,
            "Content-Type": "application/json",
        }

    def _make_request(self, endpoint: str, method: str = "GET", data: Dict | None = None) -> Any:
        url = f"{self.url.rstrip('/')}/emby/{endpoint.lstrip('/')}"
        headers = self._get_headers()
        timeout = get_api_timeout()

        try:
            if method == "GET":
                response = requests.get(url, headers=headers, timeout=timeout)
            elif method == "POST":
                response = requests.post(url, headers=headers, json=data, timeout=timeout)
            elif method == "DELETE":
                response = requests.delete(url, headers=headers, timeout=timeout)
            else:
                raise ValueError(f"Unsupported method: {method}")

            response.raise_for_status()
            return response.json() if response.content else {}
        except requests.exceptions.RequestException as e:
            self.log_error(f"API request failed: {e}")
            raise

    def test_connection(self) -> Tuple[bool, str]:
        try:
            info = self._make_request("System/Info")
            server_name = info.get("ServerName", "Emby Server")
            version = info.get("Version", "Unknown")
            return True, f"Connected to {server_name} (v{version})"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"

    def get_libraries_raw(self) -> List[Dict[str, Any]]:
        try:
            libraries = self._make_request("Library/VirtualFolders")
            self.log_info(f"Retrieved {len(libraries)} raw libraries from Emby")
            return libraries
        except Exception as e:
            self.log_error(f"Error fetching raw libraries: {e}")
            return []

    def get_libraries(self) -> List[Dict[str, Any]]:
        try:
            libraries = self.get_libraries_raw()
            result = []
            for lib in libraries:
                result.append(
                    {
                        "id": lib.get("ItemId", lib.get("Name", "")),
                        "name": lib.get("Name", "Unknown"),
                        "type": lib.get("CollectionType", "mixed").lower(),
                        "item_count": 0,
                        "external_id": lib.get("ItemId", lib.get("Name", "")),
                    }
                )
            return result
        except Exception as e:
            self.log_error(f"Error fetching libraries: {e}")
            return []

    def get_users(self) -> List[Dict[str, Any]]:
        try:
            users = self._make_request("Users")
            result = []
            for user in users:
                user_id = user.get("Id")
                if not user_id:
                    continue
                try:
                    policy = self._make_request(f"Users/{user_id}/Policy")
                    library_ids = policy.get("EnabledFolders", [])
                    allow_downloads = bool(policy.get("EnableContentDownloading", False))
                except Exception:
                    library_ids = []
                    allow_downloads = False
                result.append(
                    {
                        "id": user_id,
                        "uuid": user_id,
                        "username": user.get("Name", "Unknown"),
                        "email": user.get("Email"),
                        "thumb": None,
                        "is_home_user": False,
                        "library_ids": library_ids,
                        "allow_downloads": allow_downloads,
                        "is_admin": user.get("Policy", {}).get("IsAdministrator", False),
                    }
                )
            return result
        except Exception as e:
            self.log_error(f"Error fetching users: {e}")
            return []

    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        try:
            user_data = {"Name": username, "Email": email or "", "Password": password or ""}
            result = self._make_request("Users/New", method="POST", data=user_data)
            user_id = result.get("Id")
            library_ids = kwargs.get("library_ids", [])
            if library_ids and user_id:
                policy_data = {"EnabledFolders": library_ids, "EnableAllFolders": False}
                self._make_request(f"Users/{user_id}/Policy", method="POST", data=policy_data)
            return {"id": user_id, "username": username, "email": email}
        except Exception as e:
            self.log_error(f"Error creating user: {e}")
            return {}

    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        try:
            payload = {
                "EnabledFolders": library_ids or [],
                "EnableAllFolders": False,
            }
            self._make_request(f"Users/{user_id}/Policy", method="POST", data=payload)
            return True
        except Exception as e:
            self.log_error(f"Error updating user access: {e}")
            return False

    def delete_user(self, user_id: str) -> bool:
        try:
            self._make_request(f"Users/{user_id}", method="DELETE")
            return True
        except Exception as e:
            self.log_error(f"Error deleting user: {e}")
            return False

    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        try:
            data = {"Reason": reason or "Terminated by administrator"}
            self._make_request(f"Sessions/{session_id}/Playing/Stop", method="POST", data=data)
            return True
        except Exception as e:
            self.log_error(f"Error terminating session: {e}")
            return False

    def send_session_message(
        self,
        session_id: str,
        text: str,
        header: str | None = None,
        timeout_ms: int | None = None,
    ) -> bool:
        try:
            if not text:
                return False
            payload = {"Text": text, "Header": header or "MUM"}
            if timeout_ms is not None:
                payload["TimeoutMs"] = int(timeout_ms)
            self._make_request(f"Sessions/{session_id}/Message", method="POST", data=payload)
            return True
        except Exception as e:
            self.log_error(f"Error sending session message: {e}")
            return False

    def get_server_info(self) -> Dict[str, Any]:
        try:
            info = self._make_request("System/Info")
            return {
                "name": info.get("ServerName", self.name),
                "url": self.url,
                "service_type": self.service_type.value,
                "online": True,
                "version": info.get("Version", "Unknown"),
                "server_id": info.get("Id", ""),
            }
        except Exception:
            return {
                "name": self.name,
                "url": self.url,
                "service_type": self.service_type.value,
                "online": False,
                "version": "Unknown",
            }

    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Sessions are sourced solely from the websocket monitor cache.

        This returns the raw sessions cached by the websocket monitor.
        For HTTP session polling (which we don't use for Emby), this would make an API call.
        """
        return realtime_session_cache.get_sessions(ServiceType.EMBY.value, self.server_id)

    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        """Format active sessions from the websocket cache."""
        import json
        from sqlalchemy import or_
        from app.models import User, UserType

        raw_sessions = realtime_session_cache.get_sessions(ServiceType.EMBY.value, self.server_id)
        if not raw_sessions:
            return []

        # Build lookup maps for both username and user ID
        emby_usernames = {s.get("UserName") for s in raw_sessions if s.get("UserName")}
        emby_user_ids = {s.get("UserId") for s in raw_sessions if s.get("UserId")}

        mum_users_map_by_username = {}
        mum_users_map_by_userid = {}

        if emby_usernames or emby_user_ids:
            # Query for users matching either by username or external user ID
            conditions = []
            if emby_usernames:
                conditions.append(User.external_username.in_(list(emby_usernames)))
            if emby_user_ids:
                conditions.append(User.external_user_id.in_(list(emby_user_ids)))
                conditions.append(User.external_user_alt_id.in_(list(emby_user_ids)))

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

        def format_time_ms(milliseconds: int) -> str:
            if not milliseconds:
                return "0:00"
            seconds = int(milliseconds / 1000)
            hours = seconds // 3600
            minutes = (seconds % 3600) // 60
            secs = seconds % 60
            if hours > 0:
                return f"{hours}:{minutes:02d}:{secs:02d}"
            return f"{minutes}:{secs:02d}"

        def get_standard_resolution(height: int | None) -> str:
            if not height:
                return "SD"
            try:
                h = int(height)
                if h <= 240: return "240p"
                if h <= 360: return "360p"
                if h <= 480: return "480p"
                if h <= 576: return "576p"
                if h <= 720: return "720p"
                if h <= 1080: return "1080p"
                if h <= 1440: return "1440p"
                if h <= 2160: return "4K"
                return f"{h}p"
            except Exception:
                return "SD"

        formatted: List[Dict[str, Any]] = []
        for session in raw_sessions:
            try:
                user_name = session.get("UserName", "Unknown User")
                now_playing = session.get("NowPlayingItem") or {}
                play_state = session.get("PlayState") or {}
                device_name = session.get("DeviceName") or "Unknown Device"
                client = session.get("Client") or session.get("ApplicationVersion") or ""

                position_ticks = play_state.get("PositionTicks", 0)
                runtime_ticks = now_playing.get("RunTimeTicks", 0)
                progress = (position_ticks / runtime_ticks) * 100 if runtime_ticks else 0

                media_title = now_playing.get("Name", "Unknown Title")
                media_type = (now_playing.get("Type") or "unknown").capitalize()
                year = now_playing.get("ProductionYear")

                # Build thumb URL using Emby image proxy
                thumb_url = None
                item_id = now_playing.get("Id")
                media_type_raw = now_playing.get("Type") or ""
                media_type_lower = str(media_type_raw).lower()
                if item_id:
                    if media_type_lower == "episode" and now_playing.get("SeriesId"):
                        series_id = now_playing.get("SeriesId")
                        series_image_tag = (
                            now_playing.get("SeriesPrimaryImageTag")
                            or (now_playing.get("ImageTags") or {}).get("SeriesPrimary")
                        )
                        thumb_url = f"/admin/api/v2/media/emby/images/proxy?item_id={series_id}&image_type=Primary"
                        if series_image_tag:
                            thumb_url += f"&image_tag={series_image_tag}"
                    else:
                        primary_image_tag = (
                            now_playing.get("PrimaryImageTag")
                            or (now_playing.get("ImageTags") or {}).get("Primary")
                        )
                        thumb_url = f"/admin/api/v2/media/emby/images/proxy?item_id={item_id}&image_type=Primary"
                        if primary_image_tag:
                            thumb_url += f"&image_tag={primary_image_tag}"

                is_transcoding = play_state.get("PlayMethod") == "Transcode"
                transcoding_info = session.get("TranscodingInfo") or {}
                media_streams = now_playing.get("MediaStreams", [])
                media_sources = now_playing.get("MediaSources", []) or []
                if isinstance(media_sources, dict):
                    media_sources = [media_sources]
                media_source = media_sources[0] if media_sources else {}

                original_video_stream = next((s for s in media_streams if s.get("Type") == "Video"), None)
                original_audio_stream = next((s for s in media_streams if s.get("Type") == "Audio" and s.get("IsDefault")), None)

                stream_detail = "Direct Play"
                video_detail = ""
                audio_detail = ""
                container_detail = (now_playing.get("Container") or "Unknown").upper()
                quality_detail = ""

                if is_transcoding and transcoding_info:
                    stream_detail = "Transcode"
                    target_height = transcoding_info.get("Height", 0)
                    quality_detail = get_standard_resolution(target_height)
                    transcoded_codec = transcoding_info.get("VideoCodec", "Unknown").upper()
                    video_detail = f"Transcode ({transcoded_codec} {quality_detail})"
                    audio_codec = transcoding_info.get("AudioCodec", "Unknown").upper()
                    audio_channels = transcoding_info.get("AudioChannels", 0)
                    audio_detail = f"Transcode ({audio_codec} {audio_channels}ch)"
                else:
                    if original_video_stream:
                        video_detail = f"Direct Play ({original_video_stream.get('Codec','Unknown').upper()} {get_standard_resolution(original_video_stream.get('Height'))})"
                    else:
                        video_detail = "Direct Play (Unknown Video)"
                    if original_audio_stream:
                        audio_detail = f"Direct Play ({original_audio_stream.get('DisplayTitle','Unknown Audio')})"
                    else:
                        audio_detail = "Direct Play (Unknown Audio)"
                    quality_detail = get_standard_resolution(original_video_stream.get("Height") if original_video_stream else None)

                location_ip = session.get("RemoteEndPoint", "N/A")
                is_remote = session.get("IsRemote", False)
                location_lan_wan = "WAN" if is_remote else "LAN"
                session_key = session.get("Id", "")

                current_time = format_time_ms(int(position_ticks / 10000)) if position_ticks else "0:00"
                duration_time = format_time_ms(int(runtime_ticks / 10000)) if runtime_ticks else "0:00"
                runtime_ms = int(runtime_ticks / 10000) if runtime_ticks else None

                # Match by UserId first (more reliable), then fall back to username
                emby_user_id = session.get("UserId")
                mum_user = None
                if emby_user_id:
                    mum_user = mum_users_map_by_userid.get(emby_user_id)
                if not mum_user:
                    mum_user = mum_users_map_by_username.get(user_name)

                mum_user_id = mum_user.id if mum_user else None
                mum_user_uuid = mum_user.uuid if mum_user else None

                playback_state = "paused" if play_state.get("IsPaused") else "playing"

                formatted.append(
                    {
                        "user": user_name,
                        "mum_user_id": mum_user_id,
                        "mum_user_uuid": mum_user_uuid,
                        "player_title": device_name,
                        "player_platform": client,
                        "product": client,
                        "media_title": media_title,
                        "grandparent_title": now_playing.get("SeriesName"),
                        "parent_title": now_playing.get("Album", now_playing.get("SeriesName")),
                        "media_type": media_type,
                        "library_name": now_playing.get("LibraryName") or "Library",
                        "year": year,
                        "state": playback_state,
                        "progress": round(progress, 1),
                        "thumb_url": thumb_url,
                        "session_key": session_key,
                        "quality_detail": quality_detail,
                        "stream_detail": stream_detail,
                        "container_detail": container_detail,
                        "video_detail": video_detail,
                        "audio_detail": audio_detail,
                        "subtitle_detail": None,
                        "transcode_reason": None,
                        "location_detail": f"{location_lan_wan}: {location_ip}",
                        "location_ip": location_ip,
                        "is_public_ip": is_remote,
                        "bandwidth_detail": f"Streaming via {location_lan_wan}",
                        "bitrate_calc": None,
                        "location_type_calc": location_lan_wan,
                        "is_transcode_calc": is_transcoding,
                        "raw_data_json": json.dumps(session, indent=2),
                        "media_path": media_source.get("Path") or now_playing.get("Path"),
                        "media_duration": runtime_ms,
                        "media_bitrate": (
                            int(media_source.get("Bitrate") / 1000)
                            if media_source.get("Bitrate")
                            else None
                        ),
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
                        "service_type": "emby",
                        "server_name": self.name,
                        "current_time": current_time,
                        "duration": duration_time,
                    }
                )
            except Exception as e:
                self.log_error(f"Error formatting Emby session: {e}")

        return formatted

    def get_geoip_info(self, ip_address: str) -> Dict[str, Any]:
        if not ip_address or ip_address in ["127.0.0.1", "localhost"]:
            return {"status": "local", "message": "This is a local address."}
        try:
            response = requests.get(f"http://ip-api.com/json/{ip_address}")
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            self.log_error(f"Failed to get GeoIP info for {ip_address}: {e}")
            return {"status": "error", "message": str(e)}

    def check_username_exists(self, username: str) -> bool:
        try:
            users = self.get_users()
            for user in users:
                if user.get("Name", "").lower() == username.lower():
                    return True
            return False
        except Exception as e:
            self.log_error(f"Error checking username '{username}': {e}")
            return False
