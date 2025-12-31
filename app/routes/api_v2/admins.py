from __future__ import annotations

from uuid import uuid4
from flask import jsonify, request
from app.utils.jwt_decorators import jwt_required_with_user, jwt_permission_required
from app.utils.helpers import log_event
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2
from app.models import User, UserType, AdminRole, EventType
from app.extensions import db
# JWT permission checking handled by jwt_permission_required, log_event


admins_tag = Tag(name="Admins", description="Admin management")


class RoleRef(BaseModel):
    id: str
    name: str | None = None
    description: str | None = None
    position: int | None = None
    color: str | None = None
    icon: str | None = None


class AdminItem(BaseModel):
    id: int
    uuid: str | None = None
    username: str | None = None
    display_name: str | None = None
    user_type: str | None = None
    email: str | None = None
    last_login_at: str | None = None
    admin_roles: list[RoleRef] = []


class AdminsListResponse(BaseModel):
    data: list[AdminItem]
    meta: dict


def _serialize_admin(user: User):
    return {
        'id': user.id,
        'uuid': getattr(user, 'uuid', None),
        'username': user.localUsername,
        'display_name': getattr(user, 'get_display_name', lambda: user.localUsername)(),
        'user_type': user.userType.value if hasattr(user.userType, 'value') else str(user.userType),
        'email': user.email,
        'last_login_at': user.last_login_at.isoformat() if user.last_login_at else None,
        'admin_roles': [
            {
                'id': role.id,
                'name': role.name,
                'description': role.description,
                'position': role.position,
                'color': role.color,
                'icon': role.icon
            }
            for role in user.admin_roles
        ]
    }


