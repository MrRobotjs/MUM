# File: app/services/base_media_service.py
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
from flask import current_app
from app.models_media_services import ServiceType
import requests

class BaseMediaService(ABC):
    """Abstract base class for all media service implementations"""
    
    def __init__(self, server_config: Dict[str, Any]):
        self.server_config = server_config
        self.server_id = server_config.get('id')
        self.name = server_config.get('name')
        self.url = server_config.get('url')
        self.api_key = server_config.get('api_key')
        self.localUsername = server_config.get('username')
        self.password = server_config.get('password')
        self.config = server_config.get('config', {})
        
    @property
    @abstractmethod
    def service_type(self) -> ServiceType:
        """Return the service type enum"""
        pass
    
    @abstractmethod
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection to the service. Returns (success, message)"""
        pass
    
    @abstractmethod
    def get_libraries(self) -> List[Dict[str, Any]]:
        """Get all libraries from the service"""
        pass
    
    @abstractmethod
    def get_users(self) -> List[Dict[str, Any]]:
        """Get all users from the service"""
        pass
    
    @abstractmethod
    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        """Create a new user in the service"""
        pass
    
    @abstractmethod
    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        """Update user's library access"""
        pass
    
    @abstractmethod
    def delete_user(self, user_id: str) -> bool:
        """Delete/remove user from the service"""
        pass
    
    @abstractmethod
    def check_username_exists(self, username: str) -> bool:
        """Check if a username already exists in the service"""
        pass
    
    @abstractmethod
    def get_active_sessions(self) -> List[Dict[str, Any]]:
        """Get currently active streaming sessions"""
        pass
    
    @abstractmethod
    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        """Terminate an active session"""
        pass

    @abstractmethod
    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        """Get active sessions formatted for display with standardized structure"""
        pass

    @abstractmethod
    def get_geoip_info(self, ip_address: str) -> Dict[str, Any]:
        """Get GeoIP information for a given IP address."""
        pass
    
    def get_server_info(self) -> Dict[str, Any]:
        """Get basic server information. Default implementation."""
        return {
            'name': self.name,
            'url': self.url,
            'service_type': self.service_type.value,
            'online': False,
            'version': 'Unknown'
        }
    
    def supports_feature(self, feature: str) -> bool:
        """Check if service supports a specific feature"""
        # Default features that most services support
        default_features = [
            'user_management',
            'library_access',
            'active_sessions'
        ]
        
        # Service-specific features can be overridden
        service_features = {
            ServiceType.PLEX: default_features + ['downloads', 'transcoding', 'sharing'],
            ServiceType.EMBY: default_features + ['downloads', 'transcoding'],
            ServiceType.JELLYFIN: default_features + ['downloads', 'transcoding'],
            ServiceType.KAVITA: default_features + ['downloads'],
            ServiceType.AUDIOBOOKSHELF: default_features + ['downloads'],
            ServiceType.KOMGA: default_features + ['downloads'],
            ServiceType.ROMM: default_features + ['downloads']
        }
        
        return feature in service_features.get(self.service_type, default_features)
    
    def log_info(self, message: str):
        """Helper method for logging"""
        current_app.logger.debug(f"[{self.service_type.value.upper()}:{self.name}] {message}")
    
    def log_debug(self, message: str):
        """Helper for verbose debug logging."""
        current_app.logger.debug(f"[{self.service_type.value.upper()}:{self.name}] {message}")
    
    def log_error(self, message: str, exc_info: bool = False):
        """Helper method for error logging"""
        current_app.logger.error(f"[{self.service_type.value.upper()}:{self.name}] {message}", exc_info=exc_info)
    
    def log_warning(self, message: str):
        """Helper method for warning logging"""
        current_app.logger.warning(f"[{self.service_type.value.upper()}:{self.name}] {message}")

    def get_geoip_info(self, ip_address: str) -> Dict[str, Any]:
        """Get GeoIP information for a given IP address."""
        if not ip_address or ip_address in ['127.0.0.1', 'localhost']:
            return {"status": "local", "message": "This is a local address."}
        
        try:
            response = requests.get(f"http://ip-api.com/json/{ip_address}")
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            self.log_error(f"Failed to get GeoIP info for {ip_address}: {e}")
            return {"status": "error", "message": str(e)}
