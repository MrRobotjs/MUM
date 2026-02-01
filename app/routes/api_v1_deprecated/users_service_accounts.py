
from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required

from app.routes.api_v1_deprecated import bp
from app.models import User, UserType
from app.extensions import db
from app.utils.helpers import permission_required


def _serialize_service_account(account: User):
    return {
        'uuid': account.uuid,
        'service_type': account.server.service_type.value if account.server else None,
        'server_name': account.server.server_nickname if account.server else None,
        'external_username': account.external_username,
        'external_email': account.external_email,
        'linked_at': account.created_at.isoformat() if account.created_at else None
    }


def _get_local_user(uuid: str):
    user = User.query.filter_by(uuid=uuid).first_or_404()
    if user.userType not in {UserType.LOCAL, UserType.OWNER}:
        from flask import abort
        abort(400, description='Service accounts can only be linked to local/admin users.')
    return user


@bp.route('/users/<string:user_uuid>/service-accounts', methods=['GET'])
@login_required
@permission_required('edit_user')
def list_service_accounts(user_uuid):
    request_id = str(uuid4())
    user = _get_local_user(user_uuid)
    accounts = getattr(user, 'linked_children', []) or []
    data = [_serialize_service_account(account) for account in accounts if account.userType == UserType.SERVICE]
    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200


@bp.route('/users/<string:user_uuid>/service-accounts', methods=['POST'])
@login_required
@permission_required('edit_user')
def link_service_account(user_uuid):
    request_id = str(uuid4())
    user = _get_local_user(user_uuid)
    payload = request.get_json() or {}
    service_uuid = payload.get('service_uuid')
    if not service_uuid:
        return jsonify({
            'error': {
                'code': 'MISSING_SERVICE_UUID',
                'message': 'service_uuid is required.'
            },
            'meta': {'request_id': request_id}
        }), 400

    service_user = User.query.filter_by(uuid=service_uuid, userType=UserType.SERVICE).first()
    if not service_user:
        return jsonify({
            'error': {
                'code': 'SERVICE_USER_NOT_FOUND',
                'message': 'Service account not found.'
            },
            'meta': {'request_id': request_id}
        }), 404

    if service_user.linkedUserId:
        return jsonify({
            'error': {
                'code': 'SERVICE_USER_ALREADY_LINKED',
                'message': 'Service account is already linked to another user.'
            },
            'meta': {'request_id': request_id}
        }), 409

    service_user.linkedUserId = user.uuid
    db.session.commit()


    return jsonify({
        'data': _serialize_service_account(service_user),
        'meta': {'request_id': request_id}
    }), 200


@bp.route('/users/<string:user_uuid>/service-accounts/<string:service_uuid>', methods=['DELETE'])
@login_required
@permission_required('edit_user')
def unlink_service_account(user_uuid, service_uuid):
    request_id = str(uuid4())
    user = _get_local_user(user_uuid)
    service_user = User.query.filter_by(uuid=service_uuid, userType=UserType.SERVICE).first()
    if not service_user or service_user.linkedUserId != user.uuid:
        return jsonify({
            'error': {
                'code': 'SERVICE_USER_NOT_LINKED',
                'message': 'Service account is not linked to this user.'
            },
            'meta': {'request_id': request_id}
        }), 404

    service_user.linkedUserId = None
    db.session.commit()


    return jsonify({
        'data': {'success': True},
        'meta': {'request_id': request_id}
    }), 200


@bp.route('/users/<string:user_uuid>/available-service-accounts', methods=['GET'])
@login_required
@permission_required('edit_user')
def list_available_service_accounts(user_uuid):
    request_id = str(uuid4())
    user = _get_local_user(user_uuid)

    standalone_users = User.query.filter_by(userType=UserType.SERVICE).filter(
        User.linkedUserId.is_(None)
    ).all()

    data = []
    for service_user in standalone_users:
        data.append({
            'uuid': service_user.uuid,
            'service_type': service_user.server.service_type.value if service_user.server else None,
            'server_name': service_user.server.server_nickname if service_user.server else None,
            'external_username': service_user.external_username,
            'external_email': service_user.external_email,
            'avatar_url': service_user.external_avatar_url,
        })

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200