@api_v2.get(
    "/admins",
    tags=[admins_tag],
    summary="List admins",
    responses={200: AdminsListResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def list_admins(current_user):
    request_id = str(uuid4())
    owner = User.get_owner()
    admins = User.query.filter(
        User.userType == UserType.LOCAL,
        User.admin_roles.any()
    ).order_by(User.localUsername.asc()).all()

    data = []
    if owner:
        data.append(_serialize_admin(owner))
    data.extend(_serialize_admin(admin) for admin in admins)

    return jsonify({'data': data, 'meta': {'request_id': request_id}})


class CreateAdminBody(BaseModel):
    username: str
    password: str
    role_ids: list[str] = []


class AdminResponse(BaseModel):
    data: AdminItem | dict
    meta: dict


@api_v2.post(
    "/admins",
    tags=[admins_tag],
    summary="Create admin",
    responses={201: AdminResponse, 400: AdminResponse, 409: AdminResponse, 500: AdminResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def create_admin(current_user):
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    username = (payload.get('username') or '').strip()
    password = payload.get('password')
    role_ids = payload.get('role_ids') or []

    if not username or not password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'Username and password are required.'}, 'meta': {'request_id': request_id}}), 400

    if User.get_by_local_username(username):
        return jsonify({'error': {'code': 'USERNAME_EXISTS', 'message': 'A user with that username already exists.'}, 'meta': {'request_id': request_id}}), 409

    try:
        new_user = User.create_admin_user(username=username, password=password)
        if role_ids:
            roles = AdminRole.query.filter(
                AdminRole.id.in_(role_ids),
                AdminRole.is_auto_managed.is_(False)
            ).all()
            if roles:
                new_user.set_admin_roles(roles)
        new_user.force_password_change = True
        db.session.add(new_user)
        db.session.commit()
        log_event(EventType.MUM_USER_ADDED_FROM_PLEX, f"Admin user '{username}' created via API.", admin_id=current_user.id)
    except Exception as exc:
        db.session.rollback()
        return jsonify({'error': {'code': 'CREATE_FAILED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500

    return jsonify({'data': _serialize_admin(new_user), 'meta': {'request_id': request_id}}), 201


class UpdateAdminBody(BaseModel):
    role_ids: list[str] = []


@api_v2.patch(
    "/admins/<int:admin_id>",
    tags=[admins_tag],
    summary="Update admin roles",
    responses={200: AdminResponse, 400: AdminResponse, 404: AdminResponse, 500: AdminResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def update_admin(admin_id, current_user):
    request_id = str(uuid4())
    if current_user.id == admin_id:
        return jsonify({'error': {'code': 'SELF_EDIT_FORBIDDEN', 'message': 'Use the account page to manage your own roles.'}, 'meta': {'request_id': request_id}}), 400

    user = User.query.filter_by(id=admin_id, userType=UserType.LOCAL).first()
    if not user:
        return jsonify({'error': {'code': 'ADMIN_NOT_FOUND', 'message': 'Admin user not found.'}, 'meta': {'request_id': request_id}}), 404

    payload = request.get_json(silent=True) or {}
    role_ids = payload.get('role_ids') or []

    roles = AdminRole.query.filter(
        AdminRole.id.in_(role_ids),
        AdminRole.is_auto_managed.is_(False)
    ).all()
    try:
        user.set_admin_roles(roles)
        db.session.commit()
        log_event(EventType.SETTING_CHANGE, f"Admin roles updated for '{user.localUsername}'.", admin_id=current_user.id)
    except Exception as exc:
        db.session.rollback()
        return jsonify({'error': {'code': 'UPDATE_FAILED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500

    return jsonify({'data': _serialize_admin(user), 'meta': {'request_id': request_id}})


class ResetAdminPasswordBody(BaseModel):
    password: str


@api_v2.post(
    "/admins/<int:admin_id>/reset-password",
    tags=[admins_tag],
    summary="Reset admin password",
    responses={200: AdminResponse, 400: AdminResponse, 404: AdminResponse, 500: AdminResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def reset_admin_password(admin_id, current_user):
    request_id = str(uuid4())
    if current_user.id == admin_id:
        return jsonify({'error': {'code': 'SELF_RESET_FORBIDDEN', 'message': 'Cannot reset your own password via this endpoint.'}, 'meta': {'request_id': request_id}}), 400

    user = User.query.filter_by(id=admin_id, userType=UserType.LOCAL).first()
    if not user:
        return jsonify({'error': {'code': 'ADMIN_NOT_FOUND', 'message': 'Admin user not found.'}, 'meta': {'request_id': request_id}}), 404

    payload = request.get_json(silent=True) or {}
    new_password = payload.get('password')
    if not new_password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'Password is required.'}, 'meta': {'request_id': request_id}}), 400

    try:
        user.set_password(new_password)
        user.force_password_change = True
        db.session.commit()
        log_event(EventType.ADMIN_PASSWORD_CHANGE, f"Password reset for '{user.localUsername}'.", admin_id=current_user.id)
    except Exception as exc:
        db.session.rollback()
        return jsonify({'error': {'code': 'RESET_FAILED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500

    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}})


@api_v2.delete(
    "/admins/<int:admin_id>",
    tags=[admins_tag],
    summary="Delete admin user",
    responses={200: AdminResponse, 400: AdminResponse, 404: AdminResponse, 500: AdminResponse},
)
@jwt_required_with_user()
@jwt_permission_required('administrator')
def delete_admin(admin_id, current_user):
    request_id = str(uuid4())
    if current_user.id == admin_id:
        return jsonify({'error': {'code': 'SELF_DELETE_FORBIDDEN', 'message': 'You cannot delete your own account.'}, 'meta': {'request_id': request_id}}), 400

    user = User.query.filter_by(id=admin_id, userType=UserType.LOCAL).first()
    if not user:
        return jsonify({'error': {'code': 'ADMIN_NOT_FOUND', 'message': 'Admin user not found.'}, 'meta': {'request_id': request_id}}), 404

    try:
        db.session.delete(user)
        db.session.commit()
        log_event(EventType.SETTING_CHANGE, f"Admin user '{user.localUsername}' deleted via API.", admin_id=current_user.id)
    except Exception as exc:
        db.session.rollback()
        return jsonify({'error': {'code': 'DELETE_FAILED', 'message': str(exc)}, 'meta': {'request_id': request_id}}), 500

    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}}), 200
