from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from flask import jsonify, request
from flask_login import login_user, logout_user, current_user, login_required
from sqlalchemy import func
from pydantic import BaseModel

from app.extensions import db
from app.models import User, UserType, Setting, EventType
from app.utils.helpers import get_csrf_token, log_event

from . import api_v2_public, public_session_tag


def _serialize_portal_user(user: User | None):
    if not user:
        return None
    return {
        'uuid': user.uuid,
        'username': user.localUsername or user.external_username,
        'email': user.email or user.discord_email,
        'user_type': user.userType.value if hasattr(user.userType, 'value') else str(user.userType),
        'display_name': getattr(user, 'get_display_name', lambda: None)(),
        'is_active': getattr(user, 'is_active', True),
        'force_password_change': getattr(user, 'force_password_change', False),
    }


def _find_local_user(identifier: str) -> User | None:
    if not identifier:
        return None
    lowered = identifier.strip().lower()
    if not lowered:
        return None
    candidates = User.query.filter(User.userType.in_([UserType.LOCAL, UserType.OWNER]))
    user = candidates.filter(func.lower(User.localUsername) == lowered).first()
    if user:
        return user
    user = candidates.filter(func.lower(User.email) == lowered).first()
    if user:
        return user
    return candidates.filter(func.lower(User.discord_email) == lowered).first()


def _session_payload(user: User | None):
    return {
        'user': _serialize_portal_user(user),
        'csrf_token': get_csrf_token(),
        'force_password_change': getattr(user, 'force_password_change', False) if user else False,
    }


class CSRFResponse(BaseModel):
    data: dict
    meta: dict


@api_v2_public.get(
    "/public/auth/csrf-token",
    tags=[public_session_tag],
    summary="Issue CSRF token for public portal",
    responses={200: CSRFResponse},
)
def issue_public_csrf_token_v2():
    request_id = str(uuid4())
    token = get_csrf_token()
    response = jsonify({'data': {'csrf_token': token}, 'meta': {'request_id': request_id, 'deprecated': False}})
    response.headers['Cache-Control'] = 'no-store'
    return response, 200


class LoginResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


@api_v2_public.post(
    "/public/auth/login",
    tags=[public_session_tag],
    summary="Public portal: local user login",
    responses={200: LoginResponse, 400: LoginResponse, 401: LoginResponse, 403: LoginResponse},
)
def public_login_v2():
    request_id = str(uuid4())
    if not Setting.get_bool('ALLOW_USER_ACCOUNTS', False):
        return jsonify({'error': {'code': 'USER_ACCOUNTS_DISABLED', 'message': 'End-user accounts are disabled.'}, 'meta': {'request_id': request_id}}), 403

    payload = request.get_json(silent=True) or {}
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''
    remember = bool(payload.get('remember', False))

    if not username or not password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'Username and password are required.'}, 'meta': {'request_id': request_id}}), 400

    candidate = _find_local_user(username)
    if not candidate or not candidate.check_password(password):
        log_event(EventType.ADMIN_LOGIN_FAIL, f"Failed local login attempt for '{username}'.")
        return jsonify({'error': {'code': 'INVALID_CREDENTIALS', 'message': 'Invalid username or password.'}, 'meta': {'request_id': request_id}}), 401

    if not candidate.is_active:
        return jsonify({'error': {'code': 'ACCOUNT_DISABLED', 'message': 'Account is disabled.'}, 'meta': {'request_id': request_id}}), 403

    login_user(candidate, remember=remember)
    candidate.last_login_at = datetime.utcnow()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()

    log_event(EventType.ADMIN_LOGIN_SUCCESS, f"App user '{candidate.localUsername}' logged in.")
    return jsonify({'data': _session_payload(candidate), 'meta': {'request_id': request_id, 'deprecated': False}}), 200


class LogoutResponse(BaseModel):
    data: dict
    meta: dict


@api_v2_public.post(
    "/public/auth/logout",
    tags=[public_session_tag],
    summary="Public portal: logout",
    responses={200: LogoutResponse},
)
@login_required
def public_logout_v2():
    request_id = str(uuid4())
    logout_user()
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id, 'deprecated': False}}), 200


class MeResponse(BaseModel):
    data: dict
    meta: dict


@api_v2_public.get(
    "/public/me",
    tags=[public_session_tag],
    summary="Get current public portal user",
    responses={200: MeResponse},
)
@login_required
def current_portal_user_v2():
    request_id = str(uuid4())
    return jsonify({
        'data': {
            'user': _serialize_portal_user(current_user),
            'csrf_token': get_csrf_token()
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200

