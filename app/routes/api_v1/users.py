
from uuid import uuid4
from datetime import datetime

from flask import jsonify, request
from flask_login import login_required
from sqlalchemy import or_, func

from app.routes.api_v1 import bp
from app.models import User, UserType
from app.models_media_services import MediaLibrary


def _get_avatar_url(user: User):
    """Generate avatar URL for a user based on their type and settings."""
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


@bp.route('/users', methods=['GET'])
@login_required
def list_users():
    request_id = str(uuid4())
    page = max(1, request.args.get('page', type=int) or 1)
    page_size = request.args.get('page_size', type=int) or 25
    page_size = max(1, min(page_size, 100))

    search = (request.args.get('search') or '').strip()
    user_type = (request.args.get('user_type') or '').strip().lower()
    role_filter = request.args.get('role')

    query = User.query

    if user_type in {'owner', 'local', 'service'}:
        try:
            query = query.filter(User.userType == UserType(user_type))
        except ValueError:
            pass

    if search:
        term = f"%{search}%"
        query = query.filter(
            or_(
                func.lower(User.localUsername).like(func.lower(term)),
                func.lower(User.email).like(func.lower(term)),
                func.lower(User.discord_email).like(func.lower(term))
            )
        )

    if role_filter:
        query = query.join(User.admin_roles).filter(func.lower(User.admin_roles.any().name) == func.lower(role_filter))

    sort = (request.args.get('sort') or '').lower()

    if sort == 'username_asc':
        # Sort by username, using localUsername for local users and external_username for service users
        query = query.order_by(
            func.lower(func.coalesce(User.localUsername, User.external_username)).asc()
        )
    elif sort == 'username_desc':
        query = query.order_by(
            func.lower(func.coalesce(User.localUsername, User.external_username)).desc()
        )
    elif sort == 'created_asc':
        query = query.order_by(User.created_at.asc())
    else:
        query = query.order_by(User.created_at.desc())

    pagination = query.paginate(page=page, per_page=page_size, error_out=False)

    items = []
    for user in pagination.items:
        user_data = {
            'id': user.id,
            'uuid': user.uuid,
            'username': user.localUsername or user.external_username,
            'email': user.email or user.discord_email,
            'external_email': user.external_email,
            'user_type': user.userType.value,
            'display_name': user.get_display_name() if hasattr(user, 'get_display_name') else None,
            'avatar_url': _get_avatar_url(user),
            'created_at': user.created_at.isoformat() if user.created_at else None,
            'last_login_at': user.last_login_at.isoformat() if user.last_login_at else None,
            'is_active': user.is_active,
            'admin_roles': [role.name for role in user.admin_roles],
            'user_roles': [
                {
                    'name': role.name,
                    'color': getattr(role, 'color', None),
                    'icon': getattr(role, 'icon', None),
                    'badge_style': getattr(role, 'badge_style', None),
                    'description': getattr(role, 'description', None)
                }
                for role in getattr(user, 'user_roles', [])
            ],
            'linked_service_count': len(getattr(user, 'linked_children', []))
        }

        if user.userType == UserType.SERVICE and user.linkedUserId:
            linked_parent = User.query.filter_by(uuid=user.linkedUserId).first()
            if linked_parent:
                user_data['linked_local_user'] = {
                    'uuid': linked_parent.uuid,
                    'username': linked_parent.localUsername,
                    'display_name': linked_parent.get_display_name() if hasattr(linked_parent, 'get_display_name') else linked_parent.localUsername
                }
        else:
            user_data['linked_local_user'] = None

        # Add server info and libraries for service users
        if user.userType == UserType.SERVICE and user.server:
            user_data['server_nickname'] = user.server.server_nickname
            user_data['service_type'] = user.server.service_type.value
            user_data['service_join_date'] = user.service_join_date.isoformat() if user.service_join_date else None
            user_data['last_streamed_at'] = user.last_activity_at.isoformat() if user.last_activity_at else None

            libraries = []
            has_all_libraries = False

            if user.allowed_library_ids:
                from sqlalchemy import or_

                allowed_ids = [str(value) for value in user.allowed_library_ids]
                libs = MediaLibrary.query.filter(
                    MediaLibrary.server_id == user.server_id,
                    or_(
                        MediaLibrary.external_id.in_(allowed_ids),
                        MediaLibrary.internal_id.in_(allowed_ids)
                    )
                ).all()
                libraries = [library.name for library in libs]
            else:
                has_all_libraries = True

            user_data['libraries'] = libraries
            user_data['has_all_libraries'] = has_all_libraries

        items.append(user_data)

    response = {
        'data': items,
        'meta': {
            'request_id': request_id,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'deprecated': False,
            'pagination': {
                'page': pagination.page,
                'page_size': pagination.per_page,
                'total_items': pagination.total,
                'total_pages': pagination.pages or 1
            },
            'filters': {
                'search': search,
                'user_type': user_type,
                'role': role_filter
            }
        }
    }
    return jsonify(response), 200
