
from uuid import uuid4
from datetime import datetime

from flask import jsonify, request, current_app
from flask_login import login_required, current_user
from sqlalchemy import or_

from app.routes.api_v1 import bp
from app.models import User, UserType, AdminRole, UserRole, EventType
from app.models_media_services import MediaLibrary
from app.extensions import db
from app.utils.helpers import permission_required, log_event
from app.services import user_service


def _serialize_roles(user):
    return {
        'admin_roles': [role.name for role in getattr(user, 'admin_roles', [])],
        'user_roles': [role.name for role in getattr(user, 'user_roles', [])]
    }


def _serialize_service_accounts(user):
    linked = []
    for child in getattr(user, 'linked_children', []) or []:
        if child.userType == UserType.SERVICE:
            linked.append({
                'uuid': child.uuid,
                'service_type': child.server.service_type.value if child.server else None,
                'server_name': child.server.server_nickname if child.server else None,
                'external_username': child.external_username,
                'external_email': child.external_email,
                'linked_at': child.created_at.isoformat() if child.created_at else None
            })
    return linked


def _serialize_history_entry(entry):
    return {
        'id': entry.id,
        'timestamp': entry.timestamp.isoformat() if entry.timestamp else None,
        'event_type': entry.event_type.value if entry.event_type else None,
        'message': entry.message,
        'details': entry.details or {}
    }


def _get_avatar_url(user: User):
    if user.userType == UserType.OWNER:
        if user.plex_thumb:
            return user.plex_thumb
    if user.userType in {UserType.LOCAL, UserType.OWNER}:
        if user.discord_avatar_hash and user.discord_user_id:
            return f"https://cdn.discordapp.com/avatars/{user.discord_user_id}/{user.discord_avatar_hash}.png?size=256"
        if user.external_avatar_url:
            return user.external_avatar_url
    if user.userType == UserType.SERVICE:
        if user.external_avatar_url:
            return user.external_avatar_url
        service_thumb = None
        if user.service_settings:
            service_thumb = user.service_settings.get('thumb')
        if service_thumb and user.server:
            base_url = user.server.public_url or user.server.url
            if service_thumb.startswith('/'):
                return f"{base_url.rstrip('/')}{service_thumb}"
            return service_thumb
    return None


def _collect_service_context(user: User):
    service_types = []
    server_names = []

    if user.userType == UserType.SERVICE:
        if user.server and user.server.service_type:
            service_types.append(user.server.service_type.value)
            server_names.append(user.server.server_nickname)
    else:
        for child in getattr(user, 'linked_children', []) or []:
            if child.userType == UserType.SERVICE and child.server and child.server.service_type:
                service_types.append(child.server.service_type.value)
                server_names.append(child.server.server_nickname)

    # Remove duplicates while preserving order
    unique_service_types = []
    for service in service_types:
        if service not in unique_service_types:
            unique_service_types.append(service)

    unique_server_names = []
    for server in server_names:
        if server not in unique_server_names:
            unique_server_names.append(server)

    return {
        'service_types': unique_service_types,
        'server_names': unique_server_names,
        'primary_service_type': unique_service_types[0] if unique_service_types else None,
        'primary_server_name': unique_server_names[0] if unique_server_names else None
    }


def _serialize_linked_local_user(user: User):
    if user.userType != UserType.SERVICE or not user.linked_parent:
        return None

    parent = user.linked_parent
    return {
        'uuid': parent.uuid,
        'username': parent.localUsername,
        'display_name': parent.get_display_name() if hasattr(parent, 'get_display_name') else parent.localUsername,
        'email': parent.email
    }


