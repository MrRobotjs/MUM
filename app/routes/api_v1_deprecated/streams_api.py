
from uuid import uuid4
from datetime import datetime

from flask import jsonify, request
from flask_login import login_required, current_user
from sqlalchemy import desc, func

from app.routes.api_v1_deprecated import bp
from app.models_media_services import MediaStreamHistory, MediaServer, ServiceType
from app.models import User, EventType
from app.utils.helpers import permission_required, log_event
from app.services.media_service_factory import MediaServiceFactory


def _serialize_stream(stream: MediaStreamHistory):
    return {
        'id': stream.id,
        'user_uuid': stream.user_uuid,
        'media_title': stream.media_title,
        'media_type': stream.media_type,
        'server_id': stream.server_id,
        'server_name': stream.server.server_nickname if stream.server else None,
        'started_at': stream.started_at.isoformat() if stream.started_at else None,
        'stopped_at': stream.stopped_at.isoformat() if stream.stopped_at else None,
        'duration_seconds': stream.duration_seconds,
        'platform': stream.platform,
        'grandparent_title': stream.grandparent_title,
        'parent_title': stream.parent_title,
        'library_name': stream.library_name,
    }


def _apply_filters(query, user_uuid=None, service_type=None, status=None, start_date=None, end_date=None):
    if user_uuid:
        query = query.filter(MediaStreamHistory.user_uuid == user_uuid)
    if service_type:
        try:
            service_enum = ServiceType(service_type)
            query = query.filter(MediaStreamHistory.server.has(service_type=service_enum))
        except ValueError:
            query = query.filter(False)
    if status == 'active':
        query = query.filter(MediaStreamHistory.stopped_at.is_(None))
    elif status == 'completed':
        query = query.filter(MediaStreamHistory.stopped_at.isnot(None))
    if start_date:
        query = query.filter(MediaStreamHistory.started_at >= start_date)
    if end_date:
        query = query.filter(MediaStreamHistory.started_at <= end_date)
    return query


@bp.route('/streams', methods=['GET'])
@login_required
@permission_required('view_streaming')
def list_streams():
    request_id = str(uuid4())
    page = max(1, request.args.get('page', type=int) or 1)
    page_size = max(1, min(request.args.get('page_size', type=int) or 25, 100))
    user_uuid = request.args.get('user_uuid')
    service_type = request.args.get('service_type')
    status = request.args.get('status')
    start_date_str = request.args.get('start')
    end_date_str = request.args.get('end')

    start_dt = None
    end_dt = None
    if start_date_str:
        try:
            start_dt = datetime.fromisoformat(start_date_str)
        except ValueError:
            pass
    if end_date_str:
        try:
            from datetime import timedelta
            end_dt = datetime.fromisoformat(end_date_str)
            # Include entire day if date provided without time
            if end_dt.time().isoformat() == '00:00:00':
                end_dt = end_dt + timedelta(days=1)
        except ValueError:
            pass

    query = MediaStreamHistory.query.order_by(desc(MediaStreamHistory.started_at))
    query = _apply_filters(query, user_uuid, service_type, status, start_dt, end_dt)

    pagination = query.paginate(page=page, per_page=page_size, error_out=False)

    return jsonify({
        'data': [_serialize_stream(stream) for stream in pagination.items],
        'meta': {
            'request_id': request_id,
            'pagination': {
                'page': pagination.page,
                'page_size': pagination.per_page,
                'total_items': pagination.total,
                'total_pages': pagination.pages or 1
            },
            'filters': {
                'user_uuid': user_uuid,
                'service_type': service_type,
                'status': status,
                'start': start_date_str,
                'end': end_date_str
            }
        }
    })


@bp.route('/streams/<int:stream_id>', methods=['GET'])
@login_required
@permission_required('view_streaming')
def get_stream(stream_id):
    request_id = str(uuid4())
    stream = MediaStreamHistory.query.get_or_404(stream_id)
    return jsonify({
        'data': _serialize_stream(stream),
        'meta': {
            'request_id': request_id,
            'deprecated': False
        }
    })


