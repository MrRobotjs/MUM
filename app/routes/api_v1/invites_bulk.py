
from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required

from app.routes.api_v1 import bp
from app.models import Invite
from app.extensions import db
from app.utils.helpers import permission_required


@bp.route('/invites/bulk', methods=['POST'])
@login_required
@permission_required('manage_invites')
def bulk_invite_action():
    request_id = str(uuid4())
    payload = request.get_json() or {}
    ids = payload.get('ids', [])
    action = payload.get('action')

    if not ids or action not in {'enable', 'disable', 'delete'}:
        return jsonify({
            'error': {
                'code': 'INVALID_BULK_REQUEST',
                'message': 'Provide ids list and action of enable/disable/delete.'
            },
            'meta': {'request_id': request_id}
        }), 400

    invites = Invite.query.filter(Invite.id.in_(ids)).all()

    if action == 'delete':
        for invite in invites:
            db.session.delete(invite)
    else:
        active_state = action == 'enable'
        for invite in invites:
            invite.is_active = active_state

    db.session.commit()

    return jsonify({
        'data': {
            'success': True,
            'processed_ids': [invite.id for invite in invites],
            'action': action
        },
        'meta': {'request_id': request_id}
    })
