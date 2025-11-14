from __future__ import annotations

from flask import current_app
from sqlalchemy import inspect

from app.extensions import db
from app.models import User, Setting
from app.models_media_services import MediaServer


def get_completed_steps() -> set[str]:
    completed: set[str] = set()
    owner_table_exists_steps = False
    try:
        inspector = inspect(db.engine)
        owner_table_exists_steps = inspector.has_table(User.__tablename__)
    except Exception as e:
        current_app.logger.error(f"DB inspection error in get_completed_steps: {e}")

    if owner_table_exists_steps and User.get_owner():
        completed.add('account')
    if Setting.get('APP_BASE_URL'):
        completed.add('app')

    # Check if at least one media server exists (any type)
    try:
        has_server = db.session.query(MediaServer.id).limit(1).first()
        if has_server:
            completed.add('plugins')
    except Exception:
        pass

    return completed


def is_setup_finished() -> bool:
    """Check if the initial setup has been completed by the user."""
    setup_complete = Setting.get('SETUP_COMPLETE')
    if setup_complete is not None:
        if isinstance(setup_complete, bool):
            return setup_complete
        if isinstance(setup_complete, str):
            return setup_complete.lower() == 'true'
    return False


def mark_setup_complete() -> None:
    """Mark the initial setup as complete."""
    Setting.set('SETUP_COMPLETE', 'true')
    db.session.commit()
