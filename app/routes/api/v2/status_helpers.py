from __future__ import annotations

from datetime import datetime

from flask import current_app

from app.extensions import db
from app.services.media_service_factory import MediaServiceFactory
from app.services.media_service_manager import MediaServiceManager


def get_stored_server_status() -> dict | None:
    """Get server status from database (last known status). Copied for v2 usage."""
    all_servers = MediaServiceManager.get_all_servers(active_only=True)
    server_count = len(all_servers)
    current_app.logger.debug(f"API v2: Found {server_count} servers to get stored status")

    if server_count == 0:
        return None
    elif server_count == 1:
        server = all_servers[0]
        return {
            'server_id': server.id,
            'name': f"{server.service_type.value.title()} Server Status",
            'service_type': server.service_type.value,
            'friendly_name': server.server_nickname,
            'actual_server_name': server.server_name,
            'online': server.last_status,
            'last_check_time': server.last_status_check,
            'error_message': server.last_status_error,
            'version': server.last_version,
            'url': server.url,
        }
    else:
        online_count = 0
        offline_count = 0
        all_server_statuses: list[dict] = []
        servers_by_service: dict[str, dict] = {}

        for server in all_servers:
            status = {
                'server_id': server.id,
                'name': server.server_nickname,
                'service_type': server.service_type.value,
                'online': server.last_status,
                'last_check_time': server.last_status_check,
                'error_message': server.last_status_error,
                'version': server.last_version,
                'url': server.url,
                'actual_server_name': server.server_name,
            }

            if server.last_status is True:
                online_count += 1
            elif server.last_status is False:
                offline_count += 1

            all_server_statuses.append(status)

            service_type = server.service_type.value
            if service_type not in servers_by_service:
                servers_by_service[service_type] = {
                    'service_name': service_type.title(),
                    'servers': [],
                    'online_count': 0,
                    'offline_count': 0,
                    'total_count': 0,
                }

            servers_by_service[service_type]['servers'].append(status)
            servers_by_service[service_type]['total_count'] += 1
            if server.last_status is True:
                servers_by_service[service_type]['online_count'] += 1
            elif server.last_status is False:
                servers_by_service[service_type]['offline_count'] += 1

        return {
            'multi_server': True,
            'online_count': online_count,
            'offline_count': offline_count,
            'all_statuses': all_server_statuses,
            'servers_by_service': servers_by_service,
        }


def get_fresh_server_status() -> dict:
    """Fetch fresh server status data from all servers - NO CACHING. Copied for v2 usage."""
    current_app.logger.info("API v2: get_fresh_server_status() called - fetching real-time server status")
    all_servers = MediaServiceManager.get_all_servers(active_only=True)
    server_count = len(all_servers)
    current_app.logger.debug(f"API v2: Found {server_count} servers to check status")
    server_status_data: dict = {}

    if server_count == 1:
        server = all_servers[0]
        current_app.logger.warning(
            f"API v2: Making API call to single server '{server.server_nickname}' ({server.service_type.value})"
        )
        service = MediaServiceFactory.create_service_from_db(server)
        if service:
            server_status_data = service.get_server_info()
            actual_server_name = server_status_data.get('name', server.server_nickname)

            server.last_status_check = datetime.utcnow()
            server.last_status = server_status_data.get('online')
            server.last_status_error = (
                server_status_data.get('error_message') if not server_status_data.get('online') else None
            )
            server.last_version = (
                server_status_data.get('version') if server_status_data.get('online') else server.last_version
            )
            server.server_name = (
                actual_server_name if server_status_data.get('online') else server.server_name
            )
            db.session.add(server)

            try:
                db.session.commit()
                current_app.logger.debug("API v2: Single server status update committed to database")
            except Exception as e:
                current_app.logger.error(f"API v2: Error committing single server status update: {e}")
                db.session.rollback()

            server_status_data['server_id'] = server.id
            server_status_data['name'] = f"{server.service_type.value.title()} Server Status"
            server_status_data['service_type'] = server.service_type.value
            server_status_data['friendly_name'] = actual_server_name
            server_status_data['last_check_time'] = server.last_status_check
            current_app.logger.debug(
                f"API v2: Single server status: {server_status_data.get('online', 'unknown')}"
            )
    elif server_count > 1:
        online_count = 0
        offline_count = 0
        all_server_statuses: list[dict] = []
        servers_by_service: dict[str, dict] = {}

        current_app.logger.warning(
            f"API v2: Making API calls to {len(all_servers)} servers for status check"
        )
        for server in all_servers:
            current_app.logger.warning(
                f"API v2: Making API call to server '{server.server_nickname}' ({server.service_type.value}) at {server.url}"
            )
            service = MediaServiceFactory.create_service_from_db(server)
            if service:
                status = service.get_server_info()
                current_app.logger.info(
                    f"API v2: Server '{server.server_nickname}' status: {status.get('online', 'unknown')} - "
                    f"Error: {status.get('error_message', 'None')}"
                )

                actual_server_name = status.get('name', server.server_nickname)

                server.last_status_check = datetime.utcnow()
                server.last_status = status.get('online')
                server.last_status_error = status.get('error_message') if not status.get('online') else None
                server.last_version = status.get('version') if status.get('online') else server.last_version
                server.server_name = actual_server_name if status.get('online') else server.server_name
                db.session.add(server)

                status['server_id'] = server.id
                status['custom_name'] = server.server_nickname
                status['actual_server_name'] = actual_server_name
                status['name'] = server.server_nickname
                status['service_type'] = server.service_type.value
                all_server_statuses.append(status)

                service_type = server.service_type.value
                if service_type not in servers_by_service:
                    servers_by_service[service_type] = {
                        'service_name': service_type.title(),
                        'servers': [],
                        'online_count': 0,
                        'offline_count': 0,
                        'total_count': 0,
                    }

                servers_by_service[service_type]['servers'].append(status)
                servers_by_service[service_type]['total_count'] += 1
                if status.get('online'):
                    online_count += 1
                    servers_by_service[service_type]['online_count'] += 1
                else:
                    offline_count += 1
                    servers_by_service[service_type]['offline_count'] += 1

        try:
            db.session.commit()
            current_app.logger.debug("API v2: Server status updates committed to database")
        except Exception as e:
            current_app.logger.error(f"API v2: Error committing server status updates: {e}")
            db.session.rollback()

        server_status_data = {
            'multi_server': True,
            'online_count': online_count,
            'offline_count': offline_count,
            'all_statuses': all_server_statuses,
            'servers_by_service': servers_by_service,
        }

    return server_status_data

