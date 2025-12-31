
from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required, current_user

from app.routes.api_v1 import bp
from app.utils.helpers import permission_required
from app.models import AdminRole, AdminPermission, User
from app.extensions import db
from datetime import datetime


def _serialize_admin_role(role, include_permissions=False, include_users=False):
    """Serialize an AdminRole object to JSON"""
    data = {
        'id': role.id,
        'name': role.name,
        'description': role.description,
        'position': role.position,
        'color': role.color,
        'icon': role.icon,
        'is_staff_role': role.is_staff_role(),
        'is_auto_managed': role.is_auto_managed
    }

    if include_permissions:
        data['permissions'] = [{
            'id': perm.id,
            'name': perm.name,
            'description': perm.description
        } for perm in role.permissions]

    if include_users:
        users = AdminRole.get_users_with_role(role.id)
        data['users'] = [{
            'uuid': user.uuid,
            'username': user.get_display_name(),
            'user_type': user.userType.value
        } for user in users]
        data['user_count'] = len(users)

    return data


@bp.route('/admin-roles', methods=['GET'])
@login_required
@permission_required('manage_roles')
def list_admin_roles():
    """List all admin roles with optional filtering"""
    request_id = str(uuid4())

    include_permissions = request.args.get('include_permissions', 'false').lower() == 'true'
    include_users = request.args.get('include_users', 'false').lower() == 'true'

    # Get all roles ordered by position (descending - highest first)
    roles = AdminRole.query.order_by(AdminRole.position.desc()).all()

    return jsonify({
        'data': [_serialize_admin_role(role, include_permissions, include_users) for role in roles],
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'total_count': len(roles),
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/admin-roles/<role_id>', methods=['GET'])
@login_required
@permission_required('manage_roles')
def get_admin_role(role_id):
    """Get a single admin role by ID"""
    request_id = str(uuid4())
    role = AdminRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'Admin role with ID {role_id} not found',
                'details': {'role_id': role_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    include_permissions = request.args.get('include_permissions', 'true').lower() == 'true'
    include_users = request.args.get('include_users', 'true').lower() == 'true'

    data = _serialize_admin_role(role, include_permissions, include_users)

    return jsonify({
        'data': data,
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/admin-roles', methods=['POST'])
@login_required
@permission_required('manage_roles')
def create_admin_role():
    """Create a new admin role"""
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
    existing = AdminRole.query.filter_by(name=data['name']).first()
    if existing:
        return jsonify({
            'error': {
                'code': 'DUPLICATE_ROLE_NAME',
                'message': f'Admin role with name "{data["name"]}" already exists',
                'details': {'name': data['name']},
                'hint': 'Choose a unique name for this role'
            },
            'meta': {'request_id': request_id}
        }), 409

    # Prevent creating a reserved Staff role when an auto-managed role exists
    if data['name'].lower() == 'staff' and AdminRole.query.filter_by(is_auto_managed=True).first():
        return jsonify({
            'error': {
                'code': 'INVALID_ROLE_NAME',
                'message': 'Cannot create a role named "Staff" - it is a system role',
                'hint': 'Choose a different name for this role'
            },
            'meta': {'request_id': request_id}
        }), 422

    # Create role
    role = AdminRole(
        name=data['name'],
        description=data.get('description'),
        position=data.get('position', 0),
        color=data.get('color', '#808080'),
        icon=data.get('icon')
    )

    # Add permissions if provided
    if 'permission_ids' in data and isinstance(data['permission_ids'], list):
        permissions = AdminPermission.query.filter(AdminPermission.id.in_(data['permission_ids'])).all()
        role.permissions = permissions

    try:
        db.session.add(role)
        db.session.commit()

        return jsonify({
            'data': _serialize_admin_role(role, include_permissions=True),
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
                'message': 'Failed to create admin role',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/admin-roles/<role_id>', methods=['PATCH'])
@login_required
@permission_required('manage_roles')
def update_admin_role(role_id):
    """Update an existing admin role"""
    request_id = str(uuid4())
    role = AdminRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'Admin role with ID {role_id} not found',
                'details': {'role_id': role_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    # Check if current user can manage this role (hierarchy check)
    if not current_user.can_manage_role(role):
        return jsonify({
            'error': {
                'code': 'INSUFFICIENT_ROLE_HIERARCHY',
                'message': 'Cannot manage a role with equal or higher position than your own',
                'details': {
                    'your_position': current_user.get_highest_role_position(),
                    'target_position': role.position
                }
            },
            'meta': {'request_id': request_id}
        }), 403

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
        new_name = (data['name'] or '').strip()
        if not new_name:
            return jsonify({
                'error': {
                    'code': 'VALIDATION_ERROR',
                    'message': 'Role name cannot be empty or whitespace'
                },
                'meta': {'request_id': request_id}
            }), 422

        if new_name.lower() == 'staff' and not role.is_auto_managed:
            return jsonify({
                'error': {
                    'code': 'INVALID_ROLE_NAME',
                    'message': 'Cannot rename to "Staff" - it is a system role',
                    'hint': 'Choose a different name'
                },
                'meta': {'request_id': request_id}
            }), 422

        data['name'] = new_name

        existing = AdminRole.query.filter_by(name=new_name).first()
        if existing:
            return jsonify({
                'error': {
                    'code': 'DUPLICATE_ROLE_NAME',
                    'message': f'Admin role with name "{new_name}" already exists',
                    'details': {'name': new_name}
                },
                'meta': {'request_id': request_id}
            }), 409

    # Update fields
    updatable_fields = ['name', 'description', 'position', 'color', 'icon']
    for field in updatable_fields:
        if field in data:
            setattr(role, field, data[field])

    # Update permissions if provided
    if 'permission_ids' in data and isinstance(data['permission_ids'], list):
        permissions = AdminPermission.query.filter(AdminPermission.id.in_(data['permission_ids'])).all()
        role.permissions = permissions

    try:
        db.session.commit()

        return jsonify({
            'data': _serialize_admin_role(role, include_permissions=True),
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
                'message': 'Failed to update admin role',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/admin-roles/<role_id>', methods=['DELETE'])
@login_required
@permission_required('manage_roles')
def delete_admin_role(role_id):
    """Delete an admin role"""
    request_id = str(uuid4())
    role = AdminRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'Admin role with ID {role_id} not found',
                'details': {'role_id': role_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    # Prevent deleting auto-managed roles
    if role.is_auto_managed:
        return jsonify({
            'error': {
                'code': 'CANNOT_DELETE_STAFF_ROLE',
                'message': 'Cannot delete an auto-managed role - it is a system role',
                'hint': 'Auto-managed roles are managed by the system'
            },
            'meta': {'request_id': request_id}
        }), 403

    # Check if current user can manage this role (hierarchy check)
    if not current_user.can_manage_role(role):
        return jsonify({
            'error': {
                'code': 'INSUFFICIENT_ROLE_HIERARCHY',
                'message': 'Cannot delete a role with equal or higher position than your own',
                'details': {
                    'your_position': current_user.get_highest_role_position(),
                    'target_position': role.position
                }
            },
            'meta': {'request_id': request_id}
        }), 403

    # Check if role has users assigned
    users_with_role = AdminRole.get_users_with_role(role.id)
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

    role_data = _serialize_admin_role(role)

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
                'message': 'Failed to delete admin role',
                'details': {'error': str(e)}
            },
            'meta': {'request_id': request_id}
        }), 500


@bp.route('/admin-roles/<role_id>/users', methods=['GET'])
@login_required
@permission_required('manage_roles')
def get_admin_role_users(role_id):
    """Get all users assigned to an admin role"""
    request_id = str(uuid4())
    role = AdminRole.query.get(role_id)

    if not role:
        return jsonify({
            'error': {
                'code': 'ROLE_NOT_FOUND',
                'message': f'Admin role with ID {role_id} not found',
                'details': {'role_id': role_id}
            },
            'meta': {'request_id': request_id}
        }), 404

    users = AdminRole.get_users_with_role(role.id)

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


@bp.route('/admin-permissions', methods=['GET'])
@login_required
@permission_required('manage_roles')
def list_admin_permissions():
    """List all available admin permissions"""
    request_id = str(uuid4())

    permissions = AdminPermission.query.order_by(AdminPermission.name).all()

    return jsonify({
        'data': [{
            'id': perm.id,
            'name': perm.name,
            'description': perm.description
        } for perm in permissions],
        'meta': {
            'request_id': request_id,
            'deprecated': False,
            'total_count': len(permissions),
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })
