
from uuid import uuid4
from datetime import datetime

from flask import jsonify, request
from flask_login import login_required
from sqlalchemy import or_

from app.routes.api_v1_deprecated import bp
from app.models import Invite, InviteUsage, Setting, User
from app.models_media_services import MediaLibrary, MediaServer
from app.extensions import db
from app.utils.helpers import permission_required
from app.utils.timezone_utils import utcnow


def _serialize_invite(invite: Invite, detailed: bool = False):
    # Basic server info for list view
    servers_basic = []
    for server in invite.servers:
        servers_basic.append({
            'id': server.id,
            'name': server.server_nickname,
            'service_type': server.service_type.value,
        })

    # Library information for list view
    grant_ids = invite.grant_library_ids or []
    grants_all_libraries = len(grant_ids) == 0
    libraries_info = []

    if not grants_all_libraries and grant_ids:
        # Get library details for the granted IDs
        for lib_id in grant_ids:
            # Find the library across all servers
            for server in invite.servers:
                db_libraries = MediaLibrary.query.filter_by(server_id=server.id).all()
                for db_lib in db_libraries:
                    # Match by internal_id for Kavita, external_id for others
                    identifier = str(db_lib.internal_id) if server.service_type.value.lower() == 'kavita' and db_lib.internal_id else str(db_lib.external_id)
                    if identifier == lib_id:
                        libraries_info.append({
                            'id': lib_id,
                            'name': db_lib.name,
                            'server_name': server.server_nickname,
                            'service_type': server.service_type.value,
                        })
                        break

    base = {
        'id': invite.id,
        'token': invite.token,
        'custom_path': invite.custom_path,
        'expires_at': invite.expires_at.isoformat() if invite.expires_at else None,
        'max_uses': invite.max_uses,
        'current_uses': invite.current_uses,
        'is_active': invite.is_active,
        'grant_library_ids': invite.grant_library_ids,
        'allow_downloads': invite.allow_downloads,
        'created_at': invite.created_at.isoformat() if invite.created_at else None,
        'updated_at': invite.updated_at.isoformat() if invite.updated_at else None,
        'require_discord_auth': bool(invite.require_discord_auth),
        'require_discord_guild_membership': bool(invite.require_discord_guild_membership),
        'servers': servers_basic,  # Include servers in basic view
        'libraries': libraries_info,  # Include library details in basic view
        'grants_all_libraries': grants_all_libraries,  # Flag to indicate "All Libraries"
        'invite_to_plex_home': bool(invite.invite_to_plex_home),
        'allow_live_tv': bool(invite.allow_live_tv),
        'membership_duration_days': invite.membership_duration_days,
    }

    if not detailed:
        return base

    share_base_url = Setting.get('APP_BASE_URL')
    share_url = invite.get_full_url(share_base_url) if share_base_url else None
    grant_ids = invite.grant_library_ids or []
    grants_all_libraries = grant_ids == []  # Empty list signifies all libraries

    servers_data = []
    for server in invite.servers:
        libraries = []
        db_libraries = MediaLibrary.query.filter_by(server_id=server.id).all()

        for lib in db_libraries:
            identifier = None
            if server.service_type.value.lower() == 'kavita' and lib.internal_id:
                identifier = str(lib.internal_id)
            else:
                identifier = str(lib.external_id)

            libraries.append({
                'id': identifier,
                'name': lib.name,
                'library_type': lib.library_type,
                'selected': True if grants_all_libraries else identifier in grant_ids,
                'external_id': lib.external_id,
                'internal_id': lib.internal_id,
            })

        servers_data.append({
            'id': server.id,
            'name': server.server_nickname,
            'service_type': server.service_type.value,
            'url': server.url,
            'public_url': server.public_url,
            'is_active': server.is_active,
            'libraries': libraries,
        })

    usages = sorted(invite.invite_usages, key=lambda usage: usage.used_at or utcnow(), reverse=True)
    usage_data = []
    accepted_count = 0
    plex_success_count = 0
    discord_success_count = 0

    for usage in usages:
        accepted_count += 1 if usage.accepted_invite else 0
        plex_success_count += 1 if usage.plex_auth_successful else 0
        discord_success_count += 1 if usage.discord_auth_successful else 0
        usage_data.append({
            'id': usage.id,
            'used_at': usage.used_at.isoformat() if usage.used_at else None,
            'ip_address': usage.ip_address,
            'plex_username': usage.plex_username,
            'plex_email': usage.plex_email,
            'discord_username': usage.discord_username,
            'discord_user_id': usage.discord_user_id,
            'accepted_invite': usage.accepted_invite,
            'status_message': usage.status_message,
            'user_uuid': usage.userId,
            'plex_auth_successful': usage.plex_auth_successful,
            'discord_auth_successful': usage.discord_auth_successful,
        })

    remaining_uses = None
    if invite.max_uses is not None:
        remaining_uses = max(invite.max_uses - invite.current_uses, 0)

    base.update({
        'share_url': share_url,
        'is_expired': invite.is_expired,
        'has_reached_max_uses': invite.has_reached_max_uses,
        'is_usable': invite.is_usable,
        'remaining_uses': remaining_uses,
        'membership_duration_days': invite.membership_duration_days,
        'require_discord_auth': bool(invite.require_discord_auth),
        'require_discord_guild_membership': bool(invite.require_discord_guild_membership),
        'grant_purge_whitelist': bool(invite.grant_purge_whitelist),
        'grant_bot_whitelist': bool(invite.grant_bot_whitelist),
        'invite_to_plex_home': bool(invite.invite_to_plex_home),
        'allow_live_tv': bool(invite.allow_live_tv),
        'servers': servers_data,
        'library_selection_mode': 'all' if grants_all_libraries else 'custom',
        'usage': usage_data,
        'usage_summary': {
            'total': len(usage_data),
            'accepted': accepted_count,
            'pending': len(usage_data) - accepted_count,
            'plex_auth_successful': plex_success_count,
            'discord_auth_successful': discord_success_count,
            'last_used_at': usage_data[0]['used_at'] if usage_data else None,
        },
        'creator': {
            'id': invite.created_by_owner_id,
            'display_name': invite.owner_creator.get_display_name() if isinstance(invite.owner_creator, User) and hasattr(invite.owner_creator, 'get_display_name') else None,
        } if invite.created_by_owner_id else None,
    })

    return base


