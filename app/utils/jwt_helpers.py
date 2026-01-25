from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any

from flask import current_app
from sqlalchemy.exc import IntegrityError
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    get_jwt,
    get_jwt_identity,
    set_refresh_cookies,
    unset_jwt_cookies,
)

from app.extensions import db
from app.models import User


class TokenBlocklist(db.Model):
    __tablename__ = "token_blocklist"
    id = db.Column(db.Integer, primary_key=True)
    jti = db.Column(db.String(36), nullable=False, index=True, unique=True)
    token_type = db.Column(db.String(10), nullable=False)  # access|refresh
    user_uuid = db.Column(db.String(36), nullable=True, index=True)
    revoked_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    expires_at = db.Column(db.DateTime, nullable=True)


def is_token_revoked(jti: str) -> bool:
    return db.session.query(TokenBlocklist.id).filter_by(jti=jti).first() is not None


def revoke_token(jti: str, token_type: str, user_uuid: Optional[str] = None, expires_at: Optional[datetime] = None) -> None:
    try:
        db.session.add(TokenBlocklist(jti=jti, token_type=token_type, user_uuid=user_uuid, expires_at=expires_at))
        db.session.commit()
    except IntegrityError:
        # Token already revoked (duplicate jti). Treat as idempotent and ignore.
        db.session.rollback()
    except Exception as exc:
        current_app.logger.error(f"Failed to revoke token: {exc}")
        db.session.rollback()


def make_access_token(user: User) -> str:
    identity = user.uuid
    claims = {
        "uuid": user.uuid,
        "user_type": user.userType.value if hasattr(user.userType, "value") else str(user.userType),
        "is_admin": getattr(user, "has_admin_access", lambda: False)(),
        "permissions": [role.name for role in getattr(user, "admin_roles", [])],
    }
    return create_access_token(identity=identity, additional_claims=claims)


def make_refresh_token(
    user: User,
    expires_delta: Optional[timedelta] = None,
    additional_claims: Optional[Dict[str, Any]] = None,
) -> str:
    return create_refresh_token(
        identity=user.uuid,
        expires_delta=expires_delta,
        additional_claims=additional_claims or {},
    )


def set_refresh_cookie(resp, refresh_token: str):
    # Use library helper to set cookie w/ correct config
    set_refresh_cookies(resp, refresh_token)
    return resp


def clear_jwt_cookies(resp):
    unset_jwt_cookies(resp)
    return resp


def register_jwt_callbacks(jwt):
    from flask_jwt_extended import JWTManager
    from flask import current_app

    if not isinstance(jwt, JWTManager):
        return

    @jwt.token_in_blocklist_loader
    def _check_if_token_revoked(jwt_header, jwt_payload):
        jti = jwt_payload.get("jti")
        is_revoked = is_token_revoked(jti) if jti else True
        if is_revoked:
            current_app.logger.warning(f"[JWT_BLOCKLIST] Token {jti} is in blocklist - returning revoked=True")
        return is_revoked

    @jwt.user_lookup_loader
    def _user_lookup_callback(_jwt_header, jwt_data):
        identity = jwt_data["sub"]
        try:
            return User.query.filter_by(uuid=identity).first()
        except Exception:
            return None
