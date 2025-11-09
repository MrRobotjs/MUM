"""
Jellyfin Media Service Implementation
Provides integration with Jellyfin servers for media management.
"""

import requests
import json
from typing import List, Dict, Any, Optional, Tuple
from flask import current_app
from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType
from app.models import User, UserType
from app.utils.timeout_helper import get_api_timeout_with_fallback


class JellyfinMediaService(BaseMediaService):
    """Jellyfin media service implementation"""
    
    @property
    def service_type(self) -> ServiceType:
        return ServiceType.JELLYFIN
    
    def __init__(self, server_config: Dict[str, Any]):
        super().__init__(server_config)
        self.session = requests.Session()
        self.session.timeout = 30
        self._authenticated = False
        
    def _authenticate(self) -> bool:
        """Authenticate with Jellyfin server and set up session"""
        try:
            if not self.api_key:
                self.log_error("API key is required for Jellyfin authentication")
                return False
                
            # Set up session headers
            self.session.headers.update({
                'X-Emby-Token': self.api_key,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            })
            
            # Test authentication with a simple API call
            response = self.session.get(
                f"{self.url.rstrip('/')}/System/Info",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            self._authenticated = True
            self.log_info("Successfully authenticated with Jellyfin server")
            return True
            
        except requests.exceptions.RequestException as e:
            self.log_error(f"Authentication failed: {e}")
            return False
        except Exception as e:
            self.log_error(f"Unexpected error during authentication: {e}")
            return False
    
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection to Jellyfin server"""
        try:
            if not self._authenticate():
                return False, "Authentication failed. Check API key and server URL."
            
            # Get system info
            response = self.session.get(
                f"{self.url.rstrip('/')}/System/Info",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            server_info = response.json()
            server_name = server_info.get('ServerName', 'Unknown')
            version = server_info.get('Version', 'Unknown')
            
            return True, f"Successfully connected to Jellyfin server '{server_name}' (v{version})"
            
        except requests.exceptions.ConnectTimeout:
            return False, "Connection to Jellyfin timed out. Check if the server is running and accessible."
        except requests.exceptions.ConnectionError:
            return False, "Could not connect to Jellyfin. Check the URL and network connectivity."
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 401:
                return False, "Authentication failed. Check API key."
            elif e.response.status_code == 403:
                return False, "Access denied. API key may not have sufficient permissions."
            else:
                return False, f"Jellyfin returned an error: {e.response.status_code} - {e.response.reason}"
        except requests.exceptions.Timeout:
            return False, "Request to Jellyfin timed out. The server may be slow to respond."
        except Exception as e:
            return False, f"Unexpected error connecting to Jellyfin: {str(e)}"
    
    def get_libraries_raw(self) -> List[Dict[str, Any]]:
        """Get raw, unmodified library data from Jellyfin API"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for raw library retrieval")
                return []
            
            response = self.session.get(
                f"{self.url.rstrip('/')}/Library/VirtualFolders",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            # Return the raw API response without any modifications
            virtual_folders = response.json()
            self.log_info(f"Retrieved {len(virtual_folders)} raw libraries from Jellyfin")
            return virtual_folders
            
        except Exception as e:
            self.log_error(f"Error retrieving raw libraries: {e}")
            return []
    
    def get_libraries(self) -> List[Dict[str, Any]]:
        """Get all libraries from Jellyfin (processed for internal use)"""
        try:
            # Get raw data first
            virtual_folders = self.get_libraries_raw()
            libraries = []
            
            # Process the raw data for internal use
            for folder in virtual_folders:
                # Use Name as external_id for Jellyfin virtual folders since ItemId may not exist
                external_id = folder.get('ItemId') or folder.get('Name', '')
                if not external_id:
                    # Skip libraries without a valid identifier
                    continue
                
                # Get library type for proper count formatting
                library_type = folder.get('CollectionType', 'mixed')
                
                # Get item count for this library (with type-specific formatting)
                item_count = self._get_library_item_count(external_id, library_type)
                    
                libraries.append({
                    'external_id': external_id,
                    'name': folder.get('Name', 'Unknown Library'),
                    'type': library_type,
                    'item_count': item_count,
                    'locations': folder.get('Locations', [])
                })
            
            self.log_info(f"Processed {len(libraries)} libraries from Jellyfin")
            return libraries
            
        except Exception as e:
            self.log_error(f"Error retrieving libraries: {e}")
            return []
    
    def _get_library_item_count(self, library_id: str, library_type: str = None) -> str:
        """Get the item count for a specific Jellyfin library with proper formatting for TV shows"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for library item count")
                return "0"
            
            # For TV show libraries, get both series and episode counts
            if library_type == 'tvshows':
                # Get series count
                series_response = self.session.get(
                    f"{self.url.rstrip('/')}/Items",
                    params={
                        'ParentId': library_id,
                        'IncludeItemTypes': 'Series',
                        'Limit': 0
                    },
                    timeout=get_api_timeout_with_fallback(10)
                )
                series_response.raise_for_status()
                series_data = series_response.json()
                series_count = series_data.get('TotalRecordCount', 0)
                
                # Get episode count
                episode_response = self.session.get(
                    f"{self.url.rstrip('/')}/Items",
                    params={
                        'ParentId': library_id,
                        'IncludeItemTypes': 'Episode',
                        'Recursive': 'true',
                        'Limit': 0
                    },
                    timeout=get_api_timeout_with_fallback(10)
                )
                episode_response.raise_for_status()
                episode_data = episode_response.json()
                episode_count = episode_data.get('TotalRecordCount', 0)
                
                # Format as "seriesCount (episodeCountep)"
                formatted_count = f"{series_count} ({episode_count}ep)"
                self.log_info(f"TV Library {library_id} has {series_count} series and {episode_count} episodes")
                return formatted_count
            else:
                # For other library types, use the original logic
                response = self.session.get(
                    f"{self.url.rstrip('/')}/Items",
                    params={
                        'ParentId': library_id,
                        'Recursive': 'true',
                        'Limit': 0
                    },
                    timeout=get_api_timeout_with_fallback(10)
                )
                response.raise_for_status()
                
                data = response.json()
                item_count = data.get('TotalRecordCount', 0)
                
                self.log_info(f"Library {library_id} has {item_count} items")
                return str(item_count)
            
        except Exception as e:
            self.log_error(f"Error getting item count for library {library_id}: {e}")
            return "0"
    
    def get_users(self) -> List[Dict[str, Any]]:
        """Get all users from Jellyfin"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for user retrieval")
                return []
            
            response = self.session.get(
                f"{self.url.rstrip('/')}/Users",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            users_data = response.json()
            users = []
            
            for user in users_data:
                policy = user.get('Policy', {})
                
                # Determine library access
                library_ids = []
                if policy.get('EnableAllFolders', False):
                    library_ids = ['*']  # All libraries access
                else:
                    library_ids = policy.get('EnabledFolders', [])
                
                users.append({
                    'id': user.get('Id', ''),
                    'username': user.get('Name', ''),
                    'email': user.get('Email', ''),
                    'is_admin': policy.get('IsAdministrator', False),
                    'is_disabled': policy.get('IsDisabled', False),
                    'is_hidden': policy.get('IsHidden', False),
                    'library_ids': library_ids,
                    'last_login_date': user.get('LastLoginDate', ''),
                    'last_activity_date': user.get('LastActivityDate', ''),
                    'raw_data': user  # Include the complete raw user data from Jellyfin API
                })
            
            self.log_info(f"Retrieved {len(users)} users from Jellyfin")
            return users
            
        except Exception as e:
            self.log_error(f"Error retrieving users: {e}")
            return []
    
    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        """Create a new user in Jellyfin"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for user creation")
                return {}
            
            user_data = {
                'Name': username,
                'Email': email or '',
                'Password': password or ''
            }
            
            response = self.session.post(
                f"{self.url.rstrip('/')}/Users/New",
                json=user_data,
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            created_user = response.json()
            self.log_info(f"Created user '{username}' in Jellyfin")
            
            return {
                'id': created_user.get('Id', ''),
                'username': created_user.get('Name', ''),
                'email': created_user.get('Email', ''),
                'success': True
            }
            
        except Exception as e:
            self.log_error(f"Error creating user '{username}': {e}")
            return {}
    
    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        """Update user's library access in Jellyfin"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for user access update")
                return False
            
            if library_ids is not None:
                # Get current user data
                response = self.session.get(
                    f"{self.url.rstrip('/')}/Users/{user_id}",
                    timeout=get_api_timeout_with_fallback(10)
                )
                response.raise_for_status()
                
                user_data = response.json()
                current_policy = user_data.get('Policy', {})
                
                # Update library access
                if library_ids == ['*']:
                    current_policy['EnabledFolders'] = []
                    current_policy['EnableAllFolders'] = True
                    self.log_info(f"Setting user {user_id} to have access to ALL libraries")
                else:
                    current_policy['EnabledFolders'] = library_ids
                    current_policy['EnableAllFolders'] = False
                    self.log_info(f"Setting user {user_id} to have access to specific libraries: {library_ids}")
                
                # Update user policy
                policy_response = self.session.post(
                    f"{self.url.rstrip('/')}/Users/{user_id}/Policy",
                    json=current_policy,
                    timeout=get_api_timeout_with_fallback(10)
                )
                policy_response.raise_for_status()
                
                self.log_info(f"Successfully updated Jellyfin user {user_id} library access")
            
            return True
            
        except Exception as e:
            self.log_error(f"Error updating user access for {user_id}: {e}")
            return False
    
    def delete_user(self, user_id: str) -> bool:
        """Delete/remove user from Jellyfin"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for user deletion")
                return False
            
            response = self.session.delete(
                f"{self.url.rstrip('/')}/Users/{user_id}",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            self.log_info(f"Deleted user {user_id} from Jellyfin")
            return True
            
        except Exception as e:
            self.log_error(f"Error deleting user {user_id}: {e}")
            return False
    
    def check_username_exists(self, username: str) -> bool:
        """Check if a username already exists in Jellyfin"""
        try:
            users = self.get_users()
            for user in users:
                if user.get('Name', '').lower() == username.lower():
                    return True
            return False
        except Exception as e:
            self.log_error(f"Error checking username '{username}': {e}")
            return False  # Assume username doesn't exist if we can't check
    
    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get currently active sessions from Jellyfin"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for session retrieval")
                return []
            
            response = self.session.get(
                f"{self.url.rstrip('/')}/Sessions",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            sessions = response.json()
            
            # Filter to only active sessions (those with NowPlayingItem)
            active_sessions = []
            for session in sessions:
                if session.get('NowPlayingItem'):
                    active_sessions.append(session)
            
            self.log_info(f"Retrieved {len(active_sessions)} active sessions from Jellyfin")
            return active_sessions
            
        except Exception as e:
            self.log_error(f"Error retrieving active sessions: {e}")
            return []
    
    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        """Terminate an active session"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for session termination")
                return False
            
            data = {'Reason': reason or 'Terminated by administrator'}
            response = self.session.post(
                f"{self.url.rstrip('/')}/Sessions/{session_id}/Playing/Stop",
                json=data,
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            self.log_info(f"Terminated session {session_id}")
            return True
            
        except Exception as e:
            self.log_error(f"Error terminating session {session_id}: {e}")
            return False
    
    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        """Get active Jellyfin sessions formatted for display"""
        from flask import url_for
        import json
        
        raw_sessions = self.get_active_sessions()
        if not raw_sessions:
            return []
        
        # Get user mapping for Jellyfin users
        jellyfin_usernames = {session.get('UserName') for session in raw_sessions if session.get('UserName')}
        # Get local user via service user for Jellyfin usernames
        if jellyfin_usernames:
            jellyfin_accesses = User.query.filter_by(userType=UserType.SERVICE).filter(
                User.server_id == self.server_id,
                User.external_username.in_(list(jellyfin_usernames))
            ).all()
            # Create mapping of username to linked local user (if exists)
            mum_users_map_by_username = {}
            for access in jellyfin_accesses:
                if access.linkedUserId:
                    linked_user = User.query.filter_by(userType=UserType.LOCAL, uuid=access.linkedUserId).first()
                    if linked_user:
                        mum_users_map_by_username[access.external_username] = linked_user
        else:
            mum_users_map_by_username = {}
        
        formatted_sessions = []
        
        def get_standard_resolution(height_str):
            if not height_str: return "SD"
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
            except (ValueError, TypeError):
                return "SD"
        
        for raw_session in raw_sessions:
            try:
                # Basic session info
                user_name = raw_session.get('UserName', 'Unknown User')
                now_playing = raw_session.get('NowPlayingItem', {})
                play_state = raw_session.get('PlayState', {})
                
                player_title = raw_session.get('DeviceName', 'Unknown Device')
                player_platform = raw_session.get('Client', '')
                product = raw_session.get('ApplicationVersion', 'N/A')
                media_title = now_playing.get('Name', "Unknown Title")
                media_type = now_playing.get('Type', 'unknown').capitalize()
                year = now_playing.get('ProductionYear', None)
                library_name = "Library"  # Generic library name for Jellyfin
                
                # Calculate progress for Jellyfin
                position_ticks = play_state.get('PositionTicks', 0)
                runtime_ticks = now_playing.get('RunTimeTicks', 0)
                progress = (position_ticks / runtime_ticks) * 100 if runtime_ticks else 0
                
                # Handle Jellyfin thumbnails
                thumb_url = None
                item_id = now_playing.get('Id')
                series_image_tag = now_playing.get('SeriesPrimaryImageTag') or (now_playing.get('ImageTags') or {}).get('SeriesPrimary')
                primary_image_tag = now_playing.get('PrimaryImageTag') or (now_playing.get('ImageTags') or {}).get('Primary')

                if item_id:
                    # For episodes, prefer series poster; for movies, use primary image
                    if media_type == 'Episode' and now_playing.get('SeriesId'):
                        params = {'item_id': now_playing.get('SeriesId'), 'image_type': 'Primary'}
                        if series_image_tag:
                            params['image_tag'] = series_image_tag
                        thumb_url = url_for('api_v2.jellyfin_image_proxy_v2', **params)
                    else:
                        params = {'item_id': item_id, 'image_type': 'Primary'}
                        if primary_image_tag:
                            params['image_tag'] = primary_image_tag
                        thumb_url = url_for('api_v2.jellyfin_image_proxy_v2', **params)
                
                is_transcoding = play_state.get('PlayMethod') == 'Transcode'
                
                location_ip = raw_session.get('RemoteEndPoint', 'N/A')
                is_local = raw_session.get('IsLocal', True)  # Jellyfin's IsLocal field
                location_lan_wan = "LAN" if is_local else "WAN"
                
                # Find MUM user by username for Jellyfin
                mum_user = mum_users_map_by_username.get(user_name)
                mum_user_id = mum_user.id if mum_user else None
                session_key = raw_session.get('Id', '')
                
                # Generate Jellyfin user avatar URL if available
                user_avatar_url = None
                jellyfin_user_id = raw_session.get('UserId')
                if jellyfin_user_id:
                    try:
                        # Check if user has an avatar before generating URL
                        user_info = self._get_user_info(jellyfin_user_id)
                        if user_info and user_info.get('PrimaryImageTag'):
                            user_avatar_url = url_for('api_v2.jellyfin_user_avatar_proxy_v2', user_id=jellyfin_user_id)
                    except Exception:
                        user_avatar_url = None
                
                # Initialize details
                quality_detail = ""
                stream_details = ""
                video_detail = ""
                audio_detail = ""
                subtitle_detail = "None"
                container_detail = ""
                
                # Handle session details for Jellyfin
                transcoding_info = raw_session.get('TranscodingInfo', {})
                media_streams = now_playing.get('MediaStreams', [])
                
                # Find original video and audio streams
                original_video_stream = next((s for s in media_streams if s.get('Type') == 'Video'), None)
                original_audio_stream = next((s for s in media_streams if s.get('Type') == 'Audio' and s.get('IsDefault', False)), None)
                
                if is_transcoding and transcoding_info:
                    # Enhanced Jellyfin transcode details
                    hardware_accel = transcoding_info.get('HardwareAccelerationType', 'none')
                    if hardware_accel and hardware_accel != 'none':
                        stream_details = f"Transcode (HW: {hardware_accel.upper()})"
                    else:
                        stream_details = "Transcode"
                    
                    # Container details
                    original_container = now_playing.get('Container', 'Unknown').upper()
                    transcoded_container = transcoding_info.get('Container', 'Unknown').upper()
                    if original_container != transcoded_container:
                        container_detail = f"Converting ({original_container} -> {transcoded_container})"
                    else:
                        container_detail = f"Container: {transcoded_container}"
                    
                    # Video details
                    is_video_direct = transcoding_info.get('IsVideoDirect', False)
                    if is_video_direct and original_video_stream:
                        # Video is direct stream
                        original_height = original_video_stream.get('Height', 0)
                        original_res = get_standard_resolution(original_height)
                        original_codec = original_video_stream.get('Codec', 'Unknown').upper()
                        video_detail = f"Direct Stream ({original_codec} {original_res})"
                    else:
                        # Video is being transcoded
                        original_height = original_video_stream.get('Height', 0) if original_video_stream else 0
                        original_res = get_standard_resolution(original_height)
                        original_codec = original_video_stream.get('Codec', 'Unknown').upper() if original_video_stream else 'Unknown'
                        
                        transcoded_height = transcoding_info.get('Height', 0)
                        transcoded_res = get_standard_resolution(transcoded_height)
                        transcoded_codec = transcoding_info.get('VideoCodec', 'Unknown').upper()
                        
                        if original_video_stream:
                            video_detail = f"Transcode ({original_codec} {original_res} -> {transcoded_codec} {transcoded_res})"
                        else:
                            video_detail = f"Transcode (-> {transcoded_codec} {transcoded_res})"
                    
                    # Audio details
                    is_audio_direct = transcoding_info.get('IsAudioDirect', False)
                    if is_audio_direct and original_audio_stream:
                        # Audio is direct stream
                        audio_display = original_audio_stream.get('DisplayTitle', 'Unknown Audio')
                        audio_detail = f"Direct Stream ({audio_display})"
                    else:
                        # Audio is being transcoded
                        original_audio_display = original_audio_stream.get('DisplayTitle', 'Unknown Audio') if original_audio_stream else 'Unknown Audio'
                        transcoded_codec = transcoding_info.get('AudioCodec', 'Unknown').upper()
                        transcoded_channels = transcoding_info.get('AudioChannels', 0)
                        
                        # Map channel count to layout
                        channel_layout_map = {1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1"}
                        transcoded_layout = channel_layout_map.get(transcoded_channels, f"{transcoded_channels}ch")
                        transcoded_audio_display = f"{transcoded_codec} {transcoded_layout}"
                        
                        if original_audio_stream:
                            audio_detail = f"Transcode ({original_audio_display} -> {transcoded_audio_display})"
                        else:
                            audio_detail = f"Transcode (-> {transcoded_audio_display})"
                    
                    # Quality details with bitrate
                    transcoded_height = transcoding_info.get('Height', 0)
                    transcoded_res = get_standard_resolution(transcoded_height)
                    transcoded_bitrate = transcoding_info.get('Bitrate', 0)
                    if transcoded_bitrate > 0:
                        bitrate_mbps = transcoded_bitrate / 1000000  # Convert from bps to Mbps
                        quality_detail = f"{transcoded_res} ({bitrate_mbps:.1f} Mbps)"
                    else:
                        quality_detail = f"{transcoded_res} (Transcoding)"
                        
                else:
                    # Direct Play for Jellyfin
                    stream_details = "Direct Play"
                    container_detail = now_playing.get('Container', 'Unknown').upper()
                    
                    if original_video_stream:
                        original_height = original_video_stream.get('Height', 0)
                        original_res = get_standard_resolution(original_height)
                        original_codec = original_video_stream.get('Codec', 'Unknown').upper()
                        video_detail = f"Direct Play ({original_codec} {original_res})"
                    else:
                        video_detail = "Direct Play (Unknown Video)"
                    
                    if original_audio_stream:
                        audio_display = original_audio_stream.get('DisplayTitle', 'Unknown Audio')
                        audio_detail = f"Direct Play ({audio_display})"
                    else:
                        audio_detail = "Direct Play (Unknown Audio)"
                    
                    # Quality for direct play
                    if original_video_stream:
                        original_height = original_video_stream.get('Height', 0)
                        original_res = get_standard_resolution(original_height)
                        original_bitrate = original_video_stream.get('BitRate', 0)
                        if original_bitrate > 0:
                            bitrate_mbps = original_bitrate / 1000000  # Convert from bps to Mbps
                            quality_detail = f"Original ({original_res}, {bitrate_mbps:.1f} Mbps)"
                        else:
                            quality_detail = f"Original ({original_res})"
                    else:
                        quality_detail = "Direct Play"

                # Raw data for modal (Jellyfin sessions are already dict format)
                raw_json_string = json.dumps(raw_session, indent=2)

                # Additional details
                grandparent_title = now_playing.get('SeriesName', None)
                parent_title = now_playing.get('SeasonName', None)
                player_state = 'Playing' if not play_state.get('IsPaused', False) else 'Paused'
                
                # Enhanced Jellyfin bitrate calculation for display
                if transcoding_info and transcoding_info.get('Bitrate'):
                    bitrate_calc = transcoding_info.get('Bitrate', 0) / 1000  # Convert from bps to kbps for consistency with Plex
                elif original_video_stream and original_video_stream.get('BitRate'):
                    bitrate_calc = original_video_stream.get('BitRate', 0) / 1000  # Convert from bps to kbps
                else:
                    bitrate_calc = 0

                session_details = {
                    'user': user_name,
                    'mum_user_id': mum_user_id,
                    'player_title': player_title,
                    'player_platform': player_platform,
                    'product': product,
                    'media_title': media_title,
                    'grandparent_title': grandparent_title,
                    'parent_title': parent_title,
                    'media_type': media_type,
                    'library_name': library_name,
                    'year': year,
                    'state': player_state,
                    'progress': round(progress, 1),
                    'thumb_url': thumb_url,
                    'session_key': session_key,
                    'user_avatar_url': user_avatar_url,
                    'quality_detail': quality_detail,
                    'stream_detail': stream_details,
                    'container_detail': container_detail,
                    'video_detail': video_detail,
                    'audio_detail': audio_detail,
                    'subtitle_detail': subtitle_detail,
                    'location_detail': f"{location_lan_wan}: {location_ip}",
                    'is_public_ip': not is_local,
                    'location_ip': location_ip,
                    'bandwidth_detail': f"Streaming via {location_lan_wan}",
                    'bitrate_calc': bitrate_calc,
                    'location_type_calc': location_lan_wan,
                    'is_transcode_calc': is_transcoding,
                    'raw_data_json': raw_json_string,
                    'raw_data_json_lines': raw_json_string.splitlines(),
                    'service_type': 'jellyfin',
                    'server_name': self.name
                }
                formatted_sessions.append(session_details)
                
            except Exception as e:
                self.log_error(f"Error formatting Jellyfin session: {e}")
                continue
        
        return formatted_sessions
    
    def get_server_info(self) -> Dict[str, Any]:
        """Get Jellyfin server information"""
        try:
            if not self._authenticated and not self._authenticate():
                return {
                    'name': self.name,
                    'url': self.url,
                    'service_type': 'jellyfin',
                    'online': False,
                    'version': 'Unknown'
                }
            
            response = self.session.get(
                f"{self.url.rstrip('/')}/System/Info",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            server_info = response.json()
            
            return {
                'name': self.name,
                'url': self.url,
                'service_type': 'jellyfin',
                'online': True,
                'version': server_info.get('Version', 'Unknown'),
                'server_name': server_info.get('ServerName', self.name),
                'server_id': server_info.get('Id', ''),
                'operating_system': server_info.get('OperatingSystem', 'Unknown')
            }
            
        except Exception as e:
            self.log_error(f"Error getting server info: {e}")
            return {
                'name': self.name,
                'url': self.url,
                'service_type': 'jellyfin',
                'online': False,
                'version': 'Unknown'
            }
    
    def supports_feature(self, feature: str) -> bool:
        """Check if Jellyfin supports a specific feature"""
        jellyfin_features = [
            'user_management',
            'library_access',
            'active_sessions',
            'session_termination',
            'downloads',
            'transcoding'
        ]
        
        return feature in jellyfin_features
    
    def get_library_content(self, library_key: str, page: int = 1, per_page: int = 24) -> Dict[str, Any]:
        """Get content from a specific Jellyfin library using /Items API"""
        try:
            # Calculate pagination parameters for Jellyfin API
            start_index = (page - 1) * per_page
            
            # Construct the API URL
            url = f"{self.url.rstrip('/')}/Items"
            
            # Set up parameters for the request
            params = {
                'ParentId': library_key,
                'Recursive': 'true',
                'StartIndex': start_index,
                'Limit': per_page,
                'Fields': 'BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear,Status,EndDate',
                'SortBy': 'SortName',
                'SortOrder': 'Ascending'
            }
            
            # Add filtering based on library type to prevent getting episodes/seasons for TV libraries
            try:
                library_info = self._get_library_info(library_key)
                if library_info and library_info.get('CollectionType') == 'tvshows':
                    # For TV libraries, only get Series (shows), not episodes or seasons
                    params['IncludeItemTypes'] = 'Series'
                    current_app.logger.debug(f"Jellyfin: Filtering TV library to Series only")
                elif library_info and library_info.get('CollectionType') == 'movies':
                    # For movie libraries, only get Movies
                    params['IncludeItemTypes'] = 'Movie'
                    current_app.logger.debug(f"Jellyfin: Filtering movie library to Movies only")
                elif library_info and library_info.get('CollectionType') == 'music':
                    # For music libraries, only get Albums
                    params['IncludeItemTypes'] = 'MusicAlbum'
                    current_app.logger.debug(f"Jellyfin: Filtering music library to Albums only")
            except Exception as e:
                current_app.logger.warning(f"Could not determine library type for filtering: {e}")
                # Continue without filtering if we can't determine library type
            
            # Set up headers
            headers = {
                'X-Emby-Token': self.api_key,
                'Content-Type': 'application/json'
            }
            
            current_app.logger.debug(f"Jellyfin get_library_content: Fetching from {url} with ParentId={library_key}")
            
            # Make the API request with shorter timeout to prevent worker timeouts
            try:
                response = requests.get(url, params=params, headers=headers, timeout=5)
                response.raise_for_status()
            except requests.exceptions.Timeout:
                current_app.logger.warning(f"Jellyfin API timeout for library {library_key}, page {page}")
                # Return partial results to prevent complete failure
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': 'Request timeout - try reducing items per page'
                }
            except requests.exceptions.RequestException as e:
                current_app.logger.error(f"Jellyfin API error for library {library_key}: {e}")
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': f'API error: {str(e)}'
                }
            
            data = response.json()
            items = data.get('Items', [])
            total_record_count = data.get('TotalRecordCount', 0)
            
            current_app.logger.debug(f"Jellyfin get_library_content: Retrieved {len(items)} items, total: {total_record_count}")
            
            # Process items for consistent format
            processed_items = []
            for item in items:
                try:
                    # Get thumbnail URL using proxy method (manually construct to avoid url_for issues)
                    thumb_url = None
                    if item.get('Id'):
                        # Manually construct relative URL to avoid url_for issues with external hosts
                        thumb_url = f"/admin/api/v2/media/jellyfin/images/proxy?item_id={item['Id']}&image_type=Primary"
                        #current_app.logger.debug(f"Generated Jellyfin thumb URL: {thumb_url}")
                    
                    # Extract year from PremiereDate
                    year = None
                    if item.get('PremiereDate'):
                        try:
                            year = int(item['PremiereDate'][:4])
                        except (ValueError, TypeError):
                            pass
                    elif item.get('ProductionYear'):
                        year = item['ProductionYear']
                    
                    processed_item = {
                        'id': item.get('Id', ''),
                        'title': item.get('Name', 'Unknown Title'),
                        'year': year,
                        'thumb': thumb_url,
                        'type': item.get('Type', '').lower(),
                        'summary': item.get('Overview', ''),
                        'rating': item.get('CommunityRating'),
                        'duration': item.get('RunTimeTicks'),  # Jellyfin uses ticks
                        'added_at': item.get('DateCreated'),
                        'raw_data': item
                    }
                    
                    processed_items.append(processed_item)
                    
                except Exception as e:
                    current_app.logger.warning(f"Error processing Jellyfin item {item.get('Id', 'unknown')}: {e}")
                    continue
            
            # Calculate pagination info
            total_pages = (total_record_count + per_page - 1) // per_page
            
            return {
                'items': processed_items,
                'total': total_record_count,
                'page': page,
                'per_page': per_page,
                'pages': total_pages,
                'has_prev': page > 1,
                'has_next': page < total_pages
            }
            
        except requests.exceptions.RequestException as e:
            current_app.logger.error(f"Jellyfin API error getting library content: {e}")
            return {
                'items': [],
                'total': 0,
                'page': page,
                'per_page': per_page,
                'pages': 0,
                'has_prev': False,
                'has_next': False,
                'error': f'Failed to connect to Jellyfin server: {str(e)}'
            }
        except Exception as e:
            current_app.logger.error(f"Error getting Jellyfin library content: {e}")
            return {
                'items': [],
                'total': 0,
                'page': page,
                'per_page': per_page,
                'pages': 0,
                'has_prev': False,
                'has_next': False,
                'error': str(e)
            }

    def _get_library_info(self, library_key: str) -> Dict[str, Any]:
        """Get library information including CollectionType for filtering"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for library info retrieval")
                return {}
            
            # Get library info from VirtualFolders endpoint
            response = self.session.get(
                f"{self.url.rstrip('/')}/Library/VirtualFolders",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            virtual_folders = response.json()
            
            # Find the library with matching ItemId or Name
            for folder in virtual_folders:
                folder_id = folder.get('ItemId') or folder.get('Name', '')
                if folder_id == library_key:
                    return folder
            
            # If not found by ItemId/Name, try to get library details directly
            try:
                response = self.session.get(
                    f"{self.url.rstrip('/')}/Items/{library_key}",
                    timeout=get_api_timeout_with_fallback(10)
                )
                response.raise_for_status()
                item_info = response.json()
                
                # For direct item lookup, we need to infer CollectionType from the item's Type
                item_type = item_info.get('Type', '').lower()
                if item_type == 'collectionfolder':
                    # This is a collection folder, get its CollectionType
                    return {
                        'CollectionType': item_info.get('CollectionType', 'mixed'),
                        'Name': item_info.get('Name', 'Unknown Library'),
                        'ItemId': library_key
                    }
            except Exception:
                pass
            
            self.log_warning(f"Could not find library info for key: {library_key}")
            return {}
            
        except Exception as e:
            self.log_error(f"Error getting library info for {library_key}: {e}")
            return {}

    def _get_user_info(self, user_id: str) -> Dict[str, Any]:
        """Get user information for avatar and other details"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for user info retrieval")
                return {}
            
            response = self.session.get(
                f"{self.url.rstrip('/')}/Users/{user_id}",
                timeout=get_api_timeout_with_fallback(10)
            )
            response.raise_for_status()
            
            return response.json()
            
        except Exception as e:
            self.log_error(f"Error getting user info for {user_id}: {e}")
            return {}

    def get_show_episodes(self, show_id: str, page: int = 1, per_page: int = 1000) -> Dict[str, Any]:
        """Get episodes for a specific TV show from Jellyfin"""
        try:
            if not self._authenticated and not self._authenticate():
                self.log_error("Failed to authenticate for episode retrieval")
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': 'Authentication failed'
                }

            # Get all episodes for this show using Jellyfin API
            # ParentId is the show's ID, IncludeItemTypes=Episode, Recursive=true
            response = self.session.get(
                f"{self.url.rstrip('/')}/Items",
                params={
                    'ParentId': show_id,
                    'IncludeItemTypes': 'Episode',
                    'Recursive': 'true',
                    'Fields': 'BasicSyncInfo,PrimaryImageAspectRatio,ProductionYear',
                    'SortBy': 'SortName',
                    'SortOrder': 'Ascending'
                },
                timeout=get_api_timeout_with_fallback(30)
            )
            response.raise_for_status()

            data = response.json()
            episodes = data.get('Items', [])
            total_count = len(episodes)

            self.log_info(f"Retrieved {total_count} episodes for show {show_id}")

            # Process episodes to match expected format
            processed_episodes = []
            for episode in episodes:
                try:
                    # Get episode thumbnail URL
                    thumb_url = None
                    if episode.get('Id'):
                        thumb_url = f"/admin/api/v2/media/jellyfin/images/proxy?item_id={episode['Id']}&image_type=Primary"

                    # Extract year from PremiereDate
                    year = None
                    if episode.get('PremiereDate'):
                        try:
                            year = int(episode['PremiereDate'][:4])
                        except (ValueError, TypeError):
                            pass
                    elif episode.get('ProductionYear'):
                        year = episode['ProductionYear']

                    # Get parent show ID for linking
                    parent_id = episode.get('SeriesId', show_id)

                    # Jellyfin provides IndexNumber (episode) and ParentIndexNumber (season)
                    # Store them in raw_data for to_dict() to extract
                    raw_episode_data = episode.copy()
                    raw_episode_data['episodeNumber'] = episode.get('IndexNumber')
                    raw_episode_data['seasonNumber'] = episode.get('ParentIndexNumber')

                    processed_episode = {
                        'id': episode.get('Id', ''),
                        'title': episode.get('Name', 'Unknown Episode'),
                        'year': year,
                        'thumb': thumb_url,
                        'type': 'episode',
                        'item_type': 'episode',
                        'summary': episode.get('Overview', ''),
                        'rating': episode.get('CommunityRating'),
                        'duration': episode.get('RunTimeTicks'),
                        'added_at': episode.get('DateCreated'),
                        'parent_id': parent_id,
                        'raw_data': raw_episode_data
                    }

                    processed_episodes.append(processed_episode)

                except Exception as e:
                    self.log_warning(f"Error processing episode {episode.get('Id', 'unknown')}: {e}")
                    continue

            return {
                'items': processed_episodes,
                'total': total_count,
                'page': page,
                'per_page': per_page,
                'pages': 1,  # All episodes returned in one call
                'has_prev': False,
                'has_next': False
            }

        except requests.exceptions.RequestException as e:
            self.log_error(f"Jellyfin API error getting episodes for show {show_id}: {e}")
            return {
                'items': [],
                'total': 0,
                'page': page,
                'per_page': per_page,
                'pages': 0,
                'has_prev': False,
                'has_next': False,
                'error': f'Failed to connect to Jellyfin server: {str(e)}'
            }
        except Exception as e:
            self.log_error(f"Error getting episodes for show {show_id}: {e}")
            return {
                'items': [],
                'total': 0,
                'page': page,
                'per_page': per_page,
                'pages': 0,
                'has_prev': False,
                'has_next': False,
                'error': str(e)
            }

    def get_geoip_info(self, ip_address: str) -> Dict[str, Any]:
        """Get GeoIP information for a given IP address"""
        # Use the base class implementation
        return super().get_geoip_info(ip_address)