@bp.route('/invites', methods=['GET'])
@login_required
@permission_required('manage_invites')
def list_invites():
    request_id = str(uuid4())
    page = max(1, request.args.get('page', type=int) or 1)
    page_size = max(1, min(request.args.get('page_size', type=int) or 25, 100))
    status = request.args.get('status')
    search = (request.args.get('search') or '').strip()
    server_id = request.args.get('server_id', type=int)

    query = Invite.query.order_by(Invite.created_at.desc())
    now = utcnow()

    if status == 'active':
        query = query.filter(Invite.is_active.is_(True))
    elif status == 'inactive':
        query = query.filter(Invite.is_active.is_(False))
    elif status == 'expired':
        query = query.filter(Invite.expires_at.isnot(None), Invite.expires_at < now)
    elif status == 'maxed':
        query = query.filter(Invite.max_uses.isnot(None), Invite.current_uses >= Invite.max_uses)
    elif status == 'usable':
        query = query.filter(
            Invite.is_active.is_(True),
            or_(Invite.expires_at.is_(None), Invite.expires_at >= now),
            or_(Invite.max_uses.is_(None), Invite.current_uses < Invite.max_uses)
        )

    if search:
        like_pattern = f"%{search}%"
        query = query.filter(
            or_(
                Invite.token.ilike(like_pattern),
                Invite.custom_path.ilike(like_pattern)
            )
        )

    if server_id:
        query = query.filter(Invite.servers.any(MediaServer.id == server_id))

    pagination = query.paginate(page=page, per_page=page_size, error_out=False)

    return jsonify({
        'data': [_serialize_invite(inv) for inv in pagination.items],
        'meta': {
            'request_id': request_id,
            'pagination': {
                'page': pagination.page,
                'page_size': pagination.per_page,
                'total_items': pagination.total,
                'total_pages': pagination.pages or 1
            },
            'filters': {'status': status, 'search': search, 'server_id': server_id}
        }
    })


@bp.route('/invites/<int:invite_id>', methods=['GET'])
@login_required
@permission_required('manage_invites')
def get_invite(invite_id):
    request_id = str(uuid4())
    invite = Invite.query.get_or_404(invite_id)
    return jsonify({'data': _serialize_invite(invite, detailed=True), 'meta': {'request_id': request_id}})


