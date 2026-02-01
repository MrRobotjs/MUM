from datetime import datetime, timedelta
from uuid import uuid4

from flask import jsonify, request, current_app
from flask_login import login_required, current_user

from app.extensions import db
from app.models import User, UserType, EventType
from app.routes.api_v1_deprecated import bp
from app.utils.helpers import permission_required, log_event


def _status_entry(user: User, action: str, status: str, message: str | None = None):
    entry = {
        'user_uuid': user.uuid,
        'username': user.localUsername or user.external_username,
        'action': action,
        'status': status
    }
    if message:
        entry['message'] = message
    return entry


@bp.route('/users/bulk', methods=['POST'])
@login_required
@permission_required('mass_edit_users')
def bulk_user_operations():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    user_uuids = payload.get('user_uuids') or payload.get('users') or []
    operations = payload.get('operations') or []

    if not isinstance(user_uuids, list) or not user_uuids:
        return jsonify({
            'error': {
                'code': 'INVALID_PAYLOAD',
                'message': 'user_uuids must be a non-empty list.'
            },
            'meta': {'request_id': request_id}
        }), 400

    if not isinstance(operations, list) or not operations:
        return jsonify({
            'error': {
                'code': 'INVALID_PAYLOAD',
                'message': 'operations must be a non-empty list.'
            },
            'meta': {'request_id': request_id}
        }), 400

    users = User.query.filter(User.uuid.in_(user_uuids)).all()
    if not users:
        return jsonify({
            'error': {
                'code': 'USERS_NOT_FOUND',
                'message': 'No matching users were found.'
            },
            'meta': {'request_id': request_id}
        }), 404

    results = []
    stats = {
        'updated': 0,
        'deleted': 0,
        'skipped': 0,
        'errors': 0
    }

    actions_executed = [op.get('action') for op in operations if isinstance(op, dict)]

    for user in users:
        deleted = False

        for operation in operations:
            if deleted:
                stats['skipped'] += 1
                results.append(_status_entry(user, operation.get('action', 'unknown'), 'skipped', 'User already deleted in this batch.'))
                continue

            if not isinstance(operation, dict):
                stats['errors'] += 1
                results.append(_status_entry(user, 'unknown', 'error', 'Operation must be a JSON object.'))
                continue

            action = operation.get('action')
            if not action:
                stats['errors'] += 1
                results.append(_status_entry(user, 'unknown', 'error', 'Operation missing "action".'))
                continue

            try:
                if action == 'set_is_active':
                    value = bool(operation.get('value', True))
                    if user.userType == UserType.OWNER and not value:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'Owner account cannot be deactivated.'))
                        continue
                    if user.is_active == value:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'No change required.'))
                        continue
                    user.is_active = value
                    stats['updated'] += 1
                    results.append(_status_entry(user, action, 'updated'))

                elif action == 'update_libraries':
                    library_ids = operation.get('library_ids') or []
                    if user.userType != UserType.SERVICE:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'Libraries can only be set for service accounts.'))
                        continue
                    if not isinstance(library_ids, list):
                        raise ValueError('library_ids must be a list.')
                    user.allowed_library_ids = library_ids
                    stats['updated'] += 1
                    results.append(_status_entry(user, action, 'updated'))

                elif action == 'extend_access':
                    days = operation.get('days')
                    if not isinstance(days, int) or days <= 0:
                        raise ValueError('days must be a positive integer.')
                    base = user.access_expires_at or datetime.utcnow()
                    user.access_expires_at = base + timedelta(days=days)
                    stats['updated'] += 1
                    results.append(_status_entry(user, action, 'updated'))

                elif action == 'set_expiration':
                    expires_at = operation.get('expires_at')
                    if not expires_at:
                        raise ValueError('expires_at is required.')
                    try:
                        parsed = datetime.fromisoformat(expires_at)
                    except ValueError as exc:
                        raise ValueError(f'Invalid ISO datetime: {exc}') from exc
                    user.access_expires_at = parsed
                    stats['updated'] += 1
                    results.append(_status_entry(user, action, 'updated'))

                elif action == 'clear_expiration':
                    user.access_expires_at = None
                    stats['updated'] += 1
                    results.append(_status_entry(user, action, 'updated'))

                elif action == 'add_to_purge_whitelist':
                    if not user.is_purge_whitelisted:
                        user.is_purge_whitelisted = True
                        stats['updated'] += 1
                        results.append(_status_entry(user, action, 'updated'))
                    else:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'User already purged whitelist.'))

                elif action == 'remove_from_purge_whitelist':
                    if user.is_purge_whitelisted:
                        user.is_purge_whitelisted = False
                        stats['updated'] += 1
                        results.append(_status_entry(user, action, 'updated'))
                    else:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'User not in purge whitelist.'))

                elif action == 'add_to_bot_whitelist':
                    if not user.is_discord_bot_whitelisted:
                        user.is_discord_bot_whitelisted = True
                        stats['updated'] += 1
                        results.append(_status_entry(user, action, 'updated'))
                    else:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'User already in bot whitelist.'))

                elif action == 'remove_from_bot_whitelist':
                    if user.is_discord_bot_whitelisted:
                        user.is_discord_bot_whitelisted = False
                        stats['updated'] += 1
                        results.append(_status_entry(user, action, 'updated'))
                    else:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'User not in bot whitelist.'))

                elif action == 'allow_downloads':
                    value = bool(operation.get('value', True))
                    if user.userType != UserType.SERVICE:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'Downloads flag applies to service users only.'))
                        continue
                    if user.allow_downloads == value:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'No change required.'))
                        continue
                    user.allow_downloads = value
                    stats['updated'] += 1
                    results.append(_status_entry(user, action, 'updated'))

                elif action == 'delete_users':
                    if user.userType == UserType.OWNER:
                        stats['skipped'] += 1
                        results.append(_status_entry(user, action, 'skipped', 'Owner account cannot be deleted.'))
                        continue

                    if user.userType == UserType.LOCAL:
                        for child in getattr(user, 'linked_children', []) or []:
                            child.linkedUserId = None

                    db.session.delete(user)
                    deleted = True
                    stats['deleted'] += 1
                    results.append(_status_entry(user, action, 'deleted'))

                else:
                    stats['skipped'] += 1
                    results.append(_status_entry(user, action, 'skipped', 'Unsupported action.'))

            except Exception as exc:
                current_app.logger.error(f"Bulk user action '{action}' failed for {user.uuid}: {exc}", exc_info=True)
                stats['errors'] += 1
                results.append(_status_entry(user, action, 'error', str(exc)))

    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to commit bulk user operations: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({
            'error': {
                'code': 'BULK_UPDATE_FAILED',
                'message': 'Database error while applying bulk operations.'
            },
            'meta': {'request_id': request_id}
        }), 500

    log_event(
        EventType.SETTING_CHANGE,
        f"Bulk user operations executed ({', '.join(actions_executed)}). "
        f"Updated: {stats['updated']}, Deleted: {stats['deleted']}, Skipped: {stats['skipped']}, Errors: {stats['errors']}.",
        admin_id=getattr(current_user, 'id', None)
    )

    return jsonify({
        'data': {
            'summary': stats,
            'results': results
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200
