from __future__ import annotations

"""
DEPRECATED auth endpoints retained only as reference.
These are not imported by api_v2 and are not active.
If imported, they return HTTP 410 Gone.
"""

from uuid import uuid4
from flask import jsonify
from flask_openapi3 import Tag

from app.routes.api.v2 import api_v2


auth_deprecated_tag = Tag(name="Auth (Deprecated)", description="Deprecated session-based auth endpoints")


@api_v2.get(
    "/auth/csrf-token",
    tags=[auth_deprecated_tag],
    summary="Deprecated: CSRF token",
)
def deprecated_csrf():
    request_id = uuid4().hex
    return jsonify({
        'error': {
            'code': 'DEPRECATED',
            'message': 'CSRF tokens are not used. Migrate to JWT.'
        },
        'meta': {'request_id': request_id}
    }), 410


@api_v2.post(
    "/auth/login",
    tags=[auth_deprecated_tag],
    summary="Deprecated: Session login",
)
def deprecated_login():
    request_id = uuid4().hex
    return jsonify({
        'error': {
            'code': 'DEPRECATED',
            'message': 'Use /api/v2/auth/jwt/login'
        },
        'meta': {'request_id': request_id}
    }), 410

