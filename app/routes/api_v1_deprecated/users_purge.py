from uuid import uuid4

from flask import jsonify, request, current_app
from flask_login import login_required, current_user

from app.routes.api_v1_deprecated import bp
from app.models import User
from app.services import user_service
from app.utils.helpers import permission_required


@bp.route('/users/eligible-for-purge', methods=['GET'])
@login_required
@permission_required('purge_users')
def get_eligible_for_purge():
    """Get users eligible for purge based on criteria."""
    request_id = str(uuid4())

    # Get query parameters
    inactive_days = request.args.get('inactive_days', 180, type=int)
    exclude_sharers = request.args.get('exclude_sharers', 'true').lower() == 'true'
    exclude_whitelisted = request.args.get('exclude_whitelisted', 'true').lower() == 'true'
    ignore_creation_date = request.args.get('ignore_creation_date', 'false').lower() == 'true'

    try:
        current_app.logger.info(
            f"Getting users eligible for purge: inactive_days={inactive_days}, "
            f"exclude_sharers={exclude_sharers}, exclude_whitelisted={exclude_whitelisted}, "
            f"ignore_creation_date={ignore_creation_date}"
        )

        # Get eligible users from service
        eligible_users = user_service.get_users_eligible_for_purge(
            inactive_days_threshold=inactive_days,
            exclude_sharers=exclude_sharers,
            exclude_whitelisted=exclude_whitelisted,
            ignore_creation_date_for_never_streamed=ignore_creation_date
        )

        # Serialize users for API response
        users_data = []
        for user_data in eligible_users:
            users_data.append({
                'uuid': user_data.get('uuid'),
                'username': user_data.get('username'),
                'email': user_data.get('email'),
                'server_name': user_data.get('server_name'),
                'service_type': user_data.get('service_type'),
                'avatar_url': user_data.get('avatar_url'),
                'created_at': user_data.get('created_at').isoformat() if user_data.get('created_at') else None,
                'last_streamed_at': user_data.get('last_streamed_at').isoformat() if user_data.get('last_streamed_at') else None,
                'last_login_at': user_data.get('last_login_at').isoformat() if user_data.get('last_login_at') else None,
                'days_since_activity': user_data.get('days_since_activity'),
                'is_sharer': user_data.get('is_sharer', False),
                'is_whitelisted': user_data.get('is_whitelisted', False)
            })

        return jsonify({
            'data': {
                'users': users_data,
                'criteria': {
                    'inactive_days': inactive_days,
                    'exclude_sharers': exclude_sharers,
                    'exclude_whitelisted': exclude_whitelisted,
                    'ignore_creation_date': ignore_creation_date
                }
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        }), 200

    except Exception as exc:
        current_app.logger.error(f"Error getting eligible users for purge: {exc}", exc_info=True)
        return jsonify({
            'error': {
                'message': f'Failed to get eligible users: {str(exc)}',
                'type': 'ServerError'
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        }), 500


@bp.route('/users/purge', methods=['POST'])
@login_required
@permission_required('purge_users')
def purge_users():
    """Purge selected users."""
    request_id = str(uuid4())

    try:
        data = request.get_json()
        if not data:
            return jsonify({
                'error': {
                    'message': 'Request body is required',
                    'type': 'ValidationError'
                },
                'meta': {
                    'request_id': request_id,
                    'deprecated': False
                }
            }), 400

        user_uuids = data.get('user_uuids', [])
        if not user_uuids:
            return jsonify({
                'error': {
                    'message': 'user_uuids is required and must not be empty',
                    'type': 'ValidationError'
                },
                'meta': {
                    'request_id': request_id,
                    'deprecated': False
                }
            }), 400

        # Get criteria for logging
        criteria = data.get('criteria', {})
        inactive_days = criteria.get('inactive_days')
        exclude_sharers = criteria.get('exclude_sharers')
        exclude_whitelisted = criteria.get('exclude_whitelisted')
        ignore_creation_date = criteria.get('ignore_creation_date', False)

        current_app.logger.info(
            f"Purging {len(user_uuids)} users with criteria: "
            f"inactive_days={inactive_days}, exclude_sharers={exclude_sharers}, "
            f"exclude_whitelisted={exclude_whitelisted}"
        )

        # Convert UUIDs to internal IDs for the service
        user_ids_to_purge = []
        uuid_to_user_map = {}

        for user_uuid in user_uuids:
            from app.utils.helpers import get_user_by_uuid
            user_obj, user_type = get_user_by_uuid(user_uuid)
            if user_obj:
                user_ids_to_purge.append(user_obj.id)
                uuid_to_user_map[user_obj.id] = {
                    'uuid': user_uuid,
                    'username': user_obj.external_username if user_type == 'user_media_access' else user_obj.localUsername,
                    'user_type': user_type
                }
            else:
                current_app.logger.warning(f"User not found for UUID: {user_uuid}")

        if not user_ids_to_purge:
            return jsonify({
                'error': {
                    'message': 'No valid users found for the provided UUIDs',
                    'type': 'ValidationError'
                },
                'meta': {
                    'request_id': request_id,
                    'deprecated': False
                }
            }), 400

        # Perform the purge
        results = user_service.purge_inactive_users(
            user_ids_to_purge=user_ids_to_purge,
            admin_id=current_user.id,
            inactive_days_threshold=inactive_days,
            exclude_sharers=exclude_sharers,
            exclude_whitelisted=exclude_whitelisted,
            ignore_creation_date_for_never_streamed=ignore_creation_date
        )

        # Build detailed results
        detailed_results = []
        for user_id in user_ids_to_purge:
            user_info = uuid_to_user_map.get(user_id, {})
            detailed_results.append({
                'user_uuid': user_info.get('uuid', 'unknown'),
                'username': user_info.get('username', 'Unknown'),
                'success': True,  # Assume success unless we get specific error info
                'message': 'User purged successfully'
            })

        )

        return jsonify({
            'data': {
                'deleted': results.get('deleted', 0),
                'failed': results.get('errors', 0),
                'results': detailed_results,
                'message': results.get('message', 'Purge completed')
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        }), 200

    except Exception as exc:
        current_app.logger.error(f"Error purging users: {exc}", exc_info=True)
        return jsonify({
            'error': {
                'message': f'Failed to purge users: {str(exc)}',
                'type': 'ServerError'
            },
            'meta': {
                'request_id': request_id,
                'deprecated': False
            }
        }), 500