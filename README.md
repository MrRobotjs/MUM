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

## Installation

MUM is a single program file with everything built in: no Python, Node.js, database server or Docker needed. Download the file for your system from the releases page, start it, and open `http://localhost:5699` to run the setup wizard. [deploy/GETTING_STARTED.md](deploy/GETTING_STARTED.md) covers every step, including backups, updates, opening MUM to other people (port forwarding or a reverse proxy with HTTPS) and first-launch warnings for unsigned programs.

### Docker Compose

Docker is optional. A minimal `docker-compose.yml`:

```yaml
services:
  mum:
    image: ghcr.io/mrrobotjs/mum:latest # consider pinning a release tag instead of latest
    restart: unless-stopped
    ports:
      - "5699:5699" # host:container; change the left side to use another host port
    volumes:
      - mum-data:/data # SQLite database, keys and mum-config.json; back this up
    environment:
      TZ: America/New_York # your time zone
      # Behind a reverse proxy, trust it for the real client address and HTTPS:
      # MUM_TRUSTED_PROXIES: "172.16.0.0/12"
    stop_grace_period: 30s

volumes:
  mum-data:
```

Run `docker compose up -d`, then open `http://<your host>:5699` and follow the setup wizard. To build the image from source instead, use [deploy/docker/docker-compose.yml](deploy/docker/docker-compose.yml).

### Coming from the Flask/PostgreSQL version

The current MUM is a fresh Go/SQLite application. It does not read the old PostgreSQL database or `/app/instance` folder, and it listens on port 5699 inside the container (the old image used 5000). Replace your old compose file with the one above, start with a new data volume, and set MUM up again through the wizard. Keep the old data folder if you may want to look something up later.

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

## Development

MUM is a Go application (`server/`) with an embedded React frontend (`frontend/`). Development needs Go and Node.js; end users need neither.

```sh
cd frontend && npm ci && node node_modules/vite/bin/vite.js build   # builds into server/dist
cd .. && go build -o mum ./server                                  # one executable with the frontend embedded
go test ./...                                                       # Go tests
```

- `npm run dev` in `frontend/` starts the Vite dev server (port `FRONTEND_PORT`, default 5173) and proxies `/api` and `/ws` to a running MUM on `MUM_PORT` (default 5699).
- `go run ./tools/release -version vX.Y.Z` builds the Windows, Linux and macOS release files with checksums and licences (nothing is published).
- Project layout: `server/` Go application and SQL migrations, `frontend/` React SPA, `deploy/` Docker files and the end-user guide, `tools/release/` release builder, `tests/` frontend adapter tests, `migration-documentation/` migration records.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue. By contributing, you agree that your contributions are licensed under the same licence as the project (AGPL-3.0).

## License

Copyright (C) 2025-2026 Christopher (MrRobotjs) and MUM contributors.

MUM is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. See [LICENSE](LICENSE) for the full text.

In short: anyone may use, study, change and share MUM, including commercially. If you distribute a modified version, or let people use a modified version over a network, you must make its complete source code available to them under the same licence.

MUM is distributed WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. Third-party components keep their own licences; release builds include them in `licenses/` and `THIRD_PARTY_LICENSES.md`.