@bp.route('/invites/summary', methods=['GET'])
@login_required
@permission_required('manage_invites')
def invite_summary():
    request_id = str(uuid4())
    now = utcnow()

    base_query = Invite.query
    total = base_query.count()
    active = base_query.filter(Invite.is_active.is_(True)).count()
    inactive = base_query.filter(Invite.is_active.is_(False)).count()
    expired = base_query.filter(Invite.expires_at.isnot(None), Invite.expires_at < now).count()
    maxed = base_query.filter(Invite.max_uses.isnot(None), Invite.current_uses >= Invite.max_uses).count()
    usable = base_query.filter(
        Invite.is_active.is_(True),
        or_(Invite.expires_at.is_(None), Invite.expires_at >= now),
        or_(Invite.max_uses.is_(None), Invite.current_uses < Invite.max_uses)
    ).count()

    recent_invites = base_query.order_by(Invite.created_at.desc()).limit(5).all()
    recent_usages = InviteUsage.query.order_by(InviteUsage.used_at.desc()).limit(5).all()

    recent_invite_payload = [
        {
            'id': invite.id,
            'token': invite.token,
            'custom_path': invite.custom_path,
            'created_at': invite.created_at.isoformat() if invite.created_at else None,
            'is_active': invite.is_active,
            'is_expired': invite.is_expired,
            'has_reached_max_uses': invite.has_reached_max_uses,
            'current_uses': invite.current_uses,
            'max_uses': invite.max_uses,
        }
        for invite in recent_invites
    ]

    recent_usage_payload = [
        {
            'id': usage.id,
            'invite_id': usage.invite_id,
            'used_at': usage.used_at.isoformat() if usage.used_at else None,
            'accepted_invite': usage.accepted_invite,
            'plex_username': usage.plex_username,
            'discord_username': usage.discord_username,
            'status_message': usage.status_message,
        }
        for usage in recent_usages
    ]

    return jsonify({
        'data': {
            'counts': {
                'total': total,
                'active': active,
                'inactive': inactive,
                'expired': expired,
                'maxed': maxed,
                'usable': usable,
            },
            'recent_invites': recent_invite_payload,
            'recent_usages': recent_usage_payload,
        },
        'meta': {
            'request_id': request_id,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/invites', methods=['POST'])
@login_required
@permission_required('manage_invites')
def create_invite():
    request_id = str(uuid4())
    payload = request.get_json() or {}
    invite = Invite(
        custom_path=payload.get('custom_path'),
        expires_at=datetime.fromisoformat(payload['expires_at']) if payload.get('expires_at') else None,
        max_uses=payload.get('max_uses'),
        grant_library_ids=payload.get('grant_library_ids', []),
        allow_downloads=payload.get('allow_downloads', False),
        is_active=payload.get('is_active', True)
    )
    db.session.add(invite)
    db.session.commit()
    return jsonify({'data': _serialize_invite(invite), 'meta': {'request_id': request_id}}), 201


@bp.route('/invites/<int:invite_id>', methods=['PATCH'])
@login_required
@permission_required('manage_invites')
def update_invite(invite_id):
    request_id = str(uuid4())
    payload = request.get_json() or {}
    invite = Invite.query.get_or_404(invite_id)

    if 'custom_path' in payload:
        invite.custom_path = payload['custom_path']
    if 'expires_at' in payload:
        invite.expires_at = datetime.fromisoformat(payload['expires_at']) if payload['expires_at'] else None
    if 'max_uses' in payload:
        invite.max_uses = payload['max_uses']
    if 'grant_library_ids' in payload:
        invite.grant_library_ids = payload['grant_library_ids']
    if 'allow_downloads' in payload:
        invite.allow_downloads = payload['allow_downloads']
    if 'is_active' in payload:
        invite.is_active = payload['is_active']

    db.session.commit()
    return jsonify({'data': _serialize_invite(invite), 'meta': {'request_id': request_id}})


@bp.route('/invites/<int:invite_id>', methods=['DELETE'])
@login_required
@permission_required('manage_invites')
def delete_invite(invite_id):
    request_id = str(uuid4())
    invite = Invite.query.get_or_404(invite_id)
    db.session.delete(invite)
    db.session.commit()
    return jsonify({'data': {'success': True}, 'meta': {'request_id': request_id}})
