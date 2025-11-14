from __future__ import annotations

from functools import wraps
from typing import Callable, Any

from flask import jsonify, request
from flask_jwt_extended import jwt_required, current_user as jwt_current_user, decode_token
from app.utils.jwt_helpers import is_token_revoked
from app.models import User


def jwt_required_with_user(optional: bool = False) -> Callable:
    """Header-only auth. Inject current_user param.

    Usage:
        @jwt_required_with_user()
        def handler(current_user):
            ...
    """

    def decorator(fn: Callable) -> Callable:
        @jwt_required(optional=optional, locations=["headers"])  # APIs: headers only
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any):
            user = getattr(jwt_current_user, "_get_current_object", lambda: jwt_current_user)()
            if not user:
                if optional:
                    return fn(*args, current_user=None, **kwargs)
                return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Authentication required."}}), 401
            return fn(*args, current_user=user, **kwargs)

        return wrapper

    return decorator


def jwt_permission_required(*permissions: str):
    """Simple permission gate using admin role names as permissions.
    Assumes jwt_required_with_user ran before it and injected current_user.
    """

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any):
            user = kwargs.get("current_user")
            if not user:
                return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Authentication required."}}), 401

            # Owners have full access
            user_type = getattr(user, "userType", None)
            user_type_val = getattr(user_type, "value", user_type)
            if isinstance(user_type_val, str) and user_type_val.lower() == "owner":
                return fn(*args, **kwargs)

            # Otherwise require explicit permissions via admin roles
            user_perms = set([r.name for r in getattr(user, "admin_roles", [])])
            needed = set(permissions)
            if not needed.issubset(user_perms):
                return jsonify({"error": {"code": "FORBIDDEN", "message": "Insufficient permissions."}}), 403
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def jwt_required_with_user_allow_query(optional: bool = False):
    """Like jwt_required_with_user, but also allows `access_token` in the query string.

    Useful for <img src> and similar browser-initiated requests where headers
    cannot include Authorization. Validates token signature and revocation.
    """

    def decorator(fn: Callable) -> Callable:
        # Header first; then fall back to query string token
        @jwt_required(optional=True, locations=["headers"])  # ignore cookies here
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any):
            user = getattr(jwt_current_user, "_get_current_object", lambda: jwt_current_user)()
            if user:
                return fn(*args, current_user=user, **kwargs)

            # Fallback to query param access_token
            token = request.args.get('access_token') or request.args.get('token')
            if not token:
                return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Authentication required."}}), 401
            try:
                decoded = decode_token(token)
                jti = decoded.get('jti')
                if jti and is_token_revoked(jti):
                    return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Token revoked."}}), 401
                identity = decoded.get('sub')
                if not identity:
                    return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Invalid token."}}), 401
                user = User.query.filter_by(uuid=identity).first()
                if not user or not getattr(user, 'is_active', True):
                    return jsonify({"error": {"code": "FORBIDDEN", "message": "Account disabled."}}), 403
                return fn(*args, current_user=user, **kwargs)
            except Exception:
                return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Invalid token."}}), 401

        return wrapper

    return decorator


def jwt_header_or_cookie(optional: bool = False) -> Callable:
    """Accept header or cookie access token. Inject current_user param.

    Use for media/download endpoints where browser primitives need cookie auth.
    """

    def decorator(fn: Callable) -> Callable:
        @jwt_required(optional=optional, locations=["headers", "cookies"])
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any):
            user = getattr(jwt_current_user, "_get_current_object", lambda: jwt_current_user)()
            if not user:
                return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Authentication required."}}), 401
            return fn(*args, current_user=user, **kwargs)

        return wrapper

    return decorator
