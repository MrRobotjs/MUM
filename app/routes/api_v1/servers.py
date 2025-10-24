
from uuid import uuid4

from flask import jsonify, request, current_app
from flask_login import login_required

from app.routes.api_v1 import bp
from app.services.media_service_manager import MediaServiceManager
from app.services.media_service_factory import MediaServiceFactory
from app.utils.helpers import permission_required
from app.models_media_services import ServiceType, MediaServer, MediaLibrary
from app.extensions import db
from datetime import datetime


def _serialize_server(server, include_status=False):
    websocket_refresh_interval = 30
    if isinstance(server.config, dict):
        try:
            websocket_refresh_interval = int(server.config.get('websocket_refresh_interval', 30))
        except (TypeError, ValueError):
            websocket_refresh_interval = 30

    data = {
        'id': server.id,
        'server_nickname': server.server_nickname,
        'server_name': server.server_name,
        'service_type': server.service_type.value,
        'url': server.url,
        'public_url': server.public_url,
        'is_active': server.is_active,
        'overseerr_enabled': server.overseerr_enabled,
        'overseerr_url': server.overseerr_url,
        'last_status': server.last_status,
        'last_status_check': server.last_status_check.isoformat() if server.last_status_check else None,
        'last_version': server.last_version,
        'last_sync_at': server.last_sync_at.isoformat() if server.last_sync_at else None,
        'websocket_refresh_interval': websocket_refresh_interval,
    }
    if include_status:
        status = {}
        try:
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                status = service.get_server_info() or {}
        except Exception as exc:
            status = {
                'online': False,
                'error': str(exc)
            }
        data['status'] = status
    return data


