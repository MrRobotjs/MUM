
"""DEPRECATED: SSR user preferences routes replaced by API v2.

Use /api/v2/account/timezone for updating preferences.
"""
from flask import Blueprint, render_template, redirect, url_for, flash
from flask_login import login_required, current_user
from app.forms import TimezonePreferenceForm
from app.models import User, UserType, UserPreferences

user_preferences_bp = Blueprint('user_preferences', __name__)

@user_preferences_bp.route('/timezone', methods=['POST'])
@login_required
def set_timezone():
    form = TimezonePreferenceForm()
    if form.validate_on_submit():
        UserPreferences.set_timezone_preference(
            admin_id=current_user.id,
            preference=form.timezone_preference.data,
            local_timezone=form.local_timezone.data,
            time_format=form.time_format.data
        )
        flash('Timezone preference saved.', 'success')
    else:
        flash('Could not save timezone preference.', 'error')
    return redirect('/admin/settings/general')
