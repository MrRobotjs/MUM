from uuid import uuid4

from flask import jsonify, request
from flask_login import login_required, current_user

from app.routes.api_v1 import bp
from app.models import Setting, SettingValueType, EventType
from app.utils.helpers import permission_required, log_event


def _serialize_user_account_settings():
    return {
        'allow_user_accounts': Setting.get_bool('ALLOW_USER_ACCOUNTS', False)
    }


@bp.route('/settings/user-accounts', methods=['GET'])
@login_required
@permission_required('manage_users_general')
def get_user_account_settings():
    request_id = str(uuid4())
    return jsonify({'data': _serialize_user_account_settings(), 'meta': {'request_id': request_id}})


@bp.route('/settings/user-accounts', methods=['PATCH'])
@login_required
@permission_required('manage_users_general')
def update_user_account_settings():
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}

    allow_accounts = bool(payload.get('allow_user_accounts', False))

    Setting.set('ALLOW_USER_ACCOUNTS', allow_accounts, SettingValueType.BOOLEAN, "Allow User Accounts")
    log_event(EventType.SETTING_CHANGE, "User account settings updated via API.", admin_id=current_user.id)

    return jsonify({'data': _serialize_user_account_settings(), 'meta': {'request_id': request_id}}), 200

