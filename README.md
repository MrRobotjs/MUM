# Multimedia User Management (MUM)

[![Docker Image CI](https://github.com/MrRobotjs/MUM/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/MrRobotjs/MUM/actions/workflows/docker-publish.yml)
[![GitHub stars](https://img.shields.io/github/stars/MrRobotjs/MUM.svg?style=social&label=Star&maxAge=2592000)](https://github.com/MrRobotjs/MUM/stargazers/)
[![](https://dcbadge.limes.pink/api/server/https://discord.gg/QGHQWpGNgX)](https://discord.gg/QGHQWpGNgX)
[![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?business=D7BJAJ9ZY4GRC&no_recurring=0&currency_code=USD)

MUM (Multimedia User Management) is a comprehensive, self-hosted web application that centralizes user management across multiple media servers and services. Built with a modern plugin architecture, MUM provides administrators with a unified dashboard to manage users, create sophisticated invite systems, monitor streaming activity, and maintain library access across diverse media platforms - all from one intuitive interface.

| Dashboard | Invites |
| :---: | :---: |
| WIP | WIP |
| Users | Streaming |
| WIP | WIP |

## Key Features

*   **Comprehensive Service Support:**
    *   **Plex:** User Management, Library Sharing Management, real-time session monitoring, Plex Home integration
    *   **Jellyfin & Emby:** User Management, Library Sharing Management, real-time session monitoring
    *   **Kavita & Komga:** User Management, Library Sharing Management
    *   **AudioBookshelf:** User Management, Library Sharing Management, real-time session monitoring
    *   **RomM:** User Management
*   **Intelligent User Management:**
    *   Unified dashboard displaying users across all connected services
    *   Granular library access control with service-specific permissions
    *   Bulk operations for efficient mass user management
    *   Service-specific role detection and badge display
*   **Sophisticated Invite System:**
    *   Multi-server invite creation with cross-platform library selection
    *   Flexible expiration policies and usage limitations
    *   Service-specific permission templates and access controls
    *   Temporary membership with automated lifecycle management
    *   Custom invite paths and branding options
*   **Advanced Discord Integration:** (WIP)
    *   OAuth-based account linking with server membership validation
    *   Conditional invite acceptance based on Discord status
    *   Guild membership requirements with administrative controls
*   **Real-Time Monitoring & Analytics:**
    *   Live streaming session monitoring across all services
    *   Service-specific activity tracking and user engagement metrics
    *   Remote session termination capabilities
    *   Comprehensive logging and debugging tools
*   **Automated Lifecycle Management:**
    *   Intelligent user purging based on activity patterns
    *   Whitelist protection for critical users
    *   Automated membership expiration handling
    *   Service-specific cleanup and maintenance routines

## Docker Deployment

The easiest way to deploy MUM is with Docker.

### Docker Compose

1.  **Create a `docker-compose.yml` file:**
    ```yaml
    services:
      mum:
        image: ghcr.io/mrrobotjs/mum:latest # Highly encouraged to check github releases and use the latest version instead of using ‘latest’
        container_name: mum
        restart: unless-stopped
        depends_on:
          - postgres
        ports:
          - "5699:5000" # Host port → React/Flask entrypoint
        volumes:
          - ./multimediausermanager:/app/instance
        environment:
          - TZ=America/New_York # REQUIRED: Set your local timezone
          - PUID=1000 # REQUIRED: User ID for file permissions
          - PGID=1000 # REQUIRED: Group ID for file permissions
          - FLASK_LOG_LEVEL=INFO # Change to DEBUG for developer debugging
          - SOCKETIO_ASYNC_MODE=eventlet # SocketIO async mode: eventlet for Gunicorn production, threading for Flask dev server
          - DATABASE_URL=postgresql+psycopg://mum:mum_pass@postgres:5432/mum
          - FLASK_PORT=5000 # Internal Flask API port (mirrors gunicorn bind)
          - FRONTEND_PORT=5000 # Port exposed for the React frontend - vite development (defaults to Flask port)
      postgres:
        image: postgres:18.1
        container_name: mum_postgres
        restart: unless-stopped
        ports:
          - "5432:5432"
        environment:
          - POSTGRES_USER=mum
          - POSTGRES_PASSWORD=mum_pass
          - POSTGRES_DB=mum
          - PGDATA=/var/lib/postgresql/18/docker
        volumes:
          - ./multimediausermanager/db:/var/lib/postgresql
    ```

2.  **Prepare Host Directory:**
    Create the directory on your host machine that you specified in the `volumes` section.
    ```bash
    mkdir ./multimediausermanager
    ```
    This directory will store application data and logs.
    The PostgreSQL data directory will be stored in `./multimediausermanager/db`.

3.  **Customize and Run:**
    *   Adjust the port mapping (`5699:5000`) if the host port is in use.
    *   Set the `TZ` environment variable to your local timezone (e.g., `Europe/London`).
    *   Run the application:
        ```bash
        docker-compose up -d
        ```

4.  **Initial Setup:**
    *   Access MUM in your browser at `http://<your_host_ip>:<host_port>` (e.g., `http://localhost:5699`).
    *   Follow the on-screen setup wizard to create an admin account, configure your media servers, and set the application's base URL.

## Configuration

MUM provides comprehensive configuration management through an intuitive web interface. All settings are accessible post-setup and include:

*   **General Settings:** 
    *   Application branding (name, description, base URL)
    *   Timezone configuration and localization preferences
    *   Global feature toggles and operational modes
*   **Plugin Management:**
    *   Enable, disable, and configure individual media service plugins
    *   Per-service connection testing and validation
    *   Service-specific settings and authentication methods
    *   Library synchronization and access control policies
*   **Discord Integration:** (WIP)
    *   OAuth application setup with client credentials
    *   Bot token configuration for advanced features
    *   Guild membership requirements and validation
    *   Feature-specific toggles (SSO, membership enforcement)
*   **User Account System:**
    *   Local user account creation and management
    *   Account linking policies between services
    *   Permission templates and role assignments
*   **Administrative Controls:**
    *   Multi-admin support with granular permissions
    *   Role-based access control (RBAC) system
    *   Administrative audit logging and activity tracking
*   **Advanced Configuration:**
    *   Security key regeneration and encryption settings
    *   Database maintenance and backup utilities
    *   Raw configuration editor for advanced users
    *   System diagnostics and health monitoring

## Frontend Development

The admin experience is being migrated to a React SPA that lives in `frontend/`.

- Install dependencies: `npm install` inside `frontend/`.
- Local development: `npm run dev` (honors `FRONTEND_PORT`, defaults to 5173) and proxies API calls to the Flask backend specified by `FLASK_PORT`.
- Production build: `npm run build` emits assets into `app/static/dist`, which Flask serves alongside existing Jinja templates during the transition.
- Docker users can change the host port by editing the left side of the `ports` mapping (e.g., `5699:5000`). Only change `FLASK_PORT` if you also change the container-side port (right side).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue.
