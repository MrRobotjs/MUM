from uuid import uuid4

from flask import jsonify, current_app
from flask_login import login_required, current_user

from app.routes.api_v1_deprecated import bp
from app.routes.api_v1_deprecated.sync_status import get_sync_status, start_sync, update_sync_progress, end_sync
from app.models import User, UserType
from app.models_media_services import MediaServer
from app.services.media_service_manager import MediaServiceManager
from app.utils.helpers import permission_required


def _serialize_basic_user(user: User):
    return {
        'uuid': user.uuid,
        'username': user.localUsername or user.external_username,
        'user_type': user.userType.value if hasattr(user.userType, 'value') else str(user.userType),
        'service_account_count': len([child for child in getattr(user, 'linked_children', []) or [] if child.userType == UserType.SERVICE])
    }


@bp.route('/users/sync-all', methods=['POST'])
@login_required
@permission_required('edit_user')
def sync_all_users():
    """Sync users from all enabled media servers."""
    request_id = str(uuid4())

    # Check if sync is already in progress
    current_status = get_sync_status()
    if current_status['is_syncing']:
        return jsonify({
            'error': {
                'code': 'SYNC_IN_PROGRESS',
                'message': f'User sync is already in progress (started by {current_status["started_by_username"]} at {current_status["started_at"]})'
            },
            'meta': {'request_id': request_id}
        }), 409

    # Get all active media servers
    servers = MediaServer.query.filter_by(is_active=True).all()

    if not servers:
        return jsonify({
            'data': {
                'results': [],
                'message': 'No active media servers found.'
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        }), 200

    # Mark sync as started
    start_sync(len(servers))

    results = []
    total_added = 0
    total_updated = 0
    total_removed = 0

    try:
        for idx, server in enumerate(servers, 1):
            # Update progress
            update_sync_progress(idx, len(servers), server.server_nickname)

            try:
                current_app.logger.info(f"Syncing users for server: {server.server_nickname}")
                sync_result = MediaServiceManager.sync_server_users(server.id)
                success = bool(sync_result.get('success'))
                message = sync_result.get('message', 'Sync completed.' if success else 'Sync failed.')

                added = sync_result.get('added', 0)
                updated = sync_result.get('updated', 0)
                removed = sync_result.get('removed', 0)

                total_added += added
                total_updated += updated
                total_removed += removed

                results.append({
                    'server_id': server.id,
                    'server_name': server.server_nickname,
                    'service_type': server.service_type.value if hasattr(server.service_type, 'value') else str(server.service_type),
                    'success': success,
                    'added': added,
                    'updated': updated,
                    'removed': removed,
                    'message': message
                })
            except Exception as exc:
                current_app.logger.error(f"User sync failed for server {server.id} ({server.server_nickname}): {exc}", exc_info=True)
                results.append({
                    'server_id': server.id,
                    'server_name': server.server_nickname,
                    'service_type': server.service_type.value if hasattr(server.service_type, 'value') else str(server.service_type),
                    'success': False,
                    'added': 0,
                    'updated': 0,
                    'removed': 0,
                    'message': str(exc)
                })
    finally:
        # Always end sync status when done
        end_sync()

    )

    return jsonify({
        'data': {
            'results': results,
            'summary': {
                'total_servers': len(servers),
                'successful': sum(1 for r in results if r['success']),
                'failed': sum(1 for r in results if not r['success']),
                'total_added': total_added,
                'total_updated': total_updated,
                'total_removed': total_removed
            }
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200


@bp.route('/users/<string:user_uuid>/sync', methods=['POST'])
@login_required
@permission_required('edit_user')
def sync_user_accounts(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()

    server_ids = set()

    if user.userType == UserType.SERVICE:
        if user.server_id:
            server_ids.add(user.server_id)
    else:
        for child in getattr(user, 'linked_children', []) or []:
            if child.server_id:
                server_ids.add(child.server_id)

    if not server_ids:
        return jsonify({
            'data': {
                'results': [],
                'message': 'No associated media servers to sync.'
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        }), 200

    results = []

    for server_id in server_ids:
        server = MediaServer.query.get(server_id)
        if not server:
            results.append({
                'server_id': server_id,
                'success': False,
                'message': 'Server not found.'
            })
            continue

        try:
            sync_result = MediaServiceManager.sync_server_users(server.id)
            success = bool(sync_result.get('success'))
            message = sync_result.get('message', 'Sync completed.' if success else 'Sync failed.')
            results.append({
                'server_id': server.id,
                'server_name': server.server_nickname,
                'success': success,
                'added': sync_result.get('added'),
                'updated': sync_result.get('updated'),
                'removed': sync_result.get('removed'),
                'message': message
            })
        except Exception as exc:
            current_app.logger.error(f"User sync failed for server {server_id}: {exc}", exc_info=True)
            results.append({
                'server_id': server.id,
                'server_name': server.server_nickname,
                'success': False,
                'message': str(exc)
            })

    )

    return jsonify({
        'data': {
            'results': results,
            'user': _serialize_basic_user(user)
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200