@bp.route('/streams/summary', methods=['GET'])
@login_required
@permission_required('view_streaming')
def streams_summary():
    request_id = str(uuid4())
    start_date_str = request.args.get('start')
    end_date_str = request.args.get('end')
    service_type = request.args.get('service_type')
    user_uuid = request.args.get('user_uuid')

    start_dt = None
    end_dt = None
    if start_date_str:
        try:
            start_dt = datetime.fromisoformat(start_date_str)
        except ValueError:
            start_dt = None
    if end_date_str:
        try:
            from datetime import timedelta
            end_dt = datetime.fromisoformat(end_date_str)
            if end_dt.time().isoformat() == '00:00:00':
                end_dt = end_dt + timedelta(days=1)
        except ValueError:
            end_dt = None

    base_query = _apply_filters(MediaStreamHistory.query, user_uuid, service_type, None, start_dt, end_dt)

    total_streams = base_query.count()
    active_streams = _apply_filters(MediaStreamHistory.query, user_uuid, service_type, 'active', start_dt, end_dt).count()
    completed_streams = _apply_filters(MediaStreamHistory.query, user_uuid, service_type, 'completed', start_dt, end_dt).count()

    total_duration = base_query.with_entities(func.coalesce(func.sum(MediaStreamHistory.duration_seconds), 0)).scalar() or 0
    average_duration = base_query.with_entities(func.coalesce(func.avg(MediaStreamHistory.duration_seconds), 0)).scalar() or 0

    daily_counts = (
        _apply_filters(MediaStreamHistory.query, user_uuid, service_type, None, start_dt, end_dt)
        .with_entities(func.date(MediaStreamHistory.started_at).label('day'), func.count(MediaStreamHistory.id))
        .group_by('day')
        .order_by('day')
        .all()
    )

    per_service = (
        _apply_filters(
            MediaStreamHistory.query.join(MediaServer),
            user_uuid,
            service_type,
            None,
            start_dt,
            end_dt
        )
        .with_entities(MediaServer.service_type, func.count(MediaStreamHistory.id))
        .group_by(MediaServer.service_type)
        .order_by(MediaServer.service_type)
        .all()
    )

    return jsonify({
        'data': {
            'counts': {
                'total': total_streams,
                'active': active_streams,
                'completed': completed_streams
            },
            'duration': {
                'total_seconds': int(total_duration),
                'average_seconds': int(average_duration)
            },
            'daily': [
                {'date': day.isoformat() if hasattr(day, 'isoformat') else str(day), 'count': count}
                for day, count in daily_counts
            ],
            'by_service': [
                {'service_type': svc.value if isinstance(svc, ServiceType) else str(svc), 'count': count}
                for svc, count in per_service
            ]
        },
        'meta': {
            'request_id': request_id,
            'filters': {
                'start': start_date_str,
                'end': end_date_str,
                'service_type': service_type,
                'user_uuid': user_uuid
            },
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        }
    })


@bp.route('/streams/<int:stream_id>/terminate', methods=['POST'])
@login_required
@permission_required('kill_stream')
def terminate_stream(stream_id):
    request_id = str(uuid4())
    payload = request.get_json(silent=True) or {}
    message = payload.get('message')

    stream = MediaStreamHistory.query.get_or_404(stream_id)

    if stream.stopped_at:
        return jsonify({
            'error': {
                'code': 'STREAM_NOT_ACTIVE',
                'message': 'The stream has already ended.'
            },
            'meta': {
                'request_id': request_id
            }
        }), 400

    session_key = stream.session_key or stream.external_session_id
    if not session_key:
        return jsonify({
            'error': {
                'code': 'SESSION_KEY_MISSING',
                'message': 'No session key is stored for this stream; it cannot be terminated.'
            },
            'meta': {
                'request_id': request_id
            }
        }), 400

    server = stream.server
    service = MediaServiceFactory.create_service_from_db(server)

    if not service or not hasattr(service, 'terminate_session'):
        return jsonify({
            'error': {
                'code': 'SERVICE_NOT_SUPPORTED',
                'message': f"{server.service_type.value.capitalize()} does not support remote termination."
            },
            'meta': {
                'request_id': request_id
            }
        }), 400

    try:
        success = service.terminate_session(session_key, message)
    except Exception as exc:
        return jsonify({
            'error': {
                'code': 'TERMINATION_FAILED',
                'message': f'Failed to terminate session: {exc}'
            },
            'meta': {
                'request_id': request_id
            }
        }), 500

    if not success:
        return jsonify({
            'error': {
                'code': 'TERMINATION_FAILED',
                'message': 'The media server did not accept the termination command.'
            },
            'meta': {
                'request_id': request_id
            }
        }), 502

    log_event(
        EventType.SETTING_CHANGE,
        f"Terminated {server.service_type.value} session {session_key} on {server.server_nickname}",
        admin_id=getattr(current_user, 'id', None),
        server_id=server.id
    )

    return jsonify({
        'data': {
            'success': True,
            'message': f'Termination command sent for session {session_key}.'
        },
        'meta': {
            'request_id': request_id
        }
    }), 200
