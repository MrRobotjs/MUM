# Multimedia User Management (MUM)

[![Docker Image CI](https://github.com/MrRobotjs/MUM/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/MrRobotjs/MUM/actions/workflows/docker-publish.yml)
[![GitHub stars](https://img.shields.io/github/stars/MrRobotjs/MUM.svg?style=social&label=Star&maxAge=2592000)](https://github.com/MrRobotjs/MUM/stargazers/)
[![](https://dcbadge.limes.pink/api/server/https://discord.gg/QGHQWpGNgX)](https://discord.gg/QGHQWpGNgX)
[![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?business=D7BJAJ9ZY4GRC&no_recurring=0&currency_code=USD)

MUM (Multimedia User Management) is a comprehensive, self-hosted web application that centralizes user management across multiple media servers and services. Built with a modern plugin architecture, MUM provides administrators with a unified dashboard to manage users, create sophisticated invite systems, monitor streaming activity, and maintain library access across diverse media platforms - all from one intuitive interface.

| Dashboard | Invites |
| :---: | :---: |
| ![image](https://github.com/user-attachments/assets/18db06e2-66c2-4e15-a010-59dc5499761d) | ![image](https://github.com/user-attachments/assets/dcb72d92-94f1-4246-aa81-e6163e3ff763) |
| Users | Streaming |
| ![image](https://github.com/user-attachments/assets/77c35536-62fd-44e3-9356-5cd6156fcf26) | ![image](https://github.com/user-attachments/assets/755f6dec-c839-4145-9d08-67c2de91303d) |

## Key Features

*   **Multi-Service Plugin Architecture:**
    *   Modular plugin system supporting diverse media platforms
    *   Hot-swappable plugins with individual configuration and management
    *   Extensible framework for custom service integrations
*   **Comprehensive Service Support:**
    *   **Plex:** Advanced user management, library sharing, Plex Home integration, and real-time session monitoring
    *   **Jellyfin & Emby:** Complete user lifecycle management with library access control
    *   **Kavita & Komga:** Specialized manga and comic book server administration
    *   **AudioBookshelf:** Audiobook library management with user role detection (Owner badges)
    *   **RomM:** Retro gaming ROM collection user management
*   **Intelligent User Management:**
    *   Unified dashboard displaying users across all connected services
    *   Real-time user synchronization with raw data debugging capabilities
    *   Granular library access control with service-specific permissions
    *   Bulk operations for efficient mass user management
    *   Service-specific role detection and badge display
*   **Sophisticated Invite System:**
    *   Multi-server invite creation with cross-platform library selection
    *   Flexible expiration policies and usage limitations
    *   Service-specific permission templates and access controls
    *   Temporary membership with automated lifecycle management
    *   Custom invite paths and branding options
*   **Advanced Discord Integration:**
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
*   **Enterprise-Grade Interface:**
    *   Modern responsive design with service-themed styling
    *   Advanced HTMX-powered interactions for seamless UX
    *   Comprehensive admin controls with role-based permissions
    *   Multi-step guided setup with intelligent service detection

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
        ports:
          - "5699:5000" # <host_port>:<container_port>
        volumes:
          - ./multimediausermanager:/app/instance
        environment:
          - TZ=America/New_York # REQUIRED: Set your local timezone
          - PUID=1000 # Optional: User ID for file permissions
          - PGID=1000 # Optional: Group ID for file permissions
    ```

2.  **Prepare Host Directory:**
    Create the directory on your host machine that you specified in the `volumes` section.
    ```bash
    mkdir ./multimediausermanager
    ```
    This directory will store the database and other persistent data.

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
*   **Discord Integration:**
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

## Plugin Development

MUM's modular nature makes it easy to extend. If you're interested in adding support for a new media service, you can create your own plugin. For more information, see the [Plugin Development Guide](PLUGIN_DEVELOPMENT_GUIDE.md).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue.
