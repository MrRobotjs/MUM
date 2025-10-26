from __future__ import annotations

from uuid import uuid4
from datetime import datetime
from flask import jsonify, request
from flask_login import login_required
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.utils.helpers import permission_required
from app.models import UserRole, User
from app.extensions import db


roles_tag = Tag(name="User Roles", description="Visual user roles")


class UserRoleRef(BaseModel):
    id: str
    name: str | None = None
    description: str | None = None
    color: str | None = None
    icon: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    users: list[dict] | None = None
    user_count: int | None = None


class RolesListResponse(BaseModel):
    data: list[UserRoleRef]
    meta: dict


def _serialize_user_role(role, include_users=False):
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
        data['users'] = [{'uuid': u.uuid, 'username': u.get_display_name(), 'user_type': u.userType.value} for u in users]
        data['user_count'] = len(users)
    return data


@api_v2.get(
    "/user-roles",
    tags=[roles_tag],
    summary="List user roles",
    responses={200: RolesListResponse},
)
@login_required
@permission_required('view_users')
def list_user_roles():
    request_id = str(uuid4())
    include_users = request.args.get('include_users', 'false').lower() == 'true'
    roles = UserRole.query.order_by(UserRole.name).all()
    return jsonify({'data': [_serialize_user_role(r, include_users) for r in roles], 'meta': {'request_id': request_id, 'deprecated': False, 'total_count': len(roles), 'generated_at': datetime.utcnow().isoformat() + 'Z'}})


class RolePath(BaseModel):
    role_id: str


class RoleResponse(BaseModel):
    data: UserRoleRef
    meta: dict


@api_v2.get(
    "/user-roles/<role_id>",
    tags=[roles_tag],
    summary="Get user role",
    responses={200: RoleResponse, 404: RoleResponse},
)
@login_required
@permission_required('view_users')
def get_user_role(path: RolePath):
    request_id = str(uuid4())
    role = UserRole.query.get(path.role_id)
    if not role:
        return jsonify({'error': {'code': 'ROLE_NOT_FOUND', 'message': f'User role with ID {path.role_id} not found', 'details': {'role_id': path.role_id}}, 'meta': {'request_id': request_id}}), 404
    include_users = request.args.get('include_users', 'true').lower() == 'true'
    data = _serialize_user_role(role, include_users)
    return jsonify({'data': data, 'meta': {'request_id': request_id, 'deprecated': False, 'generated_at': datetime.utcnow().isoformat() + 'Z'}})


class CreateRoleBody(BaseModel):
    name: str
    description: str | None = None
    color: str | None = None
    icon: str | None = None


@api_v2.post(
    "/user-roles",
    tags=[roles_tag],
    summary="Create user role",
)
@login_required
@permission_required('manage_users')
def create_user_role():
    request_id = str(uuid4())
    data = request.get_json()
    if not data:
        return jsonify({'error': {'code': 'INVALID_REQUEST', 'message': 'Request body must be JSON', 'hint': 'Ensure Content-Type header is application/json'}, 'meta': {'request_id': request_id}}), 400
    if not data.get('name'):
        return jsonify({'error': {'code': 'VALIDATION_ERROR', 'message': 'Missing required field: name', 'details': {'missing_fields': ['name']}}, 'meta': {'request_id': request_id}}), 422
    existing = UserRole.query.filter_by(name=data['name']).first()
    if existing:
        return jsonify({'error': {'code': 'DUPLICATE_ROLE_NAME', 'message': f'User role with name "{data["name"]}" already exists', 'details': {'name': data['name']}}, 'meta': {'request_id': request_id}}), 409
    name = (data['name'] or '').strip()
    if not name:
        return jsonify({'error': {'code': 'VALIDATION_ERROR', 'message': 'Role name cannot be empty or whitespace'}, 'meta': {'request_id': request_id}}), 400
    description = data.get('description')
    color = data.get('color')
    icon = data.get('icon')
    role = UserRole(name=name, description=description, color=color, icon=icon)
    db.session.add(role)
    db.session.commit()
    return jsonify({'data': _serialize_user_role(role), 'meta': {'request_id': request_id}}), 201


class UpdateRoleBody(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None
    icon: str | None = None


@api_v2.patch(
    "/user-roles/<role_id>",
    tags=[roles_tag],
    summary="Update user role",
)
@login_required
@permission_required('manage_users')
def update_user_role(path: RolePath):
    request_id = str(uuid4())
    role = UserRole.query.get(path.role_id)
    if not role:
        return jsonify({'error': {'code': 'ROLE_NOT_FOUND', 'message': f'User role with ID {path.role_id} not found', 'details': {'role_id': path.role_id}}, 'meta': {'request_id': request_id}}), 404
    data = request.get_json(silent=True) or {}
    if 'name' in data:
        name = (data['name'] or '').strip()
        if not name:
            return jsonify({'error': {'code': 'VALIDATION_ERROR', 'message': 'Role name cannot be empty or whitespace'}, 'meta': {'request_id': request_id}}), 400
        if UserRole.query.filter(UserRole.name == name, UserRole.id != role.id).first():
            return jsonify({'error': {'code': 'DUPLICATE_ROLE_NAME', 'message': f'User role with name "{name}" already exists', 'details': {'name': name}}, 'meta': {'request_id': request_id}}), 409
        role.name = name
    for field in ['description', 'color', 'icon']:
        if field in data:
            setattr(role, field, data[field])
    role.updated_at = datetime.utcnow()
    try:
        db.session.commit()
        return jsonify({'data': _serialize_user_role(role), 'meta': {'request_id': request_id, 'deprecated': False, 'generated_at': datetime.utcnow().isoformat() + 'Z'}})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': {'code': 'ROLE_UPDATE_FAILED', 'message': 'Failed to update user role', 'details': {'error': str(e)}}, 'meta': {'request_id': request_id}}), 500


class RoleUsersResponse(BaseModel):
    data: list[dict]
    meta: dict


@api_v2.get(
    "/user-roles/<role_id>/users",
    tags=[roles_tag],
    summary="List users with a user role",
    responses={200: RoleUsersResponse, 404: RoleUsersResponse},
)
@login_required
@permission_required('view_users')
def get_user_role_users(path: RolePath):
    request_id = str(uuid4())
    role = UserRole.query.get(path.role_id)
    if not role:
        return jsonify({'error': {'code': 'ROLE_NOT_FOUND', 'message': f'User role with ID {path.role_id} not found', 'details': {'role_id': path.role_id}}, 'meta': {'request_id': request_id}}), 404
    users = UserRole.get_users_with_role(role.id)
    return jsonify({'data': [{'uuid': u.uuid, 'username': u.get_display_name(), 'user_type': u.userType.value, 'email': u.get_email(), 'is_active': u.is_active} for u in users], 'meta': {'request_id': request_id, 'deprecated': False, 'role': {'id': role.id, 'name': role.name}, 'total_count': len(users), 'generated_at': datetime.utcnow().isoformat() + 'Z'}})