@bp.route('/servers', methods=['GET'])
@login_required
@permission_required('view_servers')
def list_servers():
    request_id = str(uuid4())
    include_status = request.args.get('include_status', 'false').lower() == 'true'
    active_only_param = request.args.get('active_only')
    if active_only_param is None:
        active_only = False
    else:
        active_only = active_only_param.lower() != 'false'

    service_type_param = request.args.get('service_type')
    servers_query = MediaServiceManager.get_all_servers(active_only=active_only)

    if service_type_param:
        try:
            service_type_enum = ServiceType(service_type_param.lower())
            servers_query = [server for server in servers_query if server.service_type == service_type_enum]
        except ValueError:
            servers_query = []

    servers = servers_query
    return jsonify({
        'data': [_serialize_server(server, include_status) for server in servers],
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'filters': {
                'include_status': include_status,
                'active_only': active_only,
                'service_type': service_type_param
            },
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/servers/<int:server_id>', methods=['GET'])
@login_required
@permission_required('view_servers')
def get_server(server_id):
    """Get a single server by ID with optional status check"""
    request_id = str(uuid4())
    server = MediaServer.query.get(server_id)

    if not server:
        return jsonify({
            'error': {
                'code': 'SERVER_NOT_FOUND',
                'message': f'Server with ID {server_id} not found',
                'details': {'server_id': server_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    include_status = request.args.get('include_status', 'false').lower() == 'true'
    include_libraries = request.args.get('include_libraries', 'false').lower() == 'true'

    data = _serialize_server(server, include_status)

    if include_libraries:
        data['libraries'] = [{
            'id': lib.id,
            'internal_id': lib.internal_id,
            'external_id': lib.external_id,
            'name': lib.name,
            'library_type': lib.library_type,
            'item_count': lib.item_count,
            'last_scanned': lib.last_scanned.isoformat() if lib.last_scanned else None
        } for lib in server.libraries]

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/servers', methods=['POST'])
@login_required
@permission_required('manage_servers')
def create_server():
    """Create a new media server"""
    request_id = str(uuid4())
    data = request.get_json()

    if not data:
        return jsonify({
            'error': {
                'code': 'INVALID_REQUEST',
                'message': 'Request body must be JSON',
                'hint': 'Ensure Content-Type header is application/json'
            },
            'meta': {'request_id': request_id}
        }), 400

    # Validate required fields
    required_fields = ['server_nickname', 'service_type', 'url']
    missing_fields = [field for field in required_fields if not data.get(field)]

    if missing_fields:
        return jsonify({
            'error': {
                'code': 'VALIDATION_ERROR',
                'message': 'Missing required fields',
                'details': {'missing_fields': missing_fields}
            },
            'meta': {'request_id': request_id}
        }), 422

    # Check if server_nickname already exists
    existing = MediaServer.query.filter_by(server_nickname=data['server_nickname']).first()
    if existing:
        return jsonify({
            'error': {
                'code': 'DUPLICATE_SERVER_NICKNAME',
                'message': f'Server with nickname "{data["server_nickname"]}" already exists',
                'details': {'server_nickname': data['server_nickname']},
                'hint': 'Choose a unique nickname for this server'
            },
            'meta': {'request_id': request_id}
        }), 409

    # Validate service_type
    try:
        service_type_enum = ServiceType(data['service_type'].lower())
    except ValueError:
        valid_types = [st.value for st in ServiceType]
        return jsonify({
            'error': {
                'code': 'INVALID_SERVICE_TYPE',
                'message': f'Invalid service_type: {data["service_type"]}',
                'details': {'valid_types': valid_types}
            },
            'meta': {'request_id': request_id}
        }), 422

    websocket_refresh_interval = data.get('websocket_refresh_interval', 30)
    if service_type_enum == ServiceType.PLEX:
        try:
            websocket_refresh_interval = int(websocket_refresh_interval)
        except (TypeError, ValueError):
            return jsonify({
                'error': {
                    'code': 'INVALID_WEBSOCKET_INTERVAL',
                    'message': 'WebSocket refresh interval must be an integer.'
                },
                'meta': {'request_id': request_id}
            }), 400

        if websocket_refresh_interval < 2 or websocket_refresh_interval > 300:
            return jsonify({
                'error': {
                    'code': 'WEBSOCKET_INTERVAL_OUT_OF_RANGE',
                    'message': 'WebSocket refresh interval must be between 2 and 300 seconds.'
                },
                'meta': {'request_id': request_id}
            }), 400
    else:
        websocket_refresh_interval = None

    config_payload = data.get('config')
    if not isinstance(config_payload, dict):
        config_payload = {}

    if service_type_enum == ServiceType.PLEX and websocket_refresh_interval is not None:
        config_payload = {**config_payload, 'websocket_refresh_interval': websocket_refresh_interval}
    elif service_type_enum != ServiceType.PLEX and isinstance(config_payload, dict):
        config_payload.pop('websocket_refresh_interval', None)

    # Create server
    server = MediaServer(
        server_nickname=data['server_nickname'],
        server_name=data.get('server_name'),
        service_type=service_type_enum,
        url=data['url'],
        api_key=data.get('api_key'),
        username=data.get('username'),
        password=data.get('password'),
        public_url=data.get('public_url'),
        overseerr_enabled=data.get('overseerr_enabled', False),
        overseerr_url=data.get('overseerr_url'),
        overseerr_api_key=data.get('overseerr_api_key'),
        config=config_payload,
        is_active=data.get('is_active', True)
    )

    try:
        db.session.add(server)
        db.session.commit()

        return jsonify({
            'data': _serialize_server(server, include_status=False),
            'meta': {
                'request_id': request_id,
                'deprecated': False,
                'generated_at': datetime.utcnow().isoformat() + 'Z'
            }
        }), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'error': {
                'code': 'SERVER_CREATION_FAILED',
                'message': 'Failed to create server',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/servers/<int:server_id>', methods=['PATCH'])
@login_required
@permission_required('manage_servers')
def update_server(server_id):
    """Update an existing media server"""
    request_id = str(uuid4())
    server = MediaServer.query.get(server_id)

    if not server:
        return jsonify({
            'error': {
                'code': 'SERVER_NOT_FOUND',
                'message': f'Server with ID {server_id} not found',
                'details': {'server_id': server_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    data = request.get_json()
    if not data:
        return jsonify({
            'error': {
                'code': 'INVALID_REQUEST',
                'message': 'Request body must be JSON',
                'hint': 'Ensure Content-Type header is application/json'
            },
            'meta': {'request_id': request_id}
        }), 400

    # Check for nickname conflicts if changing nickname
    if 'server_nickname' in data and data['server_nickname'] != server.server_nickname:
        existing = MediaServer.query.filter_by(server_nickname=data['server_nickname']).first()
        if existing:
            return jsonify({
                'error': {
                    'code': 'DUPLICATE_SERVER_NICKNAME',
                    'message': f'Server with nickname "{data["server_nickname"]}" already exists',
                    'details': {'server_nickname': data['server_nickname']}
                },
                'meta': {'request_id': request_id}
            }), 409

    # Update fields
    updatable_fields = [
        'server_nickname', 'server_name', 'url', 'api_key', 'username',
        'password', 'public_url', 'overseerr_enabled', 'overseerr_url',
        'overseerr_api_key', 'config', 'is_active'
    ]

    for field in updatable_fields:
        if field in data:
            setattr(server, field, data[field])

    # Handle service_type separately (needs enum conversion)
    if 'service_type' in data:
        try:
            server.service_type = ServiceType(data['service_type'].lower())
        except ValueError:
            valid_types = [st.value for st in ServiceType]
            return jsonify({
                'error': {
                    'code': 'INVALID_SERVICE_TYPE',
                    'message': f'Invalid service_type: {data["service_type"]}',
                    'details': {'valid_types': valid_types}
                },
                'meta': {'request_id': request_id}
            }), 422

    # Ensure config is a dict we can mutate
    if not isinstance(server.config, dict):
        server.config = {}

    if 'websocket_refresh_interval' in data or server.service_type == ServiceType.PLEX:
        websocket_interval_value = data.get('websocket_refresh_interval')
        if websocket_interval_value is not None:
            try:
                websocket_interval_value = int(websocket_interval_value)
            except (TypeError, ValueError):
                return jsonify({
                    'error': {
                        'code': 'INVALID_WEBSOCKET_INTERVAL',
                        'message': 'WebSocket refresh interval must be an integer.'
                    },
                    'meta': {'request_id': request_id}
                }), 400

            if websocket_interval_value < 2 or websocket_interval_value > 300:
                return jsonify({
                    'error': {
                        'code': 'WEBSOCKET_INTERVAL_OUT_OF_RANGE',
                        'message': 'WebSocket refresh interval must be between 2 and 300 seconds.'
                    },
                    'meta': {'request_id': request_id}
                }), 400

            if server.service_type == ServiceType.PLEX:
                server.config['websocket_refresh_interval'] = websocket_interval_value
        elif 'websocket_refresh_interval' not in server.config and server.service_type == ServiceType.PLEX:
            server.config['websocket_refresh_interval'] = 30

    if server.service_type != ServiceType.PLEX:
        server.config.pop('websocket_refresh_interval', None)

    server.updated_at = datetime.utcnow()

    try:
        db.session.commit()

        return jsonify({
            'data': _serialize_server(server, include_status=False),
            'meta': {
                'request_id': request_id,
                'deprecated': False,
                'generated_at': datetime.utcnow().isoformat() + 'Z'
            }
        })
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'error': {
                'code': 'SERVER_UPDATE_FAILED',
                'message': 'Failed to update server',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/servers/<int:server_id>', methods=['DELETE'])
@login_required
@permission_required('manage_servers')
def delete_server(server_id):
    """Delete a media server and its associated users"""
    request_id = str(uuid4())
    server = MediaServer.query.get(server_id)

    if not server:
        return jsonify({
            'error': {
                'code': 'SERVER_NOT_FOUND',
                'message': f'Server with ID {server_id} not found',
                'details': {'server_id': server_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    server_data = _serialize_server(server, include_status=False)

    try:
        from app.models import User
        from app.models_media_services import MediaItem, MediaStreamHistory
        from sqlalchemy import inspect
        from sqlalchemy.exc import OperationalError

        # Check if overseerr_user_links table exists
        inspector = inspect(db.engine)
        table_names = inspector.get_table_names()
        has_overseerr_table = 'overseerr_user_links' in table_names

        # Get counts for response
        users_count = User.query.filter_by(server_id=server_id).count()
        libraries_count = len(server.libraries)
        items_count = MediaItem.query.filter_by(server_id=server_id).count()
        stream_history_count = MediaStreamHistory.query.filter_by(server_id=server_id).count()

        # Delete Overseerr links if table exists
        overseerr_links_count = 0
        if has_overseerr_table:
            try:
                from app.models_overseerr import OverseerrUserLink
                overseerr_links_count = OverseerrUserLink.query.filter_by(server_id=server_id).count()
                OverseerrUserLink.query.filter_by(server_id=server_id).delete()
            except Exception as e:
                current_app.logger.warning(f"Failed to delete overseerr links: {str(e)}")
        else:
            current_app.logger.debug("overseerr_user_links table doesn't exist yet, skipping")

        # Delete all associated records in the correct order
        # 1. Delete stream history (depends on server)
        MediaStreamHistory.query.filter_by(server_id=server_id).delete()

        # 2. Delete media items (depends on server and library)
        MediaItem.query.filter_by(server_id=server_id).delete()

        # 3. Delete associated service users (depends on server)
        # Note: This only deletes service users, not local admins
        User.query.filter_by(server_id=server_id).delete()

        # 4. Delete the server (libraries will cascade delete automatically)
        # Use expunge to remove server from session to avoid lazy loading relationships
        db.session.expunge(server)

        # Delete server directly via raw SQL to avoid relationship loading
        db.session.execute(
            db.text("DELETE FROM media_servers WHERE id = :server_id"),
            {"server_id": server_id}
        )

        db.session.commit()

        return jsonify({
            'data': {
                'success': True,
                'deleted_server': server_data,
                'deleted_users_count': users_count,
                'deleted_libraries_count': libraries_count,
                'deleted_items_count': items_count,
                'deleted_stream_history_count': stream_history_count,
                'deleted_overseerr_links_count': overseerr_links_count
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False,
                'generated_at': datetime.utcnow().isoformat() + 'Z'
            }
        })
    except Exception as e:
        db.session.rollback()
        import traceback
        error_trace = traceback.format_exc()
        current_app.logger.error(f"Failed to delete server {server_id}: {str(e)}")
        current_app.logger.error(f"Traceback: {error_trace}")
        return jsonify({
            'error': {
                'code': 'SERVER_DELETION_FAILED',
                'message': 'Failed to delete server',
                'details': {'error': str(e), 'traceback': error_trace}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/servers/<int:server_id>/sync-libraries', methods=['POST'])
@login_required
@permission_required('manage_servers')
def sync_server_libraries(server_id):
    """Sync libraries from a media server"""
    request_id = str(uuid4())
    server = MediaServer.query.get(server_id)

    if not server:
        return jsonify({
            'error': {
                'code': 'SERVER_NOT_FOUND',
                'message': f'Server with ID {server_id} not found',
                'details': {'server_id': server_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    try:
        # Use MediaServiceManager to sync libraries
        result = MediaServiceManager.sync_server_libraries(server_id)

        return jsonify({
            'data': {
                'success': True,
                'server_id': server_id,
                'libraries_synced': result.get('libraries_count', 0),
                'message': result.get('message', 'Libraries synced successfully')
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False,
                'generated_at': datetime.utcnow().isoformat() + 'Z'
            }
        })
    except Exception as e:
        return jsonify({
            'error': {
                'code': 'LIBRARY_SYNC_FAILED',
                'message': 'Failed to sync libraries',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/servers/<int:server_id>/sync-users', methods=['POST'])
@login_required
@permission_required('manage_servers')
def sync_server_users(server_id):
    """Sync users from a media server"""
    request_id = str(uuid4())
    server = MediaServer.query.get(server_id)

    if not server:
        return jsonify({
            'error': {
                'code': 'SERVER_NOT_FOUND',
                'message': f'Server with ID {server_id} not found',
                'details': {'server_id': server_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    try:
        # Use MediaServiceManager to sync users
        result = MediaServiceManager.sync_server_users(server_id)

        return jsonify({
            'data': {
                'success': True,
                'server_id': server_id,
                'users_synced': result.get('users_count', 0),
                'message': result.get('message', 'Users synced successfully')
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False,
                'generated_at': datetime.utcnow().isoformat() + 'Z'
            }
        })
    except Exception as e:
        return jsonify({
            'error': {
                'code': 'USER_SYNC_FAILED',
                'message': 'Failed to sync users',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/servers/<int:server_id>/test', methods=['POST'])
@login_required
@permission_required('manage_servers')
def test_server_connection(server_id):
    """Test connection to a media server"""
    request_id = str(uuid4())
    server = MediaServer.query.get(server_id)

    if not server:
        return jsonify({
            'error': {
                'code': 'SERVER_NOT_FOUND',
                'message': f'Server with ID {server_id} not found',
                'details': {'server_id': server_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    try:
        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return jsonify({
                'error': {
                    'code': 'SERVICE_CREATION_FAILED',
                    'message': 'Failed to create service instance',
                    'details': {'server_id': server_id}
                },
                'meta': {'request_id': request_id}
            }), 500

        # Test connection
        server_info = service.get_server_info()

        if server_info and server_info.get('online'):
            return jsonify({
                'data': {
                    'success': True,
                    'online': True,
                    'server_info': server_info,
                    'message': 'Connection successful'
                },
                'meta': {
                    'request_id': request_id,
                    'deprecated': False,
                    'generated_at': datetime.utcnow().isoformat() + 'Z'
                }
            })
        else:
            return jsonify({
                'data': {
                    'success': False,
                    'online': False,
                    'server_info': server_info,
                    'message': 'Server is offline or unreachable'
                },
                'meta': {
                    'request_id': request_id,
                    'deprecated': False,
                    'generated_at': datetime.utcnow().isoformat() + 'Z'
                }
            })
    except Exception as e:
        return jsonify({
            'error': {
                'code': 'CONNECTION_TEST_FAILED',
                'message': 'Failed to test server connection',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500
