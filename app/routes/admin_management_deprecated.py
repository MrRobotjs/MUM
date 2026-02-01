# File: app/routes/admin_management.py
from flask import (
    Blueprint, render_template, redirect, url_for, 
    flash, request, current_app, make_response
)
from flask_login import login_required, current_user
from app.models import User, UserType, AdminRole, UserRole
from app.forms import AdminCreateForm, LocalUserEditForm, UserResetPasswordForm
from app.extensions import db
from app.utils.helpers import setup_required, permission_required, any_permission_required
import json

bp = Blueprint('admin_management', __name__)

@bp.route('/')
@login_required
@any_permission_required(['create_admin', 'edit_admin', 'delete_admin'])
def index():
    # Get Owner and LOCAL users with Staff role (indicating admin access)
    owner = User.get_owner()
    staff_users = UserRole.get_staff_users()  # Only show users with Staff role
    return render_template(
        'settings/index.html',
        title="Manage Admins",
        owner=owner,
        admins=staff_users,  # Changed from app_users to admins
        active_tab='admins'
    )

@bp.route('/create', methods=['POST'])
@login_required
@permission_required('create_admin')
def create():
    from flask import current_app
    current_app.logger.info(f"Admin creation attempt - Request data: {request.form}")
    
    form = AdminCreateForm()
    current_app.logger.info(f"Form CSRF token: {form.csrf_token.data if hasattr(form, 'csrf_token') else 'No CSRF field'}")
    current_app.logger.info(f"Form validation errors: {form.errors}")
    
    if form.validate_on_submit():
        try:
            current_app.logger.info("Form validation passed, creating admin user")
            # Create admin user with automatic Staff role assignment
            new_user = User.create_admin_user(
                username=form.username.data,
                password=form.password.data,
                email=None  # AdminCreateForm doesn't have email field
            )
            new_user.force_password_change = True
            db.session.add(new_user)
            db.session.commit()
            
            current_app.logger.info(f"Admin user '{new_user.localUsername}' created successfully")
            toast = {"showToastEvent": {"message": f"Admin user '{new_user.localUsername}' created with Staff role.", "category": "success"}}
            response = make_response("", 204) # No Content
            response.headers['HX-Trigger'] = json.dumps({"refreshAdminList": True, **toast})
            return response
            
        except Exception as e:
            current_app.logger.error(f"Error creating admin user: {str(e)}")
            db.session.rollback()
            form.username.errors.append("Error creating user. Please try again.")
    else:
        current_app.logger.warning(f"Form validation failed: {form.errors}")
    
    # If validation fails, re-render the form partial with errors
    return render_template('settings/admins/_partials/create_admin_modal.html', form=form), 422

@bp.route('/create_form')
@login_required
@permission_required('create_admin')
def create_form():
    form = AdminCreateForm()
    return render_template('settings/admins/_partials/create_admin_modal.html', form=form)

@bp.route('/delete/<int:admin_id>', methods=['POST'])
@login_required
@permission_required('delete_admin')
def delete(admin_id):
    # Prevent deletion of Owner or current user
    if admin_id == current_user.id:
        flash("You cannot delete your own account.", "danger")
        return redirect(url_for('admin_management.index'))
    
    # Check if this is the Owner (cannot be deleted)
    if current_user.userType == UserType.OWNER and admin_id == current_user.id:
        flash("The Owner account cannot be deleted.", "danger")
        return redirect(url_for('admin_management.index'))
    
    user_to_delete = User.query.filter_by(id=admin_id, userType=UserType.LOCAL).first_or_404()
    db.session.delete(user_to_delete)
    db.session.commit()
    flash(f"User '{user_to_delete.localUsername}' has been deleted.", "success")
    return redirect(url_for('admin_management.index'))

@bp.route('/edit/<int:admin_id>', methods=['GET', 'POST'])
@login_required
@permission_required('edit_admin')
def edit(admin_id):
    user = User.query.filter_by(userType=UserType.LOCAL).get_or_404(admin_id)

    # Prevent editing Owner account through this interface
    if current_user.userType == UserType.OWNER and admin_id == current_user.id:
        flash("The Owner account should be managed through the 'My Account' page.", "warning")
        return redirect(url_for('admin_management.index'))
    
    if admin_id == current_user.id:
        flash("To manage your own account, please use the 'My Account' page.", "info")
        return redirect(url_for('dashboard.account'))
        
    form = LocalUserEditForm(obj=user)
    form.roles.choices = [(r.id, r.name) for r in AdminRole.query.order_by('name')]

    if form.validate_on_submit():
        # Update admin roles (will automatically manage Staff visual role)
        selected_roles = AdminRole.query.filter(AdminRole.id.in_(form.roles.data)).all()
        user.set_admin_roles(selected_roles)
        db.session.commit()
        flash(f"Admin roles for '{user.localUsername}' updated.", "success")
        return redirect(url_for('admin_management.index'))
        
    if request.method == 'GET':
        form.roles.data = [r.id for r in user.admin_roles]

    return render_template(
        'settings/admins/edit.html',
        title="Edit User",
        admin=user,
        form=form,
        active_tab='admins'
    )

@bp.route('/reset_password/<int:admin_id>', methods=['GET', 'POST'])
@login_required
@permission_required('edit_admin')
def reset_password(admin_id):
    user = User.query.filter_by(userType=UserType.LOCAL).get_or_404(admin_id)
    if admin_id == current_user.id:
        flash("You cannot reset your own password through this interface.", "danger")
        return redirect(url_for('admin_management.edit', admin_id=admin_id))
    
    # Prevent resetting Owner password through this interface
    if current_user.userType == UserType.OWNER and admin_id == current_user.id:
        flash("Owner password should be reset through the 'My Account' page.", "danger")
        return redirect(url_for('admin_management.edit', admin_id=admin_id))
    
    form = UserResetPasswordForm()

    if request.method == 'POST':
        if form.validate_on_submit():
            user.set_password(form.new_password.data)
            user.force_password_change = True # Force change on next login
            db.session.commit()
            
            toast = {"showToastEvent": {"message": "Password has been reset.", "category": "success"}}
            response = make_response("", 204)
            response.headers['HX-Trigger'] = json.dumps(toast)
            return response
        else:
            # Re-render form with validation errors for HTMX
            return render_template('settings/admins/_partials/reset_password_modal.html', form=form, admin=user), 422
    
    # For GET request, just render the form
    return render_template('settings/admins/_partials/reset_password_modal.html', form=form, admin=user)
# DEPRECATED: Legacy Flask SSR admin management routes. Replaced by React SPA.