@bp.route('/users/<string:user_uuid>', methods=['GET'])
@login_required
def get_user_detail(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()

    service_context = _collect_service_context(user)
    avatar_url = _get_avatar_url(user)
    linked_local_user = _serialize_linked_local_user(user)

    libraries = []
    has_all_libraries = True
    if user.userType == UserType.SERVICE:
        has_all_libraries = not bool(user.allowed_library_ids)
        if user.allowed_library_ids and user.server_id:
            allowed_ids = [str(value) for value in user.allowed_library_ids]
            libs = MediaLibrary.query.filter(
                MediaLibrary.server_id == user.server_id,
                or_(
                    MediaLibrary.external_id.in_(allowed_ids),
                    MediaLibrary.internal_id.in_(allowed_ids)
                )
            ).all()
            libraries = [library.name for library in libs]

    stream_stats = {'global': {}, 'players': []}
    try:
        stream_stats = user_service.get_user_stream_stats(user.uuid) or {'global': {}, 'players': []}
    except Exception as exc:
        current_app.logger.warning(f"Failed to load stream stats for user {user_uuid}: {exc}", exc_info=True)

    global_stats = stream_stats.get('global', {}) if isinstance(stream_stats, dict) else {}
    total_plays = global_stats.get('all_time_plays', 0)
    total_duration_seconds = global_stats.get('all_time_duration_seconds', 0)

    data = {
        'uuid': user.uuid,
        'username': user.localUsername or user.external_username,
        'email': user.email or user.discord_email,
        'user_type': user.userType.value,
        'display_name': user.get_display_name() if hasattr(user, 'get_display_name') else None,
        'created_at': user.created_at.isoformat() if user.created_at else None,
        'last_login_at': user.last_login_at.isoformat() if user.last_login_at else None,
        'is_active': user.is_active,
        'notes': user.notes,
        'roles': _serialize_roles(user),
        'user_roles_detail': [
            {
                'name': role.name,
                'color': getattr(role, 'color', None),
                'icon': getattr(role, 'icon', None),
                'badge_style': getattr(role, 'badge_style', None),
                'description': getattr(role, 'description', None)
            }
            for role in getattr(user, 'user_roles', [])
        ],
        'service_accounts': _serialize_service_accounts(user),
        'history': [
            _serialize_history_entry(entry)
            for entry in user.history_logs.order_by(User.history_logs.property.mapper.class_.timestamp.desc()).limit(10)
        ] if hasattr(user, 'history_logs') else []
    }

    data.update({
        'local_username': user.localUsername,
        'external_username': user.external_username,
        'external_email': user.external_email,
        'external_user_id': user.external_user_id,
        'external_user_alt_id': user.external_user_alt_id,
        'discord_username': user.discord_username,
        'discord_user_id': user.discord_user_id,
        'discord_email': user.discord_email,
        'discord_avatar_url': f"https://cdn.discordapp.com/avatars/{user.discord_user_id}/{user.discord_avatar_hash}.png?size=256"
        if user.discord_avatar_hash and user.discord_user_id else None,
        'avatar_url': avatar_url,
        'service_type': service_context.get('primary_service_type'),
        'service_types': service_context.get('service_types'),
        'server_nickname': service_context.get('primary_server_name'),
        'server_names': service_context.get('server_names'),
        'linked_local_user': linked_local_user,
        'libraries': libraries,
        'has_all_libraries': has_all_libraries,
        'last_activity_at': user.last_activity_at.isoformat() if user.last_activity_at else None,
        'service_join_date': user.service_join_date.isoformat() if user.service_join_date else None,
        'access_expires_at': user.access_expires_at.isoformat() if user.access_expires_at else None,
        'allow_downloads': bool(getattr(user, 'allow_downloads', False)),
        'allow_4k_transcode': bool(getattr(user, 'allow_4k_transcode', False)),
        'is_purge_whitelisted': bool(getattr(user, 'is_purge_whitelisted', False)),
        'is_discord_bot_whitelisted': bool(getattr(user, 'is_discord_bot_whitelisted', False)),
        'is_home_user': bool(getattr(user, 'is_home_user', False)),
        'shares_back': bool(getattr(user, 'shares_back', False)),
        'has_password': bool(user.password_hash),
        'used_invite': bool(user.used_invite_id),
        'force_password_change': bool(getattr(user, 'force_password_change', False)),
        'stream_stats': stream_stats,
        'total_plays': total_plays,
        'total_duration_seconds': total_duration_seconds
    })

    response = {
        'data': data,
        'meta': {
            'request_id': request_id,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'deprecated': False
        }
    }
    return jsonify(response), 200


@bp.route('/users/<string:user_uuid>', methods=['PATCH'])
@login_required
@permission_required('edit_user')
def update_user_detail(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()
    payload = request.get_json(silent=True) or {}

    notes = payload.get('notes')
    is_active = payload.get('is_active')
    admin_role_ids = payload.get('admin_role_ids')
    user_role_ids = payload.get('user_role_ids')

    try:
        if notes is not None:
            user.notes = notes

        if is_active is not None:
            if user.userType == UserType.OWNER and not is_active:
                return jsonify({
                    'error': {
                        'code': 'CANNOT_DEACTIVATE_OWNER',
                        'message': 'Owner account cannot be deactivated.'
                    },
                    'meta': {'request_id': request_id}
                }), 400
            user.is_active = bool(is_active)

        if admin_role_ids is not None:
            if user.userType != UserType.LOCAL:
                return jsonify({
                    'error': {
                        'code': 'INVALID_USER_TYPE',
                        'message': 'Admin roles can only be managed for local accounts.'
                    },
                    'meta': {'request_id': request_id}
                }), 400
            roles = AdminRole.query.filter(AdminRole.id.in_(admin_role_ids)).all()
            user.set_admin_roles(roles)

        if user_role_ids is not None:
            roles = UserRole.query.filter(UserRole.id.in_(user_role_ids)).all()
            user.user_roles = roles

        db.session.commit()
    except Exception as exc:
        current_app.logger.error(f"Failed to update user {user_uuid}: {exc}", exc_info=True)
        db.session.rollback()
        return jsonify({
            'error': {
                'code': 'UPDATE_FAILED',
                'message': 'Failed to update user.'
            },
            'meta': {'request_id': request_id}
        }), 500

    log_event(
        EventType.SETTING_CHANGE,
        f"User '{user.localUsername or user.external_username}' updated via API.",
        admin_id=getattr(current_user, 'id', None)
    )

    return jsonify({
        'data': {
            'uuid': user.uuid,
            'notes': user.notes,
            'is_active': user.is_active,
            'roles': _serialize_roles(user)
        },
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    }), 200
