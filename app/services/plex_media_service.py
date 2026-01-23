# File: app/services/plex_media_service.py
import json
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime
from plexapi.server import PlexServer
from plexapi.myplex import MyPlexAccount
from plexapi.exceptions import Unauthorized, NotFound, BadRequest
import requests
import xml.etree.ElementTree as ET
import xmltodict
from flask import current_app
from app.services.base_media_service import BaseMediaService
from app.models_media_services import ServiceType
from app.utils.timeout_helper import get_api_timeout
from app.models import User, UserType, Setting, EventType
from app.utils.helpers import log_event

class PlexMediaService(BaseMediaService):
    """Plex implementation of BaseMediaService"""
    
    @property
    def service_type(self) -> ServiceType:
        return ServiceType.PLEX
    
    def __init__(self, server_config: Dict[str, Any]):
        super().__init__(server_config)
        self._server_instance = None
        self._admin_account = None
        self._last_raw_sessions_payload = None
    
    def _get_server_instance(self, force_reconnect=False):
        """Get PlexServer instance with caching"""
        if not force_reconnect and self._server_instance:
            try:
                _ = self._server_instance.friendlyName
                return self._server_instance
            except:
                self._server_instance = None
        
        try:
            timeout = get_api_timeout()
            session = requests.Session()
            session.timeout = timeout
            self._server_instance = PlexServer(baseurl=self.url, token=self.api_key, session=session)
            return self._server_instance
        except Exception as e:
            self.log_error(f"Failed to connect to Plex server: {e}")
            return None
    
    def _get_admin_account(self):
        """Get MyPlexAccount instance with caching"""
        if not self._admin_account:
            try:
                self._admin_account = MyPlexAccount(token=self.api_key)
            except Exception as e:
                self.log_error(f"Failed to get Plex admin account: {e}")
                return None
        return self._admin_account
    
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection to Plex server"""
        server = self._get_server_instance(force_reconnect=True)
        if server:
            try:
                name = server.friendlyName
                version = server.version
                return True, f"Connected to {name} (v{version})"
            except Exception as e:
                return False, f"Connection failed: {str(e)}"
        return False, "Could not establish connection"
    
    def get_libraries_raw(self) -> List[Dict[str, Any]]:
        """Get raw, unmodified library data from Plex API"""
        server = self._get_server_instance()
        if not server:
            return []
        
        raw_libraries = []
        try:
            for lib in server.library.sections():
                try:
                    # Store raw library data - with safe attribute access
                    raw_lib_data = {
                        'key': getattr(lib, 'key', None),
                        'title': getattr(lib, 'title', None),
                        'type': getattr(lib, 'type', None),
                        'totalSize': getattr(lib, 'totalSize', None),
                        'uuid': getattr(lib, 'uuid', None),
                        'agent': getattr(lib, 'agent', None),
                        'scanner': getattr(lib, 'scanner', None),
                        'language': getattr(lib, 'language', None),
                        'refreshing': getattr(lib, 'refreshing', None),
                        'updatedAt': str(getattr(lib, 'updatedAt', None)) if getattr(lib, 'updatedAt', None) else None,
                        'createdAt': str(getattr(lib, 'createdAt', None)) if getattr(lib, 'createdAt', None) else None,
                        'scannedAt': str(getattr(lib, 'scannedAt', None)) if getattr(lib, 'scannedAt', None) else None,
                        'thumb': getattr(lib, 'thumb', None),
                        'art': getattr(lib, 'art', None),
                        'composite': getattr(lib, 'composite', None),
                        'filters': getattr(lib, 'filters', None),
                        'sorts': getattr(lib, 'sorts', None),
                        'fields': getattr(lib, 'fields', None)
                    }
                    
                    # Safely get locations
                    try:
                        locations = getattr(lib, 'locations', [])
                        raw_lib_data['locations'] = [getattr(loc, 'path', str(loc)) for loc in locations] if locations else []
                    except Exception as loc_error:
                        self.log_warning(f"Error getting locations for library {lib.title}: {loc_error}")
                        raw_lib_data['locations'] = []
                    
                    # Safely get all attributes for complete raw data
                    try:
                        safe_attrs = {}
                        for attr in dir(lib):
                            if not attr.startswith('_'):
                                try:
                                    value = getattr(lib, attr, None)
                                    if not callable(value):
                                        # Convert datetime objects to strings for JSON serialization
                                        if hasattr(value, 'strftime'):
                                            value = str(value)
                                        safe_attrs[attr] = value
                                except Exception:
                                    safe_attrs[attr] = f"<Error accessing {attr}>"
                        raw_lib_data['all_attributes'] = safe_attrs
                    except Exception as attr_error:
                        self.log_warning(f"Error getting attributes for library {lib.title}: {attr_error}")
                        raw_lib_data['all_attributes'] = {}
                    
                    raw_libraries.append(raw_lib_data)
                    
                except Exception as lib_error:
                    self.log_error(f"Error processing raw library {getattr(lib, 'title', 'Unknown')}: {lib_error}")
                    # Add basic library info even if detailed raw_data fails
                    raw_libraries.append({
                        'key': getattr(lib, 'key', 'unknown'),
                        'title': getattr(lib, 'title', 'Unknown Library'),
                        'type': getattr(lib, 'type', 'unknown'),
                        'totalSize': getattr(lib, 'totalSize', 0),
                        'error': f'Could not fetch complete raw data: {str(lib_error)}'
                    })
                    
        except Exception as e:
            self.log_error(f"Error fetching raw libraries: {e}")
        
        return raw_libraries
    
    def get_libraries(self) -> List[Dict[str, Any]]:
        """Get all Plex libraries (processed for internal use)"""
        server = self._get_server_instance()
        if not server:
            return []
        
        libraries = []
        try:
            # Get raw data first
            raw_libraries = self.get_libraries_raw()
            
            for raw_lib_data in raw_libraries:
                try:
                    libraries.append({
                        'id': str(raw_lib_data.get('uuid', 'unknown')),
                        'name': raw_lib_data.get('title', 'Unknown Library'),
                        'type': raw_lib_data.get('type', 'unknown'),
                        'item_count': raw_lib_data.get('totalSize', 0),
                        'external_id': str(raw_lib_data.get('uuid', 'unknown')),
                        'raw_data': raw_lib_data  # Store the complete raw data for backward compatibility
                    })
                    
                except Exception as lib_error:
                    self.log_error(f"Error processing library {raw_lib_data.get('title', 'Unknown')}: {lib_error}")
                    # Add basic library info even if processing fails
                    libraries.append({
                        'id': str(raw_lib_data.get('uuid', 'unknown')),
                        'name': raw_lib_data.get('title', 'Unknown Library'),
                        'type': raw_lib_data.get('type', 'unknown'),
                        'item_count': raw_lib_data.get('totalSize', 0),
                        'external_id': str(raw_lib_data.get('uuid', 'unknown')),
                        'raw_data': {'error': f'Could not process library: {str(lib_error)}'}
                    })
                    
        except Exception as e:
            self.log_error(f"Error fetching libraries: {e}")
        
        return libraries
    
    def get_library_collections(self, library_id: str) -> Dict[str, Any]:
        """Get collections for a specific Plex library"""
        server = self._get_server_instance()
        if not server:
            return {'success': False, 'error': 'Could not connect to Plex server', 'collections': []}
        
        try:
            # Find the library by UUID or key
            library_section = None
            for lib in server.library.sections():
                if (hasattr(lib, 'uuid') and str(lib.uuid) == str(library_id)) or \
                   (hasattr(lib, 'key') and str(lib.key) == str(library_id)):
                    library_section = lib
                    break
            
            if not library_section:
                return {'success': False, 'error': f'Library with ID {library_id} not found', 'collections': []}
            
            # Get collections from the library
            collections = []
            try:
                # Use the collections() method if available
                if hasattr(library_section, 'collections'):
                    for collection in library_section.collections():
                        try:
                            collections.append({
                                'key': getattr(collection, 'key', None),
                                'title': getattr(collection, 'title', 'Unknown Collection'),
                                'summary': getattr(collection, 'summary', ''),
                                'thumb': getattr(collection, 'thumb', None),
                                'art': getattr(collection, 'art', None),
                                'childCount': getattr(collection, 'childCount', 0),
                                'addedAt': str(getattr(collection, 'addedAt', None)) if getattr(collection, 'addedAt', None) else None,
                                'updatedAt': str(getattr(collection, 'updatedAt', None)) if getattr(collection, 'updatedAt', None) else None,
                                'guid': getattr(collection, 'guid', None),
                                'ratingKey': getattr(collection, 'ratingKey', None),
                                'smart': getattr(collection, 'smart', False)
                            })
                        except Exception as e:
                            self.log_warning(f"Error processing collection {getattr(collection, 'title', 'Unknown')}: {e}")
                            continue
                
                # If collections() method doesn't exist, try direct API call
                else:
                    # Use direct API call as fallback
                    collections_url = f"/library/sections/{library_section.key}/collections"
                    collections_data = server.query(collections_url)
                    
                    if collections_data is not None:
                        for collection_elem in collections_data:
                            try:
                                collections.append({
                                    'key': collection_elem.get('key'),
                                    'title': collection_elem.get('title', 'Unknown Collection'),
                                    'summary': collection_elem.get('summary', ''),
                                    'thumb': collection_elem.get('thumb'),
                                    'art': collection_elem.get('art'),
                                    'childCount': int(collection_elem.get('childCount', 0)),
                                    'addedAt': collection_elem.get('addedAt'),
                                    'updatedAt': collection_elem.get('updatedAt'),
                                    'guid': collection_elem.get('guid'),
                                    'ratingKey': collection_elem.get('ratingKey'),
                                    'smart': collection_elem.get('smart', '0') == '1'
                                })
                            except Exception as e:
                                self.log_warning(f"Error processing collection element: {e}")
                                continue
                
            except Exception as e:
                self.log_error(f"Error fetching collections for library {library_id}: {e}")
                return {'success': False, 'error': f'Error fetching collections: {str(e)}', 'collections': []}
            
            return {
                'success': True,
                'collections': collections,
                'library_name': getattr(library_section, 'title', 'Unknown Library'),
                'library_type': getattr(library_section, 'type', 'unknown')
            }
            
        except Exception as e:
            self.log_error(f"Error in get_library_collections: {e}")
            return {'success': False, 'error': str(e), 'collections': []}
    
    def _legacy_get_libraries_with_raw_data(self) -> List[Dict[str, Any]]:
        """Legacy method - kept for reference but not used"""
        server = self._get_server_instance()
        if not server:
            return []
        
        libraries = []
        try:
            for lib in server.library.sections():
                try:
                    # Store raw library data for the info modal - with safe attribute access
                    raw_lib_data = {
                        'key': getattr(lib, 'key', None),
                        'title': getattr(lib, 'title', None),
                        'type': getattr(lib, 'type', None),
                        'totalSize': getattr(lib, 'totalSize', None),
                        'uuid': getattr(lib, 'uuid', None),
                        'agent': getattr(lib, 'agent', None),
                        'scanner': getattr(lib, 'scanner', None),
                        'language': getattr(lib, 'language', None),
                        'refreshing': getattr(lib, 'refreshing', None),
                        'updatedAt': str(getattr(lib, 'updatedAt', None)) if getattr(lib, 'updatedAt', None) else None,
                        'createdAt': str(getattr(lib, 'createdAt', None)) if getattr(lib, 'createdAt', None) else None,
                        'scannedAt': str(getattr(lib, 'scannedAt', None)) if getattr(lib, 'scannedAt', None) else None,
                        'thumb': getattr(lib, 'thumb', None),
                        'art': getattr(lib, 'art', None),
                        'composite': getattr(lib, 'composite', None),
                        'filters': getattr(lib, 'filters', None),
                        'sorts': getattr(lib, 'sorts', None),
                        'fields': getattr(lib, 'fields', None)
                    }
                    
                    # Safely get locations
                    try:
                        locations = getattr(lib, 'locations', [])
                        raw_lib_data['locations'] = [getattr(loc, 'path', str(loc)) for loc in locations] if locations else []
                    except Exception as loc_error:
                        self.log_warning(f"Error getting locations for library {lib.title}: {loc_error}")
                        raw_lib_data['locations'] = []
                    
                    # Safely get all attributes
                    try:
                        safe_attrs = {}
                        for attr in dir(lib):
                            if not attr.startswith('_'):
                                try:
                                    value = getattr(lib, attr, None)
                                    if not callable(value):
                                        # Convert datetime objects to strings for JSON serialization
                                        if hasattr(value, 'strftime'):
                                            value = str(value)
                                        safe_attrs[attr] = value
                                except Exception:
                                    safe_attrs[attr] = f"<Error accessing {attr}>"
                        raw_lib_data['all_attributes'] = safe_attrs
                    except Exception as attr_error:
                        self.log_warning(f"Error getting attributes for library {lib.title}: {attr_error}")
                        raw_lib_data['all_attributes'] = {}
                    
                    libraries.append({
                        'id': str(lib.key),
                        'name': lib.title,
                        'type': lib.type,
                        'item_count': lib.totalSize,
                        'external_id': str(lib.key),
                        'raw_data': raw_lib_data  # Store the complete Plex library data for the info modal
                    })
                    
                except Exception as lib_error:
                    self.log_error(f"Error processing individual library {getattr(lib, 'title', 'Unknown')}: {lib_error}")
                    # Add basic library info even if raw_data fails
                    libraries.append({
                        'id': str(getattr(lib, 'key', 'unknown')),
                        'name': getattr(lib, 'title', 'Unknown Library'),
                        'type': getattr(lib, 'type', 'unknown'),
                        'item_count': getattr(lib, 'totalSize', 0),
                        'external_id': str(getattr(lib, 'key', 'unknown')),
                        'raw_data': {'error': f'Could not fetch raw data: {str(lib_error)}'}
                    })
                    
        except Exception as e:
            self.log_error(f"Error fetching libraries: {e}")
        
        return libraries
    
    def _get_user_ids_sharing_servers_with_admin(self):
        admin_account = self._get_admin_account()
        if not admin_account: return set()
        owner_ids_sharing_with_admin = set()
        
        try:
            # Method 1: Check admin's resources for servers shared with admin
            resources = admin_account.resources()
            self.log_info(f"DEBUG: Found {len(resources)} total resources from admin account")
            
            for resource in resources:
                product = getattr(resource, 'product', 'Unknown')
                owned = getattr(resource, 'owned', True)
                name = getattr(resource, 'name', 'Unknown')
                owner_id = getattr(resource, 'ownerId', None)
                
                self.log_info(f"DEBUG: Resource '{name}' - Product: {product}, Owned: {owned}, OwnerID: {owner_id}")
                
                if resource.product == "Plex Media Server" and getattr(resource, 'owned', True) is False:
                    owner_id_str = getattr(resource, 'ownerId', None)
                    if owner_id_str:
                        try: 
                            owner_ids_sharing_with_admin.add(int(owner_id_str))
                            self.log_info(f"DEBUG: Added sharing user ID from resources: {owner_id_str}")
                        except ValueError: 
                            self.log_warning(f"Invalid ownerId '{owner_id_str}' for resource '{resource.name}'.")
            
            # Method 2: Also check each user's server list for servers they own but share with admin
            # This is a backup method in case the resources() method doesn't show all shared servers
            try:
                all_users = admin_account.users()
                self.log_info(f"DEBUG: Checking {len(all_users)} users for servers they own and share")
                
                for user in all_users:
                    user_id = getattr(user, 'id', None)
                    if not user_id:
                        continue
                        
                    user_servers = getattr(user, 'servers', [])
                    for server in user_servers:
                        server_name = getattr(server, 'name', 'Unknown')
                        server_owned = getattr(server, 'owned', True)
                        
                        # If user has a server they own (owned=True in their list), 
                        # it means they own it and are potentially sharing it
                        # We need to cross-reference with admin's resources to confirm sharing
                        if server_owned:
                            self.log_info(f"DEBUG: User {user_id} owns server '{server_name}' - checking if shared with admin")
                            # This user owns a server, check if it appears in admin's resources as not owned
                            for resource in resources:
                                if (getattr(resource, 'name', '') == server_name and 
                                    getattr(resource, 'owned', True) is False):
                                    owner_ids_sharing_with_admin.add(user_id)
                                    self.log_info(f"DEBUG: Confirmed user {user_id} shares server '{server_name}' with admin")
                                    break
                                    
            except Exception as e_users:
                self.log_warning(f"DEBUG: Error in user-based sharing detection: {e_users}")
            
            self.log_info(f"Found {len(owner_ids_sharing_with_admin)} users sharing their servers with admin: {list(owner_ids_sharing_with_admin)}")
        except Exception as e:
            self.log_error(f"Error fetching resources shared with admin: {e}")
        return owner_ids_sharing_with_admin

    def get_users(self, users_sharing_back_ids=None) -> List[Dict[str, Any]]:
        if users_sharing_back_ids is None:
            users_sharing_back_ids = self._get_user_ids_sharing_servers_with_admin()

        admin_account = self._get_admin_account() 
        plex_server = self._get_server_instance()   

        if not admin_account:
            self.log_error("get_users(): Admin MyPlexAccount connection failed.")
            return []
        if not plex_server:
            self.log_error("get_users(): PlexServer instance connection failed.")
            return []
            
        server_machine_id = plex_server.machineIdentifier
        admin_plex_id = getattr(admin_account, 'id', None)
        
        all_my_server_library_ids_as_strings = []
        try:
            # Use UUIDs instead of keys for library IDs
            all_my_server_library_ids_as_strings = [str(lib_section.uuid) for lib_section in plex_server.library.sections() if hasattr(lib_section, 'uuid') and lib_section.uuid]
            self.log_info(f"get_users(): All available library UUIDs on this server: {all_my_server_library_ids_as_strings}")
        except Exception as e_all_libs:
            self.log_error(f"get_users(): Could not fetch all library UUIDs from server: {e_all_libs}.")

        detailed_shares_by_userid = {} 
        try:
            if hasattr(admin_account, '_session') and admin_account._session is not None and \
            hasattr(admin_account, '_token') and admin_account._token is not None:
                base_plextv_url = "https://plex.tv"
                shared_servers_url = f"{base_plextv_url}/api/servers/{server_machine_id}/shared_servers"
                self.log_info(f"get_users(): Fetching detailed shares from: {shared_servers_url}")
                headers = {'X-Plex-Token': admin_account._token, 'Accept': 'application/xml'}
                timeout = get_api_timeout()
                resp = admin_account._session.get(shared_servers_url, headers=headers, timeout=timeout)
                resp.raise_for_status()
                self.log_info(f"get_users(): Raw XML from /shared_servers: {resp.text[:500]}...")
                shared_servers_xml_root = ET.fromstring(resp.content)
                for shared_server_elem in shared_servers_xml_root.findall('SharedServer'):
                    user_id_str = shared_server_elem.get('userID')
                    if not user_id_str:
                        self.log_warning(f"get_users(): Found SharedServer element with no userID.")
                        continue
                    try:
                        user_id_int_key = int(user_id_str)
                    except ValueError:
                        self.log_warning(f"get_users(): Found SharedServer element with non-integer userID: '{user_id_str}'.")
                        continue
                    
                    all_libs = (shared_server_elem.get('allLibraries', "0") == "1")
                    accepted_at_timestamp = shared_server_elem.get('acceptedAt')
                    allow_sync_raw = shared_server_elem.get('allowSync')
                    allow_downloads = str(allow_sync_raw).lower() in ('1', 'true', 'yes')
                    
                    shared_section_keys_for_user = []
                    if not all_libs: 
                        # Create a mapping from keys to UUIDs for conversion
                        key_to_uuid_map = {}
                        try:
                            for lib_section in plex_server.library.sections():
                                if hasattr(lib_section, 'key') and hasattr(lib_section, 'uuid') and lib_section.uuid:
                                    key_to_uuid_map[str(lib_section.key)] = str(lib_section.uuid)
                        except Exception as e:
                            self.log_warning(f"Error building key-to-UUID mapping: {e}")
                        
                        for section_elem in shared_server_elem.findall('Section'):
                            if section_elem.get('shared') == "1" and section_elem.get('key'):
                                section_key = str(section_elem.get('key'))
                                # Convert key to UUID if available, otherwise use key as fallback
                                section_uuid = key_to_uuid_map.get(section_key, section_key)
                                shared_section_keys_for_user.append(section_uuid)
                    
                    detailed_shares_by_userid[user_id_int_key] = {
                        'allLibraries': all_libs,
                        'sharedSectionKeys': shared_section_keys_for_user,
                        'acceptedAt': accepted_at_timestamp,
                        'allowSync': allow_sync_raw,
                        'allow_downloads': allow_downloads,
                    }
        except Exception as e_shared_servers:
            self.log_error(f"Error fetching or parsing detailed /shared_servers data: {type(e_shared_servers).__name__} - {e_shared_servers}", exc_info=True)

        processed_users_data = []
        try:
            all_associated_users = admin_account.users()
            for plex_user_obj in all_associated_users:
                plex_user_id_int = getattr(plex_user_obj, 'id', None)
                if plex_user_id_int is None: continue
                if admin_plex_id and plex_user_id_int == admin_plex_id: continue
                
                plex_user_uuid_str = None
                plex_thumb_url = getattr(plex_user_obj, 'thumb', None)
                
                if plex_thumb_url and "/users/" in plex_thumb_url and "/avatar" in plex_thumb_url:
                    try:
                        plex_user_uuid_str = plex_thumb_url.split('/users/')[1].split('/avatar')[0]
                    except IndexError:
                        plex_user_uuid_str = None

                if not plex_user_uuid_str:
                    self.log_warning(f"Could not parse alphanumeric UUID for user '{plex_user_obj.localUsername}' (ID: {plex_user_id_int}). They will be matched by integer ID only.")

                user_share_details = detailed_shares_by_userid.get(plex_user_id_int)
                accepted_at_val = user_share_details.get('acceptedAt') if user_share_details else None

                # Store raw data for debugging - only JSON-serializable data
                import json
                
                # Safely extract server info without non-serializable objects
                safe_servers = []
                for s in getattr(plex_user_obj, 'servers', []):
                    try:
                        safe_servers.append({
                            'name': getattr(s, 'name', None),
                            'machineIdentifier': getattr(s, 'machineIdentifier', None),
                            'product': getattr(s, 'product', None),
                            'version': getattr(s, 'version', None),
                            'owned': getattr(s, 'owned', None),
                            'pending': getattr(s, 'pending', None)
                        })
                    except Exception:
                        safe_servers.append({'error': 'Could not serialize server object'})
                
                # Safely extract user attributes - only basic serializable types
                safe_attrs = {}
                for attr in dir(plex_user_obj):
                    if not attr.startswith('_'):
                        try:
                            value = getattr(plex_user_obj, attr, None)
                            # Test if the value is actually JSON serializable
                            try:
                                json.dumps(value)
                                safe_attrs[attr] = value
                            except (TypeError, ValueError):
                                # If not serializable, store just the type name
                                if hasattr(value, 'strftime'):  # datetime objects
                                    safe_attrs[attr] = str(value)
                                else:
                                    safe_attrs[attr] = str(type(value).__name__)
                        except Exception:
                            safe_attrs[attr] = '<Error accessing attribute>'
                
                raw_user_data = {
                    'plex_user_obj_attrs': {
                        'id': getattr(plex_user_obj, 'id', None),
                        'username': getattr(plex_user_obj, 'username', None),
                        'title': getattr(plex_user_obj, 'title', None),
                        'email': getattr(plex_user_obj, 'email', None),
                        'thumb': getattr(plex_user_obj, 'thumb', None),
                        'home': getattr(plex_user_obj, 'home', None),
                        'friend': getattr(plex_user_obj, 'friend', None),
                        'servers': safe_servers,
                        'all_attrs': safe_attrs
                    },
                    'share_details': user_share_details,
                    'users_sharing_back_ids': list(users_sharing_back_ids),
                    'timestamp': datetime.utcnow().isoformat()
                }

                allow_downloads = bool(getattr(plex_user_obj, 'allowSync', False))
                if user_share_details and user_share_details.get('allow_downloads') is not None:
                    allow_downloads = bool(user_share_details.get('allow_downloads'))

                user_data_basic = {
                    'id': str(plex_user_id_int),
                    'uuid': plex_user_uuid_str,
                    'username': getattr(plex_user_obj, 'username', None) or getattr(plex_user_obj, 'title', 'Unknown'),
                    'email': getattr(plex_user_obj, 'email', None), 
                    'thumb': plex_thumb_url,
                    'is_home_user': getattr(plex_user_obj, 'home', False),
                    'shares_back': plex_user_id_int in users_sharing_back_ids,
                    'allow_downloads': allow_downloads,
                    'library_ids': [],
                    'accepted_at': accepted_at_val,
                    'raw_data': raw_user_data
                }

                user_share_details = detailed_shares_by_userid.get(plex_user_id_int)
                add_user_to_MUM_list = False
                effective_library_ids = []

                if user_share_details:
                    if user_share_details.get('allLibraries'):
                        effective_library_ids = all_my_server_library_ids_as_strings[:] 
                        add_user_to_MUM_list = True
                    else: 
                        specific_keys = user_share_details.get('sharedSectionKeys', [])
                        effective_library_ids = specific_keys[:] 
                        if effective_library_ids: add_user_to_MUM_list = True
                
                elif user_data_basic['is_home_user']:
                    effective_library_ids = all_my_server_library_ids_as_strings[:] 
                    add_user_to_MUM_list = True
                else: 
                    server_resource_for_this_user = None
                    for res in getattr(plex_user_obj, 'servers', []):
                        if getattr(res, 'machineIdentifier', None) == server_machine_id:
                            server_resource_for_this_user = res
                            break
                    if server_resource_for_this_user:
                        if not getattr(server_resource_for_this_user, 'pending', False):
                            add_user_to_MUM_list = True
                
                if add_user_to_MUM_list:
                    user_data_basic['library_ids'] = effective_library_ids
                    processed_users_data.append(user_data_basic)

            return processed_users_data

        except Exception as e_main_loop:
            self.log_error(f"get_users(): General error in main user processing loop: {type(e_main_loop).__name__} - {e_main_loop}", exc_info=True)
            return []

    def create_user(self, username: str, email: str, password: str = None, **kwargs) -> Dict[str, Any]:
        """Create/invite user to Plex server"""
        admin_account = self._get_admin_account()
        server = self._get_server_instance()
        
        if not admin_account or not server:
            raise Exception("Plex admin or server connection failed")
        
        try:
            library_ids = kwargs.get('library_ids', [])
            allow_sync = kwargs.get('allow_downloads', False)
            
            # Prepare sections to share
            sections_to_share = None
            if library_ids:
                all_libs = {str(lib.key): lib for lib in server.library.sections()}
                sections_to_share = []
                for lib_id in library_ids:
                    if str(lib_id) in all_libs:
                        sections_to_share.append(all_libs[str(lib_id)])
            
            # Invite user
            admin_account.inviteFriend(
                user=email or username,
                server=server,
                sections=sections_to_share,
                allowSync=allow_sync
            )
            
            return {
                'success': True,
                'user_id': None,  # Plex doesn't return user ID immediately
                'username': username,
                'email': email
            }
            
        except Exception as e:
            self.log_error(f"Error creating user: {e}")
            raise
    
    def update_user_access(self, user_id: str, library_ids: List[str] = None, **kwargs) -> bool:
        """Update Plex user's library access"""
        admin_account = self._get_admin_account()
        server = self._get_server_instance()
        
        if not admin_account or not server:
            return False
        
        try:
            user = admin_account.user(user_id)
            if not user:
                return False
            
            update_kwargs = {
                'user': user,
                'server': server
            }
            
            if library_ids is not None:
                if library_ids:
                    # Create mapping from both UUIDs and keys to library objects for compatibility
                    all_libs = {}
                    for lib in server.library.sections():
                        # Map by UUID (primary)
                        if hasattr(lib, 'uuid') and lib.uuid:
                            all_libs[str(lib.uuid)] = lib
                        # Also map by key for backward compatibility
                        if hasattr(lib, 'key'):
                            all_libs[str(lib.key)] = lib
                    
                    sections = [all_libs[str(lib_id)] for lib_id in library_ids if str(lib_id) in all_libs]
                    update_kwargs['sections'] = sections
                else:
                    update_kwargs['sections'] = []
            
            # Note: allowSync parameter causes issues, so we skip it for now
            # if 'allow_downloads' in kwargs:
            #     update_kwargs['allowSync'] = kwargs['allow_downloads']
            
            admin_account.updateFriend(**update_kwargs)
            return True
            
        except Exception as e:
            self.log_error(f"Error updating user access: {e}")
            return False
    
    def delete_user(self, user_id: str) -> bool:
        """Remove user from Plex server"""
        admin_account = self._get_admin_account()
        
        if not admin_account:
            return False
        
        try:
            user = admin_account.user(user_id)
            if user:
                admin_account.removeFriend(user)
            return True
        except Exception as e:
            self.log_error(f"Error deleting user: {e}")
            return False
    
    def get_active_sessions(self) -> List[Any]:
        """Get active Plex sessions - returns full session objects with all technical details"""
        server = self._get_server_instance()
        if not server:
            return []

        sessions = []
        try:
            # --- Start of added debug logging ---
            try:
                self._last_raw_sessions_payload = None
                # Access the raw XML data from the server by calling the endpoint directly
                raw_data = server.query("/status/sessions")
                if raw_data is not None:
                    raw_xml = ET.tostring(raw_data, encoding="unicode")
                    self._last_raw_sessions_payload = raw_xml
                    import xmltodict
                    import json

                    # Convert XML to a dictionary
                    sessions_dict = xmltodict.parse(raw_xml)
                    # DON'T DELETE, USE FOR DEBUGGING self.log_info(f"RAW_PLEX_SESSIONS_DATA: {json.dumps(sessions_dict, indent=2)}")

            except Exception as log_e:
                self._last_raw_sessions_payload = None
                self.log_warning(f"Could not log raw session data: {log_e}")
            # --- End of added debug logging ---

            for session in server.sessions():
                # Add server context to session object for identification
                session.server_name = self.name
                session.server_id = self.server_id
                session.service_type = self.service_type.value
                sessions.append(session)
                
        except Exception as e:
            self.log_error(f"Error fetching active sessions: {e}")

        return sessions

    def get_last_raw_sessions_payload(self) -> Optional[str]:
        return self._last_raw_sessions_payload

    def get_formatted_sessions(self) -> List[Dict[str, Any]]:
        """Get active Plex sessions formatted for display"""
        from app.models import User, UserType
        import re
        
        raw_sessions = self.get_active_sessions()
        if not raw_sessions:
            return []

        session_editions = {}
        raw_session_map = {}
        primary_extra_metadata_map = {}
        if self._last_raw_sessions_payload:
            try:
                # Use xmltodict to parse the whole payload into a map for easy access
                # We need to handle both single items and lists because xmltodict behaves differently
                # depending on the number of children
                payload_dict = xmltodict.parse(self._last_raw_sessions_payload)
                if payload_dict and 'MediaContainer' in payload_dict:
                    container = payload_dict['MediaContainer']
                    # Valid session tags
                    tags = ['Video', 'Track', 'Photo', 'Metadata']
                    
                    for tag in tags:
                        if tag in container:
                            items = container[tag]
                            if not isinstance(items, list):
                                items = [items]
                            
                            for item in items:
                                session_key = item.get('@sessionKey')
                                if session_key:
                                    raw_session_map[str(session_key)] = item
                                    
                                    # Also capture edition info while we're here
                                    edition = item.get('@editionTitle') or item.get('@edition')
                                    if edition:
                                        session_editions[str(session_key)] = edition
                            for item in items:
                                primary_extra_key = item.get('@primaryExtraKey')
                                artist_name = item.get('@grandparentTitle')
                                album_name = item.get('@parentTitle')
                                if primary_extra_key and (artist_name or album_name):
                                    primary_extra_metadata_map[primary_extra_key] = {
                                        'artist': artist_name,
                                        'album': album_name
                                    }
                                        
            except Exception as e:
                self.log_warning(f"Could not parse raw payload for detailed attributes: {e}")

        # Get user mapping for Plex users via service users
        user_ids_in_session = set()
        user_alt_ids_in_session = set()
        for session in raw_sessions:
            if hasattr(session, 'user') and session.user:
                if hasattr(session.user, 'id') and session.user.id is not None:
                    user_ids_in_session.add(str(session.user.id))
                if hasattr(session.user, 'uuid') and session.user.uuid:
                    user_alt_ids_in_session.add(str(session.user.uuid))

        plex_accesses = []
        if user_ids_in_session:
            plex_accesses.extend(User.query.filter_by(userType=UserType.SERVICE).filter(
                User.server_id == self.server_id,
                User.external_user_id.in_(list(user_ids_in_session))
            ).all())
        if user_alt_ids_in_session:
            plex_accesses.extend(User.query.filter_by(userType=UserType.SERVICE).filter(
                User.server_id == self.server_id,
                User.external_user_alt_id.in_(list(user_alt_ids_in_session))
            ).all())

        # Prioritize SERVICE user, fall back to linked LOCAL user
        mum_users_map_by_plex_id = {}
        if plex_accesses:
            unique_accesses = {access.id: access for access in plex_accesses}
            for access in unique_accesses.values():
                service_user = access
                linked_local_user = None
                if access.linkedUserId:
                    linked_local_user = User.query.filter_by(
                        userType=UserType.LOCAL,
                        uuid=access.linkedUserId
                    ).first()

                user_to_store = service_user if service_user else linked_local_user
                if not user_to_store:
                    continue

                if access.external_user_id:
                    mum_users_map_by_plex_id[str(access.external_user_id)] = user_to_store
                if access.external_user_alt_id:
                    mum_users_map_by_plex_id[str(access.external_user_alt_id)] = user_to_store
        
        formatted_sessions = []
        metadata_cache = {}
        server = self._get_server_instance()

        def get_metadata_item(rating_key):
            if not rating_key or not server:
                return None
            rating_key_str = str(rating_key)
            if rating_key_str not in metadata_cache:
                try:
                    metadata_cache[rating_key_str] = server.fetchItem(int(rating_key_str)) if rating_key_str.isdigit() else server.fetchItem(rating_key_str)
                except Exception:
                    metadata_cache[rating_key_str] = None
            return metadata_cache.get(rating_key_str)

        def get_source_media_details(rating_key, media_id=None, part_id=None):
            metadata_item = get_metadata_item(rating_key)
            if not metadata_item:
                return None, None, None, None
            media_items = getattr(metadata_item, 'media', None) or []
            source_media = None
            if media_id:
                source_media = next((m for m in media_items if str(getattr(m, 'id', '')) == str(media_id)), None)
            if not source_media and media_items:
                source_media = media_items[0]
            if not source_media:
                return None, None, None, None
            parts = getattr(source_media, 'parts', None) or []
            source_part = None
            if part_id:
                source_part = next((p for p in parts if str(getattr(p, 'id', '')) == str(part_id)), None)
            if not source_part and parts:
                source_part = parts[0]
            streams = getattr(source_part, 'streams', None) or []
            source_video_stream = next((s for s in streams if s.streamType == 1), None)
            source_audio_stream = next((s for s in streams if s.streamType == 2), None)
            return source_media, source_part, source_video_stream, source_audio_stream

        def get_source_container(rating_key, media_id=None, part_id=None):
            source_media, source_part, _, _ = get_source_media_details(rating_key, media_id, part_id)
            if source_media and getattr(source_media, 'container', None):
                return source_media.container
            if source_part and getattr(source_part, 'container', None):
                return source_part.container
            return None
        
        def get_standard_resolution(height_str):
            if not height_str:
                return "SD"
            try:
                height = int(height_str)
                if height <= 0:
                    return "SD"
                standard_map = {
                    240: "240p",
                    360: "360p",
                    480: "480p",
                    576: "576p",
                    720: "720p",
                    1080: "1080p",
                    1440: "1440p",
                    2160: "4K",
                }
                if height in standard_map:
                    return standard_map[height]
                return f"{height}p"
            except (ValueError, TypeError):
                return "SD"

        def normalize_video_resolution(video_resolution):
            if not video_resolution:
                return None
            normalized = str(video_resolution).strip().lower().replace('ip', '')
            if not normalized:
                return None
            overrides = {
                'sd': 'SD',
                '2k': '2k',
                '4k': '4k'
            }
            if normalized in overrides:
                return overrides[normalized]
            if normalized.isdigit():
                return f"{normalized}p"
            return normalized

        def get_resolution_label(video_resolution, height_value=None):
            normalized = normalize_video_resolution(video_resolution)
            if normalized:
                return normalized
            return get_standard_resolution(height_value)

        def get_stream_media_xml(raw_xml_data):
            if not raw_xml_data:
                return None
            media_node = raw_xml_data.get('Media')
            if isinstance(media_node, list):
                selected_media = next((m for m in media_node if m.get('@selected') == '1'), None)
                return selected_media or media_node[0]
            if isinstance(media_node, dict):
                return media_node
            return None

        def get_transcode_session_xml(raw_xml_data):
            if not raw_xml_data:
                return None
            transcode_node = raw_xml_data.get('TranscodeSession')
            if isinstance(transcode_node, list):
                return transcode_node[0] if transcode_node else None
            return transcode_node

        def get_session_bandwidth_mbps(raw_xml_data):
            if not raw_xml_data:
                return None
            session_node = raw_xml_data.get('Session')
            if isinstance(session_node, list):
                session_node = session_node[0] if session_node else None
            if not isinstance(session_node, dict):
                return None
            bandwidth_value = session_node.get('@bandwidth')
            try:
                bandwidth_kbps = int(bandwidth_value)
            except (TypeError, ValueError):
                return None
            if bandwidth_kbps <= 0:
                return None
            return bandwidth_kbps / 1000.0

        def format_bandwidth(bandwidth_mbps):
            if bandwidth_mbps is None:
                return None
            if bandwidth_mbps >= 1000:
                return f"{bandwidth_mbps / 1000:.1f} Gbps"
            if bandwidth_mbps < 1:
                return f"{bandwidth_mbps * 1000:.0f} Kbps"
            return f"{bandwidth_mbps:.1f} Mbps"

        def format_kbps_bitrate(bitrate_kbps):
            if bitrate_kbps is None:
                return None
            try:
                bitrate_value = float(bitrate_kbps)
            except (TypeError, ValueError):
                return None
            if bitrate_value < 1000:
                return f"{bitrate_value:.0f} kbps"
            if bitrate_value < 1_000_000:
                return f"{bitrate_value / 1000:.1f} Mbps"
            return f"{bitrate_value / 1_000_000:.1f} Gbps"

        video_quality_profiles = {
            20000: '20 Mbps 1080p',
            12000: '12 Mbps 1080p',
            10000: '10 Mbps 1080p',
            8000: '8 Mbps 1080p',
            4000: '4 Mbps 720p',
            3000: '3 Mbps 720p',
            2000: '2 Mbps 720p',
            1500: '1.5 Mbps 480p',
            720: '0.7 Mbps 328p',
            320: '0.3 Mbps 240p',
            208: '0.2 Mbps 160p',
            96: '0.096 Mbps',
            64: '0.064 Mbps'
        }
        video_quality_bitrates = sorted(video_quality_profiles.keys())

        def get_quality_profile(stream_bitrate, source_bitrate):
            if stream_bitrate is None:
                return None
            try:
                stream_bitrate_value = int(stream_bitrate)
            except (TypeError, ValueError):
                return None
            source_bitrate_value = None
            if source_bitrate is not None:
                try:
                    source_bitrate_value = int(source_bitrate)
                except (TypeError, ValueError):
                    source_bitrate_value = None
            candidates = [
                bitrate for bitrate in video_quality_bitrates
                if stream_bitrate_value <= bitrate and (source_bitrate_value is None or bitrate <= source_bitrate_value)
            ]
            if not candidates:
                return "Original"
            selected = min(candidates)
            return video_quality_profiles.get(selected)
        
        for raw_session in raw_sessions:
            try:
                # Basic session info
                user_name = getattr(raw_session.user, 'username', None) or getattr(raw_session.user, 'title', 'Unknown User')
                player = raw_session.player
                player_title = getattr(player, 'title', 'Unknown Player')
                player_platform = getattr(player, 'platform', '')
                product = getattr(player, 'product', 'N/A')
                media_title = getattr(raw_session, 'title', "Unknown Title")
                raw_type = getattr(raw_session, 'type', 'unknown')
                media_type = raw_type.capitalize()
                if getattr(raw_session, 'subtype', None) == 'musicVideo':
                    media_type = 'musicVideo'
                year = getattr(raw_session, 'year', None)
                library_name = getattr(raw_session, 'librarySectionTitle', "N/A")
                progress = (raw_session.viewOffset / raw_session.duration) * 100 if raw_session.duration else 0
                
                # Format time display like AudioBookshelf
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
                
                current_time_formatted = format_time_ms(raw_session.viewOffset) if raw_session.viewOffset else "0:00"
                duration_formatted = format_time_ms(raw_session.duration) if raw_session.duration else "0:00"
                
                # Debug logging for time formatting
                self.log_info(f"Plex session time debug - viewOffset: {raw_session.viewOffset}, duration: {raw_session.duration}")
                self.log_info(f"Plex session formatted times - current: '{current_time_formatted}', duration: '{duration_formatted}'")
                
                # Thumbnail handling
                thumb_path = raw_session.thumb
                if media_type == 'Episode' and hasattr(raw_session, 'grandparentThumb'):
                    thumb_path = raw_session.grandparentThumb
                # Manually construct URL to avoid url_for issues when called outside request context (e.g., websocket events)
                thumb_url = f"/admin/api/v2/media/plex/images/proxy?path={thumb_path.lstrip('/')}" if thumb_path else None
                
                # Transcoding info
                transcode_session = raw_session.transcodeSession
                
                # Determine if actually transcoding based on decisions, not just presence of transcode session
                is_transcoding = False
                if transcode_session:
                    video_decision = getattr(transcode_session, 'videoDecision', None)
                    audio_decision = getattr(transcode_session, 'audioDecision', None)
                    # Only consider it transcoding if video or audio is actually being transcoded
                    is_transcoding = (video_decision == 'transcode') or (audio_decision == 'transcode')
                
                # Location info
                location_ip = getattr(player, 'address', 'N/A')
                is_lan = getattr(player, 'local', False)
                location_lan_wan = "LAN" if is_lan else "WAN"
                plex_user_id = getattr(raw_session.user, 'id', None)
                plex_user_uuid = getattr(raw_session.user, 'uuid', None)
                mum_user = None
                if plex_user_id is not None:
                    mum_user = mum_users_map_by_plex_id.get(str(plex_user_id))
                if not mum_user and plex_user_uuid:
                    mum_user = mum_users_map_by_plex_id.get(str(plex_user_uuid))
                mum_user_id = mum_user.id if mum_user else None
                mum_user_uuid = mum_user.uuid if mum_user else None
                session_key = raw_session.sessionKey
                rating_key = getattr(raw_session, 'ratingKey', None)
                
                # User avatar
                user_avatar_url = None
                if hasattr(raw_session.user, 'thumb') and raw_session.user.thumb:
                    user_thumb_url = raw_session.user.thumb
                    if user_thumb_url.startswith('https://plex.tv/') or user_thumb_url.startswith('http://plex.tv/'):
                        user_avatar_url = user_thumb_url
                    else:
                        # Manually construct URL to avoid url_for issues when called outside request context (e.g., websocket events)
                        user_avatar_url = f"/admin/api/v2/media/plex/images/proxy?path={user_thumb_url.lstrip('/')}"
                
                # Media details
                source_media = None
                source_media_part = None
                source_video_stream = None
                source_audio_stream = None
                stream_media = None
                stream_media_part = None
                stream_video_stream = None
                stream_audio_stream = None
                source_container = None
                
                if raw_session.media:
                    stream_media = next((m for m in raw_session.media if getattr(m, 'selected', False)), raw_session.media[0])
                    if stream_media and stream_media.parts:
                        stream_media_part = next((p for p in stream_media.parts if getattr(p, 'selected', False)), stream_media.parts[0])
                    if stream_media_part and stream_media_part.streams:
                        stream_video_stream = next((s for s in stream_media_part.streams if s.streamType == 1), None)
                        stream_audio_stream = next((s for s in stream_media_part.streams if s.streamType == 2), None)
                if rating_key:
                    source_media, source_media_part, source_video_stream, source_audio_stream = get_source_media_details(
                        rating_key,
                        media_id=getattr(stream_media, 'id', None),
                        part_id=getattr(stream_media_part, 'id', None)
                    )
                    source_container = get_source_container(
                        rating_key,
                        media_id=getattr(stream_media, 'id', None),
                        part_id=getattr(stream_media_part, 'id', None)
                    )
                if not source_media:
                    source_media = stream_media
                if not source_media_part:
                    source_media_part = stream_media_part
                if not source_video_stream:
                    source_video_stream = stream_video_stream
                if not source_audio_stream:
                    source_audio_stream = stream_audio_stream
                
                raw_xml_data = raw_session_map.get(str(session_key))
                bandwidth_mbps = get_session_bandwidth_mbps(raw_xml_data)
                bandwidth_label = format_bandwidth(bandwidth_mbps)
                bandwidth_detail = bandwidth_label if bandwidth_label is not None else f"Streaming via {location_lan_wan}"

                # Initialize details
                quality_detail = ""
                stream_details = ""
                video_detail = ""
                audio_detail = ""
                subtitle_detail = "None"
                container_detail = ""
                
                if is_transcoding:
                    # Transcoding details
                    speed = f"(Speed: {transcode_session.speed:.1f})" if transcode_session and transcode_session.speed is not None else ""
                    status = "Throttled" if transcode_session and transcode_session.throttled else ""
                    stream_details = f"Transcode {status} {speed}".strip()
                    
                    # Container
                    original_container_value = source_container or (source_media_part.container if source_media_part and hasattr(source_media_part, 'container') and source_media_part.container else None)
                    original_container = original_container_value.upper() if original_container_value else 'N/A'
                    transcoded_container_value = transcode_session.container if transcode_session and hasattr(transcode_session, 'container') and transcode_session.container else None
                    if not transcoded_container_value and stream_media and hasattr(stream_media, 'container') and stream_media.container:
                        transcoded_container_value = stream_media.container
                    transcoded_container = transcoded_container_value.upper() if transcoded_container_value else 'N/A'
                    container_detail = f"Converting ({original_container} → {transcoded_container})"

                    # Video
                    source_video_resolution = getattr(source_media, 'videoResolution', None) if source_media else None
                    original_res = get_resolution_label(source_video_resolution, source_video_stream.height if source_video_stream else None)

                    stream_xml_media = get_stream_media_xml(raw_xml_data)
                    stream_video_resolution = None
                    if stream_xml_media and isinstance(stream_xml_media, dict):
                        stream_video_resolution = stream_xml_media.get('@videoResolution') or stream_xml_media.get('@height')
                    if not stream_video_resolution and stream_media:
                        stream_video_resolution = getattr(stream_media, 'videoResolution', None) or getattr(stream_media, 'height', None)
                    transcoded_res = get_resolution_label(stream_video_resolution, transcode_session.height if transcode_session else None)
                    
                    # Check for HW acceleration
                    hw_decode = False
                    hw_encode = False
                    ts_xml = get_transcode_session_xml(raw_xml_data)
                    if ts_xml and isinstance(ts_xml, dict):
                        hw_decode = ts_xml.get('@transcodeHwDecoding') == '1'
                        hw_encode = ts_xml.get('@transcodeHwEncoding') == '1'

                    if transcode_session and transcode_session.videoDecision == "copy":
                        original_codec = source_video_stream.codec.upper() if source_video_stream and hasattr(source_video_stream, 'codec') and source_video_stream.codec else 'Unknown'
                        video_detail = f"Direct Stream ({original_codec} {original_res})"
                    else:
                        original_codec = source_video_stream.codec.upper() if source_video_stream and hasattr(source_video_stream, 'codec') and source_video_stream.codec else 'Unknown'
                        transcoded_codec = transcode_session.videoCodec.upper() if transcode_session and hasattr(transcode_session, 'videoCodec') and transcode_session.videoCodec else 'N/A'
                        
                        # Add (HW) indicators to match Tautulli's style
                        source_label = f"{original_codec} {original_res}"
                        if hw_decode:
                            source_label = f"{original_codec} (HW) {original_res}"
                            
                        dest_label = f"{transcoded_codec} {transcoded_res}"
                        if hw_encode:
                            dest_label = f"{transcoded_codec} (HW) {transcoded_res}"
                            
                        video_detail = f"Transcode ({source_label} → {dest_label})"

                    # Audio
                    if transcode_session and transcode_session.audioDecision == "copy":
                        original_audio_display = source_audio_stream.displayTitle if source_audio_stream and hasattr(source_audio_stream, 'displayTitle') else "Unknown"
                        audio_detail = f"Direct Stream ({original_audio_display})"
                    else:
                        original_audio_display = source_audio_stream.displayTitle if source_audio_stream and hasattr(source_audio_stream, 'displayTitle') else "Unknown"
                        audio_channel_layout_map = {1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1"}
                        transcoded_channel_layout = audio_channel_layout_map.get(transcode_session.audioChannels, f"{transcode_session.audioChannels}ch") if transcode_session and hasattr(transcode_session, 'audioChannels') and transcode_session.audioChannels else "N/A"
                        transcoded_audio_codec = transcode_session.audioCodec.upper() if transcode_session and hasattr(transcode_session, 'audioCodec') and transcode_session.audioCodec else 'N/A'
                        transcoded_audio_display = f"{transcoded_audio_codec} {transcoded_channel_layout}"
                        audio_detail = f"Transcode ({original_audio_display} → {transcoded_audio_display})"

                    # Subtitle
                    selected_subtitle_stream = None
                    if raw_session.media:
                        selected_subtitle_stream = next((s for m in raw_session.media for p in m.parts for s in p.streams if p and s.streamType == 3 and s.selected), None)
                    if transcode_session and transcode_session.subtitleDecision == "transcode":
                        if selected_subtitle_stream:
                            lang = selected_subtitle_stream.language or "Unknown"
                            dest_format = (getattr(selected_subtitle_stream, 'format', '???') or '???').upper()
                            display_title = selected_subtitle_stream.displayTitle
                            match = re.search(r'\((.*?)\)', display_title)
                            original_format = match.group(1).upper() if match else '???'
                            
                            if original_format != dest_format and dest_format != '???':
                                subtitle_detail = f"Transcode ({lang} - {original_format} → {dest_format})"
                            else:
                                subtitle_detail = f"Transcode ({display_title})"
                        else:
                            subtitle_detail = "Transcode (Unknown)"
                    elif transcode_session and transcode_session.subtitleDecision == "copy":
                        subtitle_detail = f"Direct Stream ({selected_subtitle_stream.displayTitle})" if selected_subtitle_stream else "Direct Stream (Unknown)"

                    # Quality
                    transcoded_media = next((m for m in raw_session.media if m.selected), None) if raw_session.media else None
                    stream_bitrate = getattr(transcoded_media, 'bitrate', None) if transcoded_media else None
                    source_bitrate = getattr(source_media, 'bitrate', None) if source_media else None
                    quality_profile = get_quality_profile(stream_bitrate, source_bitrate)
                    quality_res = get_resolution_label(stream_video_resolution, transcode_session.height if transcode_session else 0)
                    if stream_bitrate:
                        profile_label = quality_profile or quality_res
                        quality_detail = f"{profile_label} ({stream_bitrate / 1000:.1f} Mbps)"
                    else:
                        quality_detail = f"{quality_res} (Bitrate N/A)"

                else:
                    # Direct Play/Stream - determine based on transcode session decisions
                    stream_details = "Direct Play"
                    
                    # Check if it's actually direct stream (remuxing container but not transcoding content)
                    if transcode_session:
                        video_decision = getattr(transcode_session, 'videoDecision', None)
                        audio_decision = getattr(transcode_session, 'audioDecision', None)
                        if video_decision == 'copy' or audio_decision == 'copy':
                            stream_details = "Direct Stream"
                    elif raw_session.media and any(p.decision == 'transcode' for m in raw_session.media for p in m.parts if p):
                        stream_details = "Direct Stream"

                    source_video_resolution = getattr(source_media, 'videoResolution', None) if source_media else None
                    original_res = get_resolution_label(source_video_resolution, source_video_stream.height if source_video_stream else None)
                    original_container_value = source_container or (source_media_part.container if source_media_part and hasattr(source_media_part, 'container') and source_media_part.container else None)
                    container_detail = original_container_value.upper() if original_container_value else "Unknown"
                    
                    # Use the determined stream type (Direct Play or Direct Stream) for details
                    stream_type = "Direct Stream" if stream_details == "Direct Stream" else "Direct Play"
                    
                    if getattr(raw_session, 'type', '').lower() == 'track':
                        video_detail = "Audio Only"
                    elif source_video_stream and hasattr(source_video_stream, 'codec') and source_video_stream.codec:
                        video_detail = f"{stream_type} ({source_video_stream.codec.upper()} {original_res})"
                    else:
                        video_detail = f"{stream_type} (Unknown Video)"
                    
                    if source_audio_stream and hasattr(source_audio_stream, 'displayTitle') and source_audio_stream.displayTitle:
                        audio_detail = f"{stream_type} ({source_audio_stream.displayTitle})"
                    else:
                        audio_detail = f"{stream_type} (Unknown Audio)"
                    
                    selected_subtitle_stream = None
                    if raw_session.media:
                        selected_subtitle_stream = next((s for m in raw_session.media for p in m.parts for s in p.streams if p and s.streamType == 3 and s.selected), None)
                    if transcode_session and transcode_session.subtitleDecision == "transcode":
                        if selected_subtitle_stream:
                            lang = selected_subtitle_stream.language or "Unknown"
                            dest_format = (getattr(selected_subtitle_stream, 'format', '???') or '???').upper()
                            display_title = selected_subtitle_stream.displayTitle
                            match = re.search(r'\((.*?)\)', display_title)
                            original_format = match.group(1).upper() if match else '???'
                            if original_format != dest_format and dest_format != '???':
                                subtitle_detail = f"Transcode ({lang} - {original_format} → {dest_format})"
                            else:
                                subtitle_detail = f"Transcode ({display_title})"
                        else:
                            subtitle_detail = "Transcode (Unknown)"
                    elif transcode_session and transcode_session.subtitleDecision == "copy":
                        subtitle_detail = f"Direct Stream ({selected_subtitle_stream.displayTitle})" if selected_subtitle_stream else "Direct Stream (Unknown)"
                    elif selected_subtitle_stream:
                        subtitle_detail = f"{stream_type} ({selected_subtitle_stream.displayTitle})"

                    quality_detail = "Original (Bitrate N/A)"
                    if source_media and hasattr(source_media, 'bitrate') and source_media.bitrate:
                        quality_detail = f"Original ({source_media.bitrate / 1000:.1f} Mbps)"
                    elif getattr(raw_session, 'type', '').lower() == 'track':
                        audio_bitrate_kbps = None
                        for stream in (source_audio_stream, stream_audio_stream):
                            if stream and hasattr(stream, 'bitrate') and stream.bitrate:
                                try:
                                    audio_bitrate_kbps = int(stream.bitrate)
                                except (TypeError, ValueError):
                                    audio_bitrate_kbps = None
                                if audio_bitrate_kbps:
                                    break
                        if audio_bitrate_kbps:
                            formatted_audio_bitrate = format_kbps_bitrate(audio_bitrate_kbps)
                            if formatted_audio_bitrate:
                                quality_detail = f"Original ({formatted_audio_bitrate})"

                # Raw data for modal
                raw_session_dict = {}
                if hasattr(raw_session, '_data') and raw_session._data is not None:
                    raw_xml_string = ET.tostring(raw_session._data, encoding='unicode')
                    raw_session_dict = xmltodict.parse(raw_xml_string)
                raw_json_string = json.dumps(raw_session_dict, indent=2)

                edition = None
                session_key_str = str(session_key) if session_key is not None else ''
                if session_key_str and session_key_str in session_editions:
                    edition = session_editions[session_key_str]
                if hasattr(raw_session, 'editionTitle') and raw_session.editionTitle:
                    edition = raw_session.editionTitle
                elif hasattr(raw_session, 'edition') and raw_session.edition:
                    edition = raw_session.edition
                elif hasattr(raw_session, '_data') and raw_session._data is not None:
                    edition = raw_session._data.attrib.get('editionTitle') or raw_session._data.attrib.get('edition')

                # Additional details
                grandparent_title = getattr(raw_session, 'grandparentTitle', None)
                parent_title = getattr(raw_session, 'parentTitle', None)
                if getattr(raw_session, 'subtype', None) == 'musicVideo' and (not grandparent_title or not parent_title):
                    artist_candidates = []
                    if raw_xml_data:
                        raw_key = raw_xml_data.get('@key')
                        raw_rating_key = raw_xml_data.get('@ratingKey')
                        if raw_key:
                            artist_candidates.append(raw_key)
                        if raw_rating_key:
                            artist_candidates.append(f"/library/metadata/{raw_rating_key}")
                    for candidate_key in artist_candidates:
                        metadata = primary_extra_metadata_map.get(candidate_key)
                        if not metadata:
                            continue
                        if not grandparent_title and metadata.get('artist'):
                            grandparent_title = metadata['artist']
                        if not parent_title and metadata.get('album'):
                            parent_title = metadata['album']
                        if grandparent_title or parent_title:
                            break
                    if not grandparent_title or not parent_title:
                        metadata_item = get_metadata_item(rating_key)
                        if metadata_item:
                            if not grandparent_title:
                                grandparent_title = getattr(metadata_item, 'grandparentTitle', None)
                            if not parent_title:
                                parent_title = getattr(metadata_item, 'parentTitle', None)
                player_state = getattr(raw_session.player, 'state', 'N/A').capitalize()
                if getattr(raw_session, 'type', '').lower() == 'track' and player_state.lower() == 'playing':
                    player_state = 'Listening'
                bitrate_calc = source_media.bitrate if source_media and hasattr(source_media, 'bitrate') else 0

                session_details = {
                    'user': user_name,
                    'mum_user_id': mum_user_id,
                    'mum_user_uuid': mum_user_uuid,
                    'player_title': player_title,
                    'player_platform': player_platform,
                    'product': product,
                    'media_title': media_title,
                    'grandparent_title': grandparent_title,
                    'parent_title': parent_title,
                    'edition': edition,
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
                    'media_path': getattr(stream_media_part, 'file', None),
                    'media_duration': getattr(stream_media, 'duration', None) or getattr(raw_session, 'duration', None),
                    'media_bitrate': getattr(stream_media, 'bitrate', None),
                    'media_width': getattr(stream_media, 'width', None) or getattr(stream_video_stream, 'width', None),
                    'media_height': getattr(stream_media, 'height', None) or getattr(stream_video_stream, 'height', None),
                    'media_aspect_ratio': getattr(stream_media, 'aspectRatio', None) or getattr(stream_video_stream, 'aspectRatio', None),
                    'media_audio_channels': getattr(stream_media, 'audioChannels', None) or getattr(stream_audio_stream, 'channels', None),
                    'media_audio_codec': getattr(stream_media, 'audioCodec', None) or getattr(stream_audio_stream, 'codec', None),
                    'media_video_codec': getattr(stream_media, 'videoCodec', None) or getattr(stream_video_stream, 'codec', None),
                    'media_video_resolution': getattr(stream_media, 'videoResolution', None) or getattr(raw_session, 'videoResolution', None),
                    'media_container': getattr(stream_media, 'container', None) or getattr(stream_media_part, 'container', None),
                    'media_video_frame_rate': getattr(stream_media, 'videoFrameRate', None) or getattr(stream_video_stream, 'frameRate', None),
                    'media_video_profile': getattr(stream_video_stream, 'profile', None) or getattr(stream_media, 'videoProfile', None),
                    'media_has_voice_activity': getattr(stream_media, 'hasVoiceActivity', None),
                    'location_detail': f"{location_lan_wan}: {location_ip}",
                    'is_public_ip': not is_lan,
                    'location_ip': location_ip,
                    'bandwidth_detail': bandwidth_detail,
                    'bitrate_calc': bitrate_calc,
                    'location_type_calc': location_lan_wan,
                    'is_transcode_calc': is_transcoding,
                    'raw_data_json': raw_json_string,
                    'raw_data_json_lines': raw_json_string.splitlines(),
                    'service_type': 'plex',
                    'server_name': self.name,
                    # Add formatted time fields for enhanced progress display
                    'current_time': current_time_formatted,
                    'duration': duration_formatted
                }
                formatted_sessions.append(session_details)
                
            except Exception as e:
                # Enhanced error logging for debugging
                session_info = f"Session: {getattr(raw_session, 'title', 'Unknown')} - User: {getattr(getattr(raw_session, 'user', None), 'title', 'Unknown')}"
                self.log_error(f"Error formatting Plex session - {session_info}: {type(e).__name__}: {e}", exc_info=True)
                continue
        
        return formatted_sessions
    
    def terminate_session(self, session_id: str, reason: str = None) -> bool:
        """Terminate a Plex session"""
        server = self._get_server_instance()
        if not server:
            return False
        
        try:
            for session in server.sessions():
                if str(getattr(session, 'sessionKey', '')) == str(session_id):
                    session.stop(reason=reason)
                    return True
            return False
        except Exception as e:
            self.log_error(f"Error terminating session: {e}")
            return False
    
    def get_server_info(self) -> Dict[str, Any]:
        """Get Plex server information"""
        server = self._get_server_instance()
        if server:
            try:
                return {
                    'name': server.friendlyName,
                    'url': self.url,
                    'service_type': self.service_type.value,
                    'online': True,
                    'version': server.version,
                    'machine_id': server.machineIdentifier
                }
            except:
                pass
        
        return {
            'name': self.name,
            'url': self.url,
            'service_type': self.service_type.value,
            'online': False,
            'version': 'Unknown'
        }

    def get_library_content(self, library_key: str, page: int = 1, per_page: int = 24, parent_id: str = None) -> Dict[str, Any]:
        """Get content from a specific Plex library"""
        try:
            server = self._get_server_instance()
            if not server:
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': 'Could not connect to Plex server'
                }
            
            # Find the library section by key or UUID
            library_section = None
            for section in server.library.sections():
                # Try matching by UUID first (preferred), then by key as fallback
                if (hasattr(section, 'uuid') and str(section.uuid) == str(library_key)) or str(section.key) == str(library_key):
                    library_section = section
                    break
            
            if not library_section:
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': f'Library with key/UUID {library_key} not found'
                }
            
            # If parent_id is provided, get episodes for that specific show
            if parent_id:
                try:
                    # Get the show by its rating key (ensure it's just the numeric ID)
                    rating_key = str(parent_id).strip()
                    self.log_info(f"Fetching show with rating key: {rating_key}")
                    
                    # Try different methods to get the show
                    show = None
                    try:
                        # Method 1: Search by rating key in the library (most reliable)
                        for item in library_section.all():
                            if hasattr(item, 'ratingKey') and str(item.ratingKey) == rating_key:
                                show = item
                                break
                        
                        # Method 2: If not found, try direct fetchItem as fallback
                        if not show:
                            try:
                                show = server.fetchItem(int(rating_key))
                            except (ValueError, Exception) as e2:
                                self.log_warning(f"fetchItem with int rating key failed: {e2}")
                                # Method 3: Try with string rating key
                                try:
                                    show = server.fetchItem(rating_key)
                                except Exception as e3:
                                    self.log_warning(f"fetchItem with string rating key failed: {e3}")
                                    
                    except Exception as e1:
                        self.log_warning(f"Error searching library for rating key {rating_key}: {e1}")
                    if not show:
                        return {
                            'items': [],
                            'total': 0,
                            'page': page,
                            'per_page': per_page,
                            'pages': 0,
                            'has_prev': False,
                            'has_next': False,
                            'error': f'Show with ID {parent_id} not found'
                        }
                    
                    # Get all episodes from all seasons using the PlexAPI approach
                    all_episodes = []
                    for season in show.seasons():
                        for episode in season.episodes():
                            all_episodes.append(episode)
                    
                    all_items = all_episodes
                    
                except Exception as e:
                    self.log_error(f"Error getting episodes for show {parent_id}: {e}")
                    return {
                        'items': [],
                        'total': 0,
                        'page': page,
                        'per_page': per_page,
                        'pages': 0,
                        'has_prev': False,
                        'has_next': False,
                        'error': f'Error getting episodes: {str(e)}'
                    }
            else:
                # Get all items from the library
                all_items = library_section.all()
            total_items = len(all_items)
            
            # Calculate pagination
            start_idx = (page - 1) * per_page
            end_idx = start_idx + per_page
            page_items = all_items[start_idx:end_idx]
            
            # Process items into standardized format
            processed_items = []
            for item in page_items:
                try:
                    # Get thumbnail URL using proxy method (manually construct to avoid url_for issues)
                    thumb_url = None
                    if hasattr(item, 'thumb') and item.thumb:
                        # Manually construct relative URL to avoid url_for issues with external hosts
                        thumb_url = f"/admin/api/v2/media/plex/images/proxy?path={item.thumb.lstrip('/')}"
                        # current_app.logger.debug(f"Generated Plex thumb URL: {thumb_url}")
                    elif hasattr(item, 'art') and item.art:
                        # Manually construct relative URL to avoid url_for issues with external hosts
                        thumb_url = f"/admin/api/v2/media/plex/images/proxy?path={item.art.lstrip('/')}"
                        # current_app.logger.debug(f"Generated Plex art URL: {thumb_url}")
                    
                    # Extract year from originallyAvailableAt
                    year = None
                    if hasattr(item, 'originallyAvailableAt') and item.originallyAvailableAt:
                        try:
                            year = str(item.originallyAvailableAt).split('-')[0]
                        except:
                            year = None
                    elif hasattr(item, 'year') and item.year:
                        year = str(item.year)
                    
                    # Get edition information for movies
                    edition = None
                    if hasattr(item, 'editionTitle') and item.editionTitle:
                        edition = item.editionTitle
                    elif hasattr(item, 'edition') and item.edition:
                        edition = item.edition
                    
                    # Get rating
                    rating = None
                    if hasattr(item, 'rating') and item.rating:
                        rating = float(item.rating)
                    elif hasattr(item, 'audienceRating') and item.audienceRating:
                        rating = float(item.audienceRating)
                    
                    # Get duration in milliseconds and media ID
                    duration = None
                    media_id = None
                    
                    # Extract media ID from the media array (the real external ID)
                    if hasattr(item, 'media') and item.media:
                        # Use the first media item's ID as the primary external_id
                        first_media = item.media[0]
                        if hasattr(first_media, 'id'):
                            media_id = str(first_media.id)
                        # Get duration from media if available
                        if hasattr(first_media, 'duration') and first_media.duration:
                            duration = first_media.duration
                    
                    # Fallback to item duration if media duration not available
                    if not duration and hasattr(item, 'duration') and item.duration:
                        duration = item.duration
                    
                    # Use media ID for movies, ratingKey for shows and other content
                    item_type = getattr(item, 'type', 'unknown').lower()
                    if item_type == 'movie' and media_id:
                        # For movies, use the media ID from the media array
                        external_id = media_id
                    else:
                        # For shows, episodes, and other content, use ratingKey
                        external_id = str(getattr(item, 'ratingKey', ''))
                    
                    processed_item = {
                        'id': external_id,
                        'title': getattr(item, 'title', 'Unknown Title'),
                        'year': year,
                        'edition': edition,
                        'thumb': thumb_url,
                        'type': getattr(item, 'type', 'unknown'),
                        'summary': getattr(item, 'summary', ''),
                        'rating': rating,
                        'duration': duration,
                        'added_at': getattr(item, 'addedAt', None),
                        'key': getattr(item, 'key', ''),
                        'guid': getattr(item, 'guid', ''),
                        'studio': getattr(item, 'studio', ''),
                        'contentRating': getattr(item, 'contentRating', ''),
                        'raw_data': {
                            'ratingKey': getattr(item, 'ratingKey', ''),
                            'media_id': media_id,  # Will be None for shows, that's expected
                            'external_id_type': 'media_id' if item_type == 'movie' and media_id else 'ratingKey',
                            'title': getattr(item, 'title', ''),
                            'type': getattr(item, 'type', ''),
                            'thumb': getattr(item, 'thumb', ''),
                            'art': getattr(item, 'art', ''),
                            'edition': edition,
                        }
                    }
                    
                    processed_items.append(processed_item)
                    
                except Exception as item_error:
                    self.log_error(f"Error processing Plex library item: {item_error}")
                    continue
            
            # Calculate pagination info
            total_pages = (total_items + per_page - 1) // per_page
            has_prev = page > 1
            has_next = page < total_pages
            
            self.log_info(f"Retrieved {len(processed_items)} items from Plex library {library_section.title} (page {page}/{total_pages})")
            
            return {
                'items': processed_items,
                'total': total_items,
                'page': page,
                'per_page': per_page,
                'pages': total_pages,
                'has_prev': has_prev,
                'has_next': has_next,
                'library_title': getattr(library_section, 'title', 'Unknown Library'),
                'library_type': getattr(library_section, 'type', 'unknown')
            }
            
        except Exception as e:
            self.log_error(f"Error getting Plex library content: {e}")
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

    def get_show_episodes(self, show_id: str, page: int = 1, per_page: int = 24, search_query: str = '') -> Dict[str, Any]:
        """Get episodes for a specific TV show"""
        try:
            server = self._get_server_instance()
            if not server:
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': 'Could not connect to Plex server'
                }
            
            # Find the show by rating key
            show = None
            rating_key = str(show_id).strip()
            self.log_info(f"Fetching episodes for show with rating key: {rating_key}")
            
            # Search through all library sections to find the show
            for section in server.library.sections():
                if section.type == 'show':  # Only check TV show libraries
                    try:
                        for item in section.all():
                            if hasattr(item, 'ratingKey') and str(item.ratingKey) == rating_key:
                                show = item
                                break
                        if show:
                            break
                    except Exception as e:
                        self.log_warning(f"Error searching section {section.title}: {e}")
                        continue
            
            if not show:
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': f'Show with ID {show_id} not found'
                }
            
            # Get all episodes from all seasons
            all_episodes = []
            try:
                for season in show.seasons():
                    for episode in season.episodes():
                        all_episodes.append(episode)
            except Exception as e:
                self.log_warning(f"Error getting episodes: {e}")
                return {
                    'items': [],
                    'total': 0,
                    'page': page,
                    'per_page': per_page,
                    'pages': 0,
                    'has_prev': False,
                    'has_next': False,
                    'error': f'Error retrieving episodes: {str(e)}'
                }
            
            # Filter episodes by search query if provided
            if search_query:
                filtered_episodes = []
                search_lower = search_query.lower()
                for episode in all_episodes:
                    if (search_lower in episode.title.lower() if episode.title else False) or \
                       (search_lower in episode.summary.lower() if episode.summary else False):
                        filtered_episodes.append(episode)
                all_episodes = filtered_episodes
            
            # Calculate pagination
            total_episodes = len(all_episodes)
            total_pages = (total_episodes + per_page - 1) // per_page
            start_idx = (page - 1) * per_page
            end_idx = start_idx + per_page
            episodes_page = all_episodes[start_idx:end_idx]
            
            # Format episodes for response
            formatted_episodes = []
            for episode in episodes_page:
                try:
                    # Format thumbnail URL properly for the image proxy
                    thumb_url = None
                    if hasattr(episode, 'thumb') and episode.thumb:
                        # Manually construct relative URL to avoid url_for issues with external hosts
                        thumb_url = f"/admin/api/v2/media/plex/images/proxy?path={episode.thumb.lstrip('/')}"
                    elif hasattr(episode, 'art') and episode.art:
                        # Fallback to art if thumb is not available
                        thumb_url = f"/admin/api/v2/media/plex/images/proxy?path={episode.art.lstrip('/')}"
                    
                    # Extract year from originallyAvailableAt
                    year = None
                    if hasattr(episode, 'originallyAvailableAt') and episode.originallyAvailableAt:
                        try:
                            year = str(episode.originallyAvailableAt).split('-')[0]
                        except:
                            year = None
                    elif hasattr(episode, 'year') and episode.year:
                        year = str(episode.year)
                    
                    # Extract media ID from episode's media array (same logic as movies)
                    episode_media_id = None
                    if hasattr(episode, 'media') and episode.media:
                        first_media = episode.media[0]
                        if hasattr(first_media, 'id'):
                            episode_media_id = str(first_media.id)
                    
                    # For episodes, always use ratingKey to ensure uniqueness (media_id can be the same for episodes of the same show)
                    episode_external_id = str(episode.ratingKey)
                    
                    episode_data = {
                        'id': episode_external_id,
                        'title': episode.title or 'Unknown Episode',
                        'summary': episode.summary or '',
                        'year': year,
                        'rating': float(episode.rating) if hasattr(episode, 'rating') and episode.rating else None,
                        'duration': episode.duration if hasattr(episode, 'duration') and episode.duration else None,
                        'thumb': thumb_url,
                        'season_number': episode.seasonNumber if hasattr(episode, 'seasonNumber') else None,
                        'episode_number': episode.episodeNumber if hasattr(episode, 'episodeNumber') else None,
                        'air_date': episode.originallyAvailableAt if hasattr(episode, 'originallyAvailableAt') else None,
                        'added_at': episode.addedAt if hasattr(episode, 'addedAt') else None,
                        'type': 'episode',
                        'raw_data': {
                            'ratingKey': episode.ratingKey,
                            'media_id': episode_media_id,
                            'external_id_type': 'ratingKey',  # Episodes always use ratingKey for uniqueness
                            'seasonNumber': episode.seasonNumber if hasattr(episode, 'seasonNumber') else None,
                            'episodeNumber': episode.episodeNumber if hasattr(episode, 'episodeNumber') else None,
                            'season_number': episode.seasonNumber if hasattr(episode, 'seasonNumber') else None,
                            'episode_number': episode.episodeNumber if hasattr(episode, 'episodeNumber') else None
                        }
                    }
                    formatted_episodes.append(episode_data)
                except Exception as e:
                    self.log_warning(f"Error formatting episode {episode.title}: {e}")
                    continue
            
            self.log_info(f"Retrieved {len(formatted_episodes)} episodes from Plex show (page {page}/{total_pages})")
            
            return {
                'items': formatted_episodes,
                'total': total_episodes,
                'page': page,
                'per_page': per_page,
                'pages': total_pages,
                'has_prev': page > 1,
                'has_next': page < total_pages
            }
            
        except Exception as e:
            self.log_error(f"Error getting show episodes: {e}")
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
        """Get GeoIP information for a given IP address using Plex's API."""
        current_app.logger.debug(f"GeoIP lookup requested for IP: {ip_address}")
        
        if not ip_address or ip_address in ['127.0.0.1', 'localhost']:
            current_app.logger.debug(f"Local IP detected: {ip_address}")
            return {"error": "This is a local address - no GeoIP data available"}

        if not self.api_key:
            current_app.logger.error("Plex API key is missing, cannot perform GeoIP lookup.")
            return {"error": "Plex API key is not configured"}

        try:
            headers = {'X-Plex-Token': self.api_key}
            url = f"https://plex.tv/api/v2/geoip?ip_address={ip_address}"
            current_app.logger.debug(f"Making GeoIP request to: {url}")
            current_app.logger.debug(f"Request headers: {headers}")
            
            timeout = get_api_timeout()
            response = requests.get(url, headers=headers, timeout=timeout)
            current_app.logger.debug(f"Response status code: {response.status_code}")
            current_app.logger.debug(f"Response content: {response.content}")
            current_app.logger.debug(f"Response headers: {response.headers}")
            
            response.raise_for_status()
            
            # Parse the XML response using built-in ElementTree
            current_app.logger.debug("Attempting to parse XML response")
            root = ET.fromstring(response.content)
            current_app.logger.debug(f"XML root tag: {root.tag}")
            
            # Extract data from XML attributes (not child elements)
            geoip_data = dict(root.attrib)
            current_app.logger.debug(f"XML attributes: {root.attrib}")
            
            # Split coordinates into separate latitude and longitude fields
            if 'coordinates' in geoip_data:
                coords = geoip_data['coordinates'].split(', ')
                if len(coords) == 2:
                    geoip_data['latitude'] = coords[0].strip()
                    geoip_data['longitude'] = coords[1].strip()
                    current_app.logger.debug(f"Split coordinates: lat={geoip_data['latitude']}, lon={geoip_data['longitude']}")
            
            current_app.logger.debug(f"Final GeoIP data: {geoip_data}")
            return geoip_data
            
        except requests.exceptions.RequestException as e:
            current_app.logger.error(f"Failed to get GeoIP info from Plex API for {ip_address}: {e}")
            return {"error": f"Network error: {str(e)}"}
        except ET.ParseError as e:
            current_app.logger.error(f"Failed to parse XML response from Plex API: {e}")
            current_app.logger.error(f"Raw response content: {response.content}")
            return {"error": "Invalid response format from Plex API"}
        except Exception as e:
            current_app.logger.error(f"An unexpected error occurred during GeoIP lookup: {e}", exc_info=True)
            return {"error": "An unexpected error occurred"}
    
    def check_username_exists(self, username: str) -> bool:
        """Check if a username already exists in Plex (not applicable for Plex OAuth)"""
        # Plex uses OAuth authentication, so username conflicts don't apply
        # Always return False since Plex handles user authentication externally
        return False
