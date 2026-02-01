
from uuid import uuid4

from flask import jsonify
from flask_login import login_required, current_user

from app.routes.api_v1_deprecated import bp
from app.models import User
from app.utils.helpers import permission_required
from app.extensions import db


@bp.route('/users/<string:user_uuid>/reset-password', methods=['POST'])
@login_required
@permission_required('edit_user')
def reset_user_password(user_uuid):
    request_id = str(uuid4())
    user = User.query.filter_by(uuid=user_uuid).first_or_404()

    if user.userType not in {User.UserType.LOCAL, User.UserType.OWNER}:
        return jsonify({
            'error': {
                'code': 'UNSUPPORTED_USER_TYPE',
                'message': 'Password reset is only supported for local or owner accounts.'
            },
            'meta': {
                'request_id': request_id
            }
        }), 400

    user.force_password_change = True
    db.session.commit()


    response = {
        'data': {
            'success': True,
            'message': 'Password reset flagged. User will be prompted to set a new password on next login.'
        },
        'meta': {
            'request_id': request_id
        }
    }
    return jsonify(response), 200