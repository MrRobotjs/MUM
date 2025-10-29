from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from flask import jsonify, request, current_app, g
from flask_login import login_required, current_user, login_user, logout_user
from sqlalchemy import func
from pydantic import BaseModel, Field
from flask_openapi3 import Tag

from app.extensions import db
from app.models import User, UserType, Setting, EventType
from app.routes.api_v2 import api_v2
from app.utils.helpers import get_csrf_token, log_event


auth_tag = Tag(name="Authentication", description="Authentication and session management")


def _serialize_user(user: User | None) -> dict | None:
    if not user:
        return None
    return {
        'uuid': user.uuid,
        'username': user.localUsername or user.external_username,
        'email': user.email or user.discord_email,
        'user_type': user.userType.value if hasattr(user.userType, 'value') else str(user.userType),
        'display_name': getattr(user, 'get_display_name', lambda: None)(),
        'permissions': [role.name for role in getattr(user, 'admin_roles', [])],
        'admin_roles': [role.name for role in getattr(user, 'admin_roles', [])],
        'user_roles': [role.name for role in getattr(user, 'user_roles', [])],
        'has_admin_access': getattr(user, 'has_admin_access', lambda: False)(),
        'is_active': getattr(user, 'is_active', True),
        'last_login_at': user.last_login_at.isoformat() if getattr(user, 'last_login_at', None) else None,
        'force_password_change': getattr(user, 'force_password_change', False)
    }


def _admin_login_query(identifier: str):
    lowered = identifier.lower()
    return User.query.filter(User.userType.in_([UserType.OWNER, UserType.LOCAL])).filter(func.lower(User.localUsername) == lowered).first()


def _find_admin_user(identifier: str) -> User | None:
    if not identifier:
        return None
    lowered = identifier.strip().lower()
    if not lowered:
        return None
    user = _admin_login_query(lowered)
    if user:
        return user
    return User.query.filter(User.userType.in_([UserType.OWNER, UserType.LOCAL])).filter(func.lower(User.email) == lowered).first()


def _issue_session_payload(user: User | None):
    return {
        'user': _serialize_user(user),
        'csrf_token': get_csrf_token(),
        'feature_flags': {},
        'setup_complete': getattr(g, 'setup_complete', False),
        'force_password_change': getattr(user, 'force_password_change', False) if user else False
    }


class CSRFResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/auth/csrf-token",
    tags=[auth_tag],
    summary="Get CSRF token",
    responses={200: CSRFResponse},
)
def issue_csrf_token():
    request_id = str(uuid4())
    token = get_csrf_token()
    response = jsonify({'data': {'csrf_token': token}, 'meta': {'request_id': request_id, 'deprecated': False}})
    response.headers['Cache-Control'] = 'no-store'
    return response, 200


class LoginBody(BaseModel):
    username: str
    password: str
    remember: bool = False


class SessionResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/login",
    tags=[auth_tag],
    summary="Admin login",
    responses={200: SessionResponse, 400: SessionResponse, 401: SessionResponse, 409: SessionResponse},
)
def admin_login():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''
    remember = bool(payload.get('remember', False))
    if not username or not password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'Username and password are required.'}, 'meta': {'request_id': request_id}}), 400
    if not User.get_owner():
        return jsonify({'error': {'code': 'SETUP_REQUIRED', 'message': 'Owner account not configured. Complete setup before logging in.'}, 'meta': {'request_id': request_id}}), 409
    candidate = _find_admin_user(username)
    if not candidate or not candidate.check_password(password):
        log_event(EventType.ADMIN_LOGIN_FAIL, f"Failed admin login attempt for '{username}'.")
        return jsonify({'error': {'code': 'INVALID_CREDENTIALS', 'message': 'Invalid username or password.'}, 'meta': {'request_id': request_id}}), 401
    if not candidate.is_active:
        return jsonify({'error': {'code': 'ACCOUNT_DISABLED', 'message': 'Account is disabled.'}, 'meta': {'request_id': request_id}}), 403
    login_user(candidate, remember=remember)
    candidate.last_login_at = datetime.utcnow()
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to update last login: {exc}")
        db.session.rollback()
    log_event(EventType.ADMIN_LOGIN_SUCCESS, f"Admin '{candidate.localUsername}' logged in.")
    return jsonify({'data': _issue_session_payload(candidate), 'meta': {'request_id': request_id}}), 200


class LogoutResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/logout",
    tags=[auth_tag],
    summary="Admin logout",
    responses={200: LogoutResponse},
)
@login_required
def admin_logout_v2():
    request_id = str(uuid4())
    actor = _serialize_user(current_user)
    logout_user()
    if actor:
        log_event(EventType.ADMIN_LOGOUT, f"User '{actor.get('username')}' logged out.")
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id, 'deprecated': False}}), 200


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


@api_v2.post(
    "/auth/change-password",
    tags=[auth_tag],
    summary="Change current user's password",
    responses={200: SessionResponse, 400: SessionResponse, 401: SessionResponse, 422: SessionResponse, 500: SessionResponse},
)
@login_required
def change_password():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    current_password = payload.get('current_password') or ''
    new_password = payload.get('new_password') or ''
    if not current_password or not new_password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'current_password and new_password are required.'}, 'meta': {'request_id': request_id}}), 400
    if len(new_password) < 8:
        return jsonify({'error': {'code': 'WEAK_PASSWORD', 'message': 'New password must be at least 8 characters long.'}, 'meta': {'request_id': request_id}}), 422
    if not current_user.check_password(current_password):
        return jsonify({'error': {'code': 'INVALID_CREDENTIALS', 'message': 'Current password is incorrect.'}, 'meta': {'request_id': request_id}}), 401
    current_user.set_password(new_password)
    current_user.force_password_change = False
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to update password: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({'error': {'code': 'PASSWORD_UPDATE_FAILED', 'message': 'Failed to update password.'}, 'meta': {'request_id': request_id}}), 500
    log_event(EventType.ADMIN_PASSWORD_CHANGE, f"Password changed for '{current_user.localUsername}'.", admin_id=current_user.id)
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id, 'deprecated': False}}), 200


class SetPasswordBody(BaseModel):
    new_password: str


@api_v2.post(
    "/auth/set-password",
    tags=[auth_tag],
    summary="Set initial password for flagged accounts",
    responses={200: SessionResponse, 400: SessionResponse, 409: SessionResponse, 422: SessionResponse, 500: SessionResponse},
)
@login_required
def set_password():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    new_password = payload.get('new_password') or ''
    if not new_password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'new_password is required.'}, 'meta': {'request_id': request_id}}), 400
    if len(new_password) < 8:
        return jsonify({'error': {'code': 'WEAK_PASSWORD', 'message': 'New password must be at least 8 characters long.'}, 'meta': {'request_id': request_id}}), 422
    if not current_user.force_password_change and current_user.password_hash:
        return jsonify({'error': {'code': 'PASSWORD_CHANGE_NOT_REQUIRED', 'message': 'Account is not flagged for password reset.'}, 'meta': {'request_id': request_id}}), 409
    current_user.set_password(new_password)
    current_user.force_password_change = False
    try:
        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to set password: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({'error': {'code': 'PASSWORD_UPDATE_FAILED', 'message': 'Failed to set password.'}, 'meta': {'request_id': request_id}}), 500
    log_event(EventType.ADMIN_PASSWORD_CHANGE, f"Password set for '{current_user.localUsername}'.", admin_id=current_user.id)
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id, 'deprecated': False}}), 200


@api_v2.get(
    "/auth/session",
    tags=[auth_tag],
    summary="Get current session",
    responses={200: SessionResponse},
)
@login_required
def get_session():
    request_id = str(uuid4())
    return jsonify({'data': _issue_session_payload(current_user), 'meta': {'request_id': request_id, 'deprecated': False, 'config': {'allow_user_accounts': Setting.get_bool('ALLOW_USER_ACCOUNTS', False)}}}), 200
