
from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required

from app.routes.api_v1 import bp
from app.utils.helpers import permission_required
from app.models import UserRole, User
from app.extensions import db
from datetime import datetime


def _serialize_user_role(role, include_users=False):
    """Serialize a UserRole object to JSON"""
    data = {
        'id': role.id,
        'name': role.name,
        'description': role.description,
        'color': role.color,
        'icon': role.icon,
        'created_at': role.created_at.isoformat() if role.created_at else None,
        'updated_at': role.updated_at.isoformat() if role.updated_at else None
    }

    if include_users:
        users = UserRole.get_users_with_role(role.id)
        data['users'] = [{
            'uuid': user.uuid,
            'username': user.get_display_name(),
            'user_type': user.userType.value
        } for user in users]
        data['user_count'] = len(users)

    return data


@bp.route('/user-roles', methods=['GET'])
@login_required
@permission_required('view_users')
def list_user_roles():
    """List all user (visual) roles with optional filtering"""
    request_id = str(uuid4())

    include_users = request.args.get('include_users', 'false').lower() == 'true'

    # Get all roles ordered by name
    roles = UserRole.query.order_by(UserRole.name).all()

    return jsonify({
        'data': [_serialize_user_role(role, include_users) for role in roles],
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'total_count': len(roles),
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/user-roles/<role_id>', methods=['GET'])
@login_required
@permission_required('view_users')
def get_user_role(role_id):
    """Get a single user role by ID"""
    request_id = str(uuid4())
    role = UserRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'User role with ID {role_id} not found',
                'details': {'role_id': role_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    include_users = request.args.get('include_users', 'true').lower() == 'true'
    data = _serialize_user_role(role, include_users)

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/user-roles', methods=['POST'])
@login_required
@permission_required('manage_users')
def create_user_role():
    """Create a new user (visual) role"""
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
    if not data.get('name'):
        return jsonify({
            'error': {
                'code': 'VALIDATION_ERROR',
                'message': 'Missing required field: name',
                'details': {'missing_fields': ['name']}
            },
            'meta': {'request_id': request_id}
        }), 422

    # Check if role name already exists
    existing = UserRole.query.filter_by(name=data['name']).first()
    if existing:
        return jsonify({
            'error': {
                'code': 'DUPLICATE_ROLE_NAME',
                'message': f'User role with name "{data["name"]}" already exists',
                'details': {'name': data['name']},
                'hint': 'Choose a unique name for this role'
            },
            'meta': {'request_id': request_id}
        }), 409

    # Create role
    role = UserRole(
        name=data['name'],
        description=data.get('description'),
        color=data.get('color', '#808080'),
        icon=data.get('icon')
    )

    try:
        db.session.add(role)
        db.session.commit()

        return jsonify({
            'data': _serialize_user_role(role),
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
                'code': 'ROLE_CREATION_FAILED',
                'message': 'Failed to create user role',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/user-roles/<role_id>', methods=['PATCH'])
@login_required
@permission_required('manage_users')
def update_user_role(role_id):
    """Update an existing user role"""
    request_id = str(uuid4())
    role = UserRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'User role with ID {role_id} not found',
                'details': {'role_id': role_id}
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

    # Check for name conflicts if changing name
    if 'name' in data and data['name'] != role.name:
        existing = UserRole.query.filter_by(name=data['name']).first()
        if existing:
            return jsonify({
                'error': {
                    'code': 'DUPLICATE_ROLE_NAME',
                    'message': f'User role with name "{data["name"]}" already exists',
                    'details': {'name': data['name']}
                },
                'meta': {'request_id': request_id}
            }), 409

    # Update fields
    updatable_fields = ['name', 'description', 'color', 'icon']
    for field in updatable_fields:
        if field in data:
            setattr(role, field, data[field])

    role.updated_at = datetime.utcnow()

    try:
        db.session.commit()

        return jsonify({
            'data': _serialize_user_role(role),
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
                'code': 'ROLE_UPDATE_FAILED',
                'message': 'Failed to update user role',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/user-roles/<role_id>', methods=['DELETE'])
@login_required
@permission_required('manage_users')
def delete_user_role(role_id):
    """Delete a user role"""
    request_id = str(uuid4())
    role = UserRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'User role with ID {role_id} not found',
                'details': {'role_id': role_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    # Check if role has users assigned
    users_with_role = UserRole.get_users_with_role(role.id)
    if users_with_role:
        return jsonify({
            'error': {
                'code': 'ROLE_HAS_USERS',
                'message': f'Cannot delete role that is assigned to {len(users_with_role)} user(s)',
                'details': {'user_count': len(users_with_role)},
                'hint': 'Remove this role from all users before deleting'
            },
            'meta': {'request_id': request_id}
        }), 409

    role_data = _serialize_user_role(role)

    try:
        db.session.delete(role)
        db.session.commit()

        return jsonify({
            'data': {
                'success': True,
                'deleted_role': role_data
            },
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
                'code': 'ROLE_DELETION_FAILED',
                'message': 'Failed to delete user role',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/user-roles/<role_id>/users', methods=['GET'])
@login_required
@permission_required('view_users')
def get_user_role_users(role_id):
    """Get all users assigned to a user role"""
    request_id = str(uuid4())
    role = UserRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'User role with ID {role_id} not found',
                'details': {'role_id': role_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    users = UserRole.get_users_with_role(role.id)

    return jsonify({
        'data': [{
            'uuid': user.uuid,
            'username': user.get_display_name(),
            'user_type': user.userType.value,
            'email': user.get_email(),
            'is_active': user.is_active
        } for user in users],
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'role': {
                'id': role.id,
                'name': role.name
            },
            'total_count': len(users),
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })
