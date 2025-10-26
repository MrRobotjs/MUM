from __future__ import annotations

from uuid import uuid4
from datetime import datetime
from flask import jsonify, request
from flask_login import login_required, current_user
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.utils.helpers import permission_required
from app.models import AdminRole, AdminPermission, User
from app.extensions import db


roles_tag = Tag(name="Admin Roles", description="Admin roles and permissions")


class PermissionRef(BaseModel):
    id: str
    name: str | None = None
    description: str | None = None


class RoleRef(BaseModel):
    id: str
    name: str | None = None
    description: str | None = None
    position: int | None = None
    color: str | None = None
    icon: str | None = None
    is_staff_role: bool
    permissions: list[PermissionRef] | None = None
    users: list[dict] | None = None
    user_count: int | None = None


class RolesListResponse(BaseModel):
    data: list[RoleRef]
    meta: dict


def _serialize_admin_role(role, include_permissions=False, include_users=False):
    data = {
        'id': role.id,
        'name': role.name,
        'description': role.description,
        'position': role.position,
        'color': role.color,
        'icon': role.icon,
        'is_staff_role': role.is_staff_role()
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


@api_v2.get(
    "/admin-roles",
    tags=[roles_tag],
    summary="List admin roles",
    responses={200: RolesListResponse},
)
@login_required
@permission_required('manage_roles')
def list_admin_roles():
    request_id = str(uuid4())
    include_permissions = request.args.get('include_permissions', 'false').lower() == 'true'
    include_users = request.args.get('include_users', 'false').lower() == 'true'
    roles = AdminRole.query.order_by(AdminRole.position.desc()).all()
    return jsonify({'data': [_serialize_admin_role(role, include_permissions, include_users) for role in roles], 'meta': {'request_id': request_id, 'deprecated': False, 'total_count': len(roles), 'generated_at': datetime.utcnow().isoformat() + 'Z'}})


class RolePath(BaseModel):
    role_id: str


class RoleResponse(BaseModel):
    data: RoleRef
    meta: dict


@api_v2.get(
    "/admin-roles/<role_id>",
    tags=[roles_tag],
    summary="Get admin role",
    responses={200: RoleResponse, 404: RoleResponse},
)
@login_required
@permission_required('manage_roles')
def get_admin_role(path: RolePath):
    request_id = str(uuid4())
    role = AdminRole.query.get(path.role_id)
    if not role:
        return jsonify({'error': {'code': 'ROLE_NOT_FOUND', 'message': f'Admin role with ID {path.role_id} not found', 'details': {'role_id': path.role_id}}, 'meta': {'request_id': request_id}}), 404
    include_permissions = request.args.get('include_permissions', 'true').lower() == 'true'
    include_users = request.args.get('include_users', 'true').lower() == 'true'
    data = _serialize_admin_role(role, include_permissions, include_users)
    return jsonify({'data': data, 'meta': {'request_id': request_id, 'deprecated': False, 'generated_at': datetime.utcnow().isoformat() + 'Z'}})


class CreateRoleBody(BaseModel):
    name: str
    description: str | None = None
    position: int = 0
    color: str | None = None
    icon: str | None = None
    permissions: list[str] = []


@api_v2.post(
    "/admin-roles",
    tags=[roles_tag],
    summary="Create admin role",
)
@login_required
@permission_required('manage_roles')
def create_admin_role():
    request_id = str(uuid4())
    data = request.get_json()
    if not data:
        return jsonify({'error': {'code': 'INVALID_REQUEST', 'message': 'Request body must be JSON', 'hint': 'Ensure Content-Type header is application/json'}, 'meta': {'request_id': request_id}}), 400
    if not data.get('name'):
        return jsonify({'error': {'code': 'VALIDATION_ERROR', 'message': 'Missing required field: name', 'details': {'missing_fields': ['name']}}, 'meta': {'request_id': request_id}}), 400
    name = data['name'].strip()
    if not name:
        return jsonify({'error': {'code': 'VALIDATION_ERROR', 'message': 'Role name cannot be empty or whitespace'}, 'meta': {'request_id': request_id}}), 400
    if AdminRole.query.filter_by(name=name).first():
        return jsonify({'error': {'code': 'ROLE_NAME_EXISTS', 'message': 'A role with that name already exists'}, 'meta': {'request_id': request_id}}), 409

    position = int(data.get('position', 0))
    color = data.get('color')
    icon = data.get('icon')
    description = data.get('description')
    permission_ids = data.get('permissions', []) or []

    new_role = AdminRole(name=name, description=description, position=position, color=color, icon=icon)
    if permission_ids:
        permissions = AdminPermission.query.filter(AdminPermission.id.in_(permission_ids)).all()
        new_role.permissions = permissions
    db.session.add(new_role)
    db.session.commit()
    return jsonify({'data': _serialize_admin_role(new_role, include_permissions=True, include_users=False), 'meta': {'request_id': request_id}}), 201


class UpdateRoleBody(BaseModel):
    name: str | None = None
    description: str | None = None
    position: int | None = None
    color: str | None = None
    icon: str | None = None
    permissions: list[str] | None = None


@api_v2.patch(
    "/admin-roles/<role_id>",
    tags=[roles_tag],
    summary="Update admin role",
)
@login_required
@permission_required('manage_roles')
def update_admin_role(path: RolePath):
    request_id = str(uuid4())
    role = AdminRole.query.get(path.role_id)
    if not role:
        return jsonify({'error': {'code': 'ROLE_NOT_FOUND', 'message': f'Admin role with ID {path.role_id} not found', 'details': {'role_id': path.role_id}}, 'meta': {'request_id': request_id}}), 404

    data = request.get_json(silent=True) or {}
    if 'name' in data:
        name = (data['name'] or '').strip()
        if not name:
            return jsonify({'error': {'code': 'VALIDATION_ERROR', 'message': 'Role name cannot be empty or whitespace'}, 'meta': {'request_id': request_id}}), 400
        if AdminRole.query.filter(AdminRole.name == name, AdminRole.id != role.id).first():
            return jsonify({'error': {'code': 'ROLE_NAME_EXISTS', 'message': 'A role with that name already exists'}, 'meta': {'request_id': request_id}}), 409
        role.name = name
    if 'description' in data:
        role.description = data['description']
    if 'position' in data:
        role.position = int(data['position'])
    if 'color' in data:
        role.color = data['color']
    if 'icon' in data:
        role.icon = data['icon']
    if 'permissions' in data:
        permission_ids = data.get('permissions') or []
        permissions = AdminPermission.query.filter(AdminPermission.id.in_(permission_ids)).all()
        role.permissions = permissions
    try:
        db.session.commit()
        return jsonify({'data': _serialize_admin_role(role, include_permissions=True, include_users=False), 'meta': {'request_id': request_id}})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': {'code': 'ROLE_UPDATE_FAILED', 'message': 'Failed to update admin role', 'details': {'error': str(e)}}, 'meta': {'request_id': request_id}}), 500


@api_v2.delete(
    "/admin-roles/<role_id>",
    tags=[roles_tag],
    summary="Delete admin role",
)
@login_required
@permission_required('manage_roles')
def delete_admin_role(path: RolePath):
    request_id = str(uuid4())
    role = AdminRole.query.get(path.role_id)
    if not role:
        return jsonify({'error': {'code': 'ROLE_NOT_FOUND', 'message': f'Admin role with ID {path.role_id} not found', 'details': {'role_id': path.role_id}}, 'meta': {'request_id': request_id}}), 404
    if role.is_staff_role():
        return jsonify({'error': {'code': 'CANNOT_DELETE_STAFF_ROLE', 'message': 'Cannot delete the Staff role - it is a system role', 'hint': 'The Staff role is automatically managed'}, 'meta': {'request_id': request_id}}), 403
    if not current_user.can_manage_role(role):
        return jsonify({'error': {'code': 'INSUFFICIENT_ROLE_HIERARCHY', 'message': 'Cannot delete a role with equal or higher position than your own', 'details': {'your_position': current_user.get_highest_role_position(), 'target_position': role.position}}, 'meta': {'request_id': request_id}}), 403
    users_with_role = AdminRole.get_users_with_role(role.id)
    if users_with_role:
        return jsonify({'error': {'code': 'ROLE_HAS_USERS', 'message': f'Cannot delete role that is assigned to {len(users_with_role)} user(s)', 'details': {'user_count': len(users_with_role)}, 'hint': 'Remove this role from all users before deleting'}, 'meta': {'request_id': request_id}}), 409
    role_data = _serialize_admin_role(role)
    try:
        db.session.delete(role)
        db.session.commit()
        return jsonify({'data': {'success': True, 'deleted_role': role_data}, 'meta': {'request_id': request_id, 'deprecated': False, 'generated_at': datetime.utcnow().isoformat() + 'Z'}})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': {'code': 'ROLE_DELETION_FAILED', 'message': 'Failed to delete admin role', 'details': {'error': str(e)}}, 'meta': {'request_id': request_id}}), 500


class RoleUsersResponse(BaseModel):
    data: list[dict]
    meta: dict


@api_v2.get(
    "/admin-roles/<role_id>/users",
    tags=[roles_tag],
    summary="List users assigned to an admin role",
    responses={200: RoleUsersResponse, 404: RoleUsersResponse},
)
@login_required
@permission_required('manage_roles')
def get_admin_role_users(path: RolePath):
    request_id = str(uuid4())
    role = AdminRole.query.get(path.role_id)
    if not role:
        return jsonify({'error': {'code': 'ROLE_NOT_FOUND', 'message': f'Admin role with ID {path.role_id} not found', 'details': {'role_id': path.role_id}}, 'meta': {'request_id': request_id}}), 404
    users = AdminRole.get_users_with_role(role.id)
    return jsonify({'data': [{'uuid': u.uuid, 'username': u.get_display_name(), 'user_type': u.userType.value, 'email': u.get_email(), 'is_active': u.is_active} for u in users], 'meta': {'request_id': request_id, 'deprecated': False, 'role': {'id': role.id, 'name': role.name}, 'total_count': len(users), 'generated_at': datetime.utcnow().isoformat() + 'Z'}})


class PermissionsListResponse(BaseModel):
    data: list[PermissionRef]
    meta: dict


@api_v2.get(
    "/admin-permissions",
    tags=[roles_tag],
    summary="List admin permissions",
    responses={200: PermissionsListResponse},
)
@login_required
@permission_required('manage_roles')
def list_admin_permissions():
    request_id = str(uuid4())
    permissions = AdminPermission.query.order_by(AdminPermission.name).all()
    return jsonify({'data': [{'id': perm.id, 'name': perm.name, 'description': perm.description} for perm in permissions], 'meta': {'request_id': request_id, 'deprecated': False, 'total_count': len(permissions), 'generated_at': datetime.utcnow().isoformat() + 'Z'}})
