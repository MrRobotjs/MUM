from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from flask import jsonify, request
from flask_jwt_extended import (
    jwt_required,
    get_jwt_identity,
    get_jwt,
)
from app.utils.jwt_decorators import jwt_required_with_user
from app.utils.jwt_helpers import (
    make_access_token,
    make_refresh_token,
    set_refresh_cookie,
    clear_jwt_cookies,
    revoke_token,
)
from sqlalchemy import func
from pydantic import BaseModel

from app.extensions import db
from app.models import User, UserType, Setting

from . import api_v2, public_session_tag


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
        'force_password_change': getattr(user, 'force_password_change', False) if user else False,
    }


# CSRF tokens are not used with JWT-based public auth


class LoginResponse(BaseModel):
    data: dict | None = None
    error: dict | None = None
    meta: dict


@api_v2.post(
    "/auth/jwt/login",
    tags=[public_session_tag],
    summary="Public portal: JWT login",
    responses={200: LoginResponse, 400: LoginResponse, 401: LoginResponse, 403: LoginResponse},
)
def public_jwt_login_v2():
    request_id = str(uuid4())
    if not Setting.get_bool('ALLOW_USER_ACCOUNTS', False):
        return jsonify({'error': {'code': 'USER_ACCOUNTS_DISABLED', 'message': 'End-user accounts are disabled.'}, 'meta': {'request_id': request_id}}), 403

    payload = request.get_json(silent=True) or {}
    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''

    if not username or not password:
        return jsonify({'error': {'code': 'INVALID_PAYLOAD', 'message': 'Username and password are required.'}, 'meta': {'request_id': request_id}}), 400

    candidate = _find_local_user(username)
    if not candidate or not candidate.check_password(password):
        return jsonify({'error': {'code': 'INVALID_CREDENTIALS', 'message': 'Invalid username or password.'}, 'meta': {'request_id': request_id}}), 401

    if not candidate.is_active:
        return jsonify({'error': {'code': 'ACCOUNT_DISABLED', 'message': 'Account is disabled.'}, 'meta': {'request_id': request_id}}), 403

    # JWT tokens for public portal
    access_token = make_access_token(candidate)
    refresh_token = make_refresh_token(candidate)
    candidate.last_login_at = datetime.utcnow()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()

    resp = jsonify({'data': {'access_token': access_token, 'user': _serialize_portal_user(candidate)}, 'meta': {'request_id': request_id}})
    set_refresh_cookie(resp, refresh_token)
    return resp, 200


class LogoutResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/jwt/logout",
    tags=[public_session_tag],
    summary="Public portal: JWT logout",
    responses={200: LogoutResponse},
)
@jwt_required_with_user()
def public_jwt_logout_v2(current_user):
    request_id = str(uuid4())
    jti = get_jwt().get('jti')
    identity = get_jwt_identity()
    if jti:
        revoke_token(jti, 'refresh', user_uuid=identity)
    resp = jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}})
    clear_jwt_cookies(resp)
    return resp, 200


class RefreshResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.post(
    "/auth/jwt/refresh",
    tags=[public_session_tag],
    summary="Public portal: refresh access token",
    responses={200: RefreshResponse, 401: RefreshResponse},
)
@jwt_required(refresh=True)
def public_jwt_refresh_v2():
    request_id = str(uuid4())
    identity = get_jwt_identity()
    if not identity:
        return jsonify({'error': {'code': 'UNAUTHORIZED', 'message': 'Invalid refresh token.'}, 'meta': {'request_id': request_id}}), 401
    user = User.query.filter_by(uuid=identity).first()
    if not user or not user.is_active:
        return jsonify({'error': {'code': 'FORBIDDEN', 'message': 'Account is disabled.'}, 'meta': {'request_id': request_id}}), 403
    old_jti = get_jwt().get('jti')
    if old_jti:
        revoke_token(old_jti, 'refresh', user_uuid=user.uuid)
    new_refresh = make_refresh_token(user)
    new_access = make_access_token(user)
    resp = jsonify({'data': {'access_token': new_access}, 'meta': {'request_id': request_id}})
    set_refresh_cookie(resp, new_refresh)
    return resp, 200


class MeResponse(BaseModel):
    data: dict
    meta: dict


@api_v2.get(
    "/me",
    tags=[public_session_tag],
    summary="Get current public portal user",
    responses={200: MeResponse},
)
@jwt_required_with_user()
def current_portal_user_v2(current_user):
    request_id = str(uuid4())
    return jsonify({
        'data': {
            'user': _serialize_portal_user(current_user)
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200