# File: app/routes/openapi.py
"""
OpenAPI specification endpoint for API documentation.
Serves OpenAPI JSON that can be consumed by Scalar or other API documentation tools.
"""
from flask import Blueprint, jsonify, current_app
from flask_login import login_required

openapi_bp = Blueprint('openapi', __name__)


def generate_openapi_spec():
    """
    Generate OpenAPI 3.1 specification for the MUM API.
    Compatible with Scalar API documentation UI.
    """
    spec = {
        "openapi": "3.1.0",
        "info": {
            "title": "Media User Manager API",
            "version": "1.0.0",
            "description": "API for managing media server users, invites, and integrations",
            "contact": {
                "name": "MUM Support",
            }
        },
        "servers": [
            {
                "url": "/admin/api/v1",
                "description": "Admin API v1 (new, recommended)"
            },
            {
                "url": "/api/v1",
                "description": "Public API v1 (unauthenticated endpoints)"
            },
            {
                "url": "/admin/api",
                "description": "Admin API (legacy, still in use)"
            }
        ],
        "tags": [
            {"name": "Authentication", "description": "Authentication and session management"},
            {"name": "Users", "description": "User management endpoints"},
            {"name": "Invites", "description": "Invitation management"},
            {"name": "Invite Wizard", "description": "Public invite acceptance workflow"},
            {"name": "Servers", "description": "Media server management"},
            {"name": "Plugins", "description": "Plugin management"},
            {"name": "Roles", "description": "Role and permission management"},
            {"name": "Settings", "description": "Application settings"},
            {"name": "Dashboard", "description": "Dashboard and statistics"},
            {"name": "Streaming", "description": "Active streaming sessions"},
        ],
        "paths": {
            "/auth/csrf-token": {
                "get": {
                    "tags": ["Authentication"],
                    "summary": "Get CSRF token",
                    "description": "Retrieve CSRF token for form submissions",
                    "responses": {
                        "200": {
                            "description": "CSRF token retrieved",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "csrf_token": {"type": "string"}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "/users": {
                "get": {
                    "tags": ["Users"],
                    "summary": "List users",
                    "description": "Get paginated list of users with filtering and sorting options",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "page",
                            "in": "query",
                            "description": "Page number (minimum 1)",
                            "schema": {"type": "integer", "default": 1, "minimum": 1}
                        },
                        {
                            "name": "page_size",
                            "in": "query",
                            "description": "Items per page (1-100)",
                            "schema": {"type": "integer", "default": 25, "minimum": 1, "maximum": 100}
                        },
                        {
                            "name": "search",
                            "in": "query",
                            "description": "Search by username or email",
                            "schema": {"type": "string"}
                        },
                        {
                            "name": "user_type",
                            "in": "query",
                            "description": "Filter by user type",
                            "schema": {"type": "string", "enum": ["owner", "local", "service"]}
                        },
                        {
                            "name": "role",
                            "in": "query",
                            "description": "Filter by admin role name",
                            "schema": {"type": "string"}
                        },
                        {
                            "name": "sort",
                            "in": "query",
                            "description": "Sort order",
                            "schema": {"type": "string", "enum": ["username_asc", "username_desc", "created_asc", "created_desc"], "default": "created_desc"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "List of users",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "data": {
                                                "type": "array",
                                                "items": {
                                                    "type": "object",
                                                    "properties": {
                                                        "id": {"type": "integer"},
                                                        "uuid": {"type": "string"},
                                                        "username": {"type": "string"},
                                                        "email": {"type": "string"},
                                                        "user_type": {"type": "string", "enum": ["owner", "local", "service"]},
                                                        "display_name": {"type": "string"},
                                                        "avatar_url": {"type": "string"},
                                                        "created_at": {"type": "string", "format": "date-time"},
                                                        "last_login_at": {"type": "string", "format": "date-time"},
                                                        "is_active": {"type": "boolean"},
                                                        "admin_roles": {"type": "array", "items": {"type": "string"}},
                                                        "linked_service_count": {"type": "integer"}
                                                    }
                                                }
                                            },
                                            "meta": {
                                                "type": "object",
                                                "properties": {
                                                    "request_id": {"type": "string", "format": "uuid"},
                                                    "generated_at": {"type": "string", "format": "date-time"},
                                                    "pagination": {
                                                        "type": "object",
                                                        "properties": {
                                                            "page": {"type": "integer"},
                                                            "page_size": {"type": "integer"},
                                                            "total_items": {"type": "integer"},
                                                            "total_pages": {"type": "integer"}
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "/servers": {
                "get": {
                    "tags": ["Servers"],
                    "summary": "List servers",
                    "description": "Get list of configured media servers",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "include_status",
                            "in": "query",
                            "description": "Include real-time server status",
                            "schema": {"type": "boolean", "default": False}
                        },
                        {
                            "name": "active_only",
                            "in": "query",
                            "description": "Only return active servers",
                            "schema": {"type": "boolean", "default": False}
                        },
                        {
                            "name": "service_type",
                            "in": "query",
                            "description": "Filter by service type",
                            "schema": {"type": "string", "enum": ["plex", "jellyfin", "emby", "kavita", "audiobookshelf", "komga", "romm"]}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "List of servers",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "data": {
                                                "type": "array",
                                                "items": {
                                                    "type": "object",
                                                    "properties": {
                                                        "id": {"type": "integer"},
                                                        "server_nickname": {"type": "string"},
                                                        "server_name": {"type": "string"},
                                                        "service_type": {"type": "string"},
                                                        "url": {"type": "string"},
                                                        "is_active": {"type": "boolean"},
                                                        "last_status": {"type": "string"},
                                                        "last_sync_at": {"type": "string", "format": "date-time"}
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                "post": {
                    "tags": ["Servers"],
                    "summary": "Create server",
                    "description": "Add a new media server configuration",
                    "security": [{"cookieAuth": []}],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["server_nickname", "service_type", "url"],
                                    "properties": {
                                        "server_nickname": {"type": "string", "description": "Unique nickname for the server"},
                                        "server_name": {"type": "string", "description": "Display name"},
                                        "service_type": {
                                            "type": "string",
                                            "enum": ["plex", "jellyfin", "emby", "kavita", "audiobookshelf", "komga", "romm"]
                                        },
                                        "url": {"type": "string", "format": "uri", "description": "Server URL"},
                                        "api_key": {"type": "string"},
                                        "username": {"type": "string"},
                                        "password": {"type": "string"},
                                        "public_url": {"type": "string", "format": "uri"},
                                        "is_active": {"type": "boolean", "default": True},
                                        "websocket_refresh_interval": {"type": "integer", "minimum": 2, "maximum": 300, "description": "Plex only: WebSocket refresh interval in seconds"}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "201": {
                            "description": "Server created successfully"
                        },
                        "409": {
                            "description": "Server nickname already exists"
                        },
                        "422": {
                            "description": "Validation error"
                        }
                    }
                }
            },
            "/servers/{server_id}": {
                "get": {
                    "tags": ["Servers"],
                    "summary": "Get server details",
                    "description": "Get a single server by ID",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "server_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        },
                        {
                            "name": "include_status",
                            "in": "query",
                            "schema": {"type": "boolean", "default": False}
                        },
                        {
                            "name": "include_libraries",
                            "in": "query",
                            "schema": {"type": "boolean", "default": False}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Server details"
                        },
                        "404": {
                            "description": "Server not found"
                        }
                    }
                },
                "patch": {
                    "tags": ["Servers"],
                    "summary": "Update server",
                    "description": "Update server configuration",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "server_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "server_nickname": {"type": "string"},
                                        "server_name": {"type": "string"},
                                        "url": {"type": "string"},
                                        "api_key": {"type": "string"},
                                        "is_active": {"type": "boolean"}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Server updated"
                        },
                        "404": {
                            "description": "Server not found"
                        }
                    }
                },
                "delete": {
                    "tags": ["Servers"],
                    "summary": "Delete server",
                    "description": "Delete server and all associated users",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "server_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Server deleted"
                        },
                        "404": {
                            "description": "Server not found"
                        }
                    }
                }
            },
            "/servers/{server_id}/sync-libraries": {
                "post": {
                    "tags": ["Servers"],
                    "summary": "Sync server libraries",
                    "description": "Synchronize libraries from media server",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "server_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Libraries synced successfully"
                        },
                        "404": {
                            "description": "Server not found"
                        }
                    }
                }
            },
            "/servers/{server_id}/sync-users": {
                "post": {
                    "tags": ["Servers"],
                    "summary": "Sync server users",
                    "description": "Synchronize users from media server",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "server_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Users synced successfully"
                        },
                        "404": {
                            "description": "Server not found"
                        }
                    }
                }
            },
            "/servers/{server_id}/test": {
                "post": {
                    "tags": ["Servers"],
                    "summary": "Test server connection",
                    "description": "Test connectivity to media server",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "server_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Connection test result"
                        },
                        "404": {
                            "description": "Server not found"
                        }
                    }
                }
            },
            "/invites": {
                "get": {
                    "tags": ["Invites"],
                    "summary": "List invites",
                    "description": "Get paginated list of invites with filtering",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "page",
                            "in": "query",
                            "schema": {"type": "integer", "default": 1}
                        },
                        {
                            "name": "page_size",
                            "in": "query",
                            "schema": {"type": "integer", "default": 25, "minimum": 1, "maximum": 100}
                        },
                        {
                            "name": "status",
                            "in": "query",
                            "description": "Filter by status",
                            "schema": {"type": "string", "enum": ["active", "inactive", "expired", "maxed", "usable"]}
                        },
                        {
                            "name": "search",
                            "in": "query",
                            "description": "Search by token or custom path",
                            "schema": {"type": "string"}
                        },
                        {
                            "name": "server_id",
                            "in": "query",
                            "description": "Filter by server",
                            "schema": {"type": "integer"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "List of invites"
                        }
                    }
                },
                "post": {
                    "tags": ["Invites"],
                    "summary": "Create invite",
                    "description": "Create a new invitation",
                    "security": [{"cookieAuth": []}],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "custom_path": {"type": "string"},
                                        "expires_at": {"type": "string", "format": "date-time"},
                                        "max_uses": {"type": "integer"},
                                        "grant_library_ids": {"type": "array", "items": {"type": "string"}},
                                        "allow_downloads": {"type": "boolean"},
                                        "is_active": {"type": "boolean", "default": True}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "201": {
                            "description": "Invite created"
                        }
                    }
                }
            },
            "/invites/{invite_id}": {
                "get": {
                    "tags": ["Invites"],
                    "summary": "Get invite details",
                    "description": "Get detailed invite information including usage",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "invite_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Invite details"
                        },
                        "404": {
                            "description": "Invite not found"
                        }
                    }
                },
                "patch": {
                    "tags": ["Invites"],
                    "summary": "Update invite",
                    "description": "Update invite configuration",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "invite_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "custom_path": {"type": "string"},
                                        "expires_at": {"type": "string", "format": "date-time"},
                                        "max_uses": {"type": "integer"},
                                        "is_active": {"type": "boolean"}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Invite updated"
                        },
                        "404": {
                            "description": "Invite not found"
                        }
                    }
                },
                "delete": {
                    "tags": ["Invites"],
                    "summary": "Delete invite",
                    "description": "Delete an invitation",
                    "security": [{"cookieAuth": []}],
                    "parameters": [
                        {
                            "name": "invite_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Invite deleted"
                        },
                        "404": {
                            "description": "Invite not found"
                        }
                    }
                }
            },
            "/invites/summary": {
                "get": {
                    "tags": ["Invites"],
                    "summary": "Get invite summary",
                    "description": "Get invite statistics and recent activity",
                    "security": [{"cookieAuth": []}],
                    "responses": {
                        "200": {
                            "description": "Invite summary with counts and recent invites/usages"
                        }
                    }
                }
            },
            "/server-status": {
                "get": {
                    "tags": ["Dashboard"],
                    "summary": "Get server status",
                    "description": "Get status of all configured media servers",
                    "security": [{"cookieAuth": []}],
                    "responses": {
                        "200": {
                            "description": "Server status summary and details",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "data": {
                                                "type": "object",
                                                "properties": {
                                                    "summary": {
                                                        "type": "object",
                                                        "properties": {
                                                            "total_servers": {"type": "integer"},
                                                            "online": {"type": "integer"},
                                                            "offline": {"type": "integer"}
                                                        }
                                                    },
                                                    "servers": {"type": "array"},
                                                    "grouped_by_service": {"type": "array"}
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "/public/invite/{token}/wizard": {
                "get": {
                    "tags": ["Invite Wizard"],
                    "summary": "Get invite wizard state",
                    "description": "Retrieve the current state of an invite acceptance wizard session",
                    "servers": [{"url": "/api/v1"}],
                    "parameters": [
                        {
                            "name": "token",
                            "in": "path",
                            "required": True,
                            "description": "Invite token or custom path",
                            "schema": {"type": "string"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Invite wizard state including steps, authentication status, and server details"
                        },
                        "404": {
                            "description": "Invite not found"
                        }
                    }
                }
            },
            "/public/invite/{token}/account": {
                "post": {
                    "tags": ["Invite Wizard"],
                    "summary": "Save user account details",
                    "description": "Create or update local user account information during invite acceptance",
                    "servers": [{"url": "/api/v1"}],
                    "parameters": [
                        {
                            "name": "token",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string"}
                        }
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["username", "email", "password", "confirm_password"],
                                    "properties": {
                                        "username": {"type": "string"},
                                        "email": {"type": "string", "format": "email"},
                                        "password": {"type": "string"},
                                        "confirm_password": {"type": "string"},
                                        "use_same_username": {"type": "boolean"},
                                        "use_same_email": {"type": "boolean"},
                                        "use_same_password": {"type": "boolean"}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Account details saved"
                        },
                        "400": {
                            "description": "Validation error or user accounts disabled"
                        }
                    }
                }
            },
            "/public/invite/{token}/server/{server_id}/credentials": {
                "post": {
                    "tags": ["Invite Wizard"],
                    "summary": "Save server credentials",
                    "description": "Store credentials for accessing a specific media server",
                    "servers": [{"url": "/api/v1"}],
                    "parameters": [
                        {
                            "name": "token",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string"}
                        },
                        {
                            "name": "server_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"}
                        }
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "username": {"type": "string"},
                                        "password": {"type": "string"},
                                        "email": {"type": "string"},
                                        "completed": {"type": "boolean", "default": True}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Credentials saved"
                        },
                        "404": {
                            "description": "Invite or server not found"
                        }
                    }
                }
            },
            "/public/invite/{token}/plex/start": {
                "post": {
                    "tags": ["Invite Wizard"],
                    "summary": "Start Plex OAuth",
                    "description": "Initialize Plex authentication flow",
                    "servers": [{"url": "/api/v1"}],
                    "parameters": [
                        {
                            "name": "token",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string"}
                        }
                    ],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "return_path": {"type": "string"}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Plex OAuth redirect URL generated"
                        },
                        "502": {
                            "description": "Failed to connect to Plex"
                        }
                    }
                }
            },
            "/public/invite/{token}/discord/start": {
                "post": {
                    "tags": ["Invite Wizard"],
                    "summary": "Start Discord OAuth",
                    "description": "Initialize Discord authentication flow",
                    "servers": [{"url": "/api/v1"}],
                    "parameters": [
                        {
                            "name": "token",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string"}
                        }
                    ],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "return_path": {"type": "string"}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Discord OAuth redirect URL generated"
                        },
                        "400": {
                            "description": "Discord OAuth not configured or disabled"
                        }
                    }
                }
            },
            "/public/invite/{token}/complete": {
                "post": {
                    "tags": ["Invite Wizard"],
                    "summary": "Complete invite acceptance",
                    "description": "Finalize invite acceptance and grant access to all configured servers",
                    "servers": [{"url": "/api/v1"}],
                    "parameters": [
                        {
                            "name": "token",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string"}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Invite accepted successfully, access granted"
                        },
                        "400": {
                            "description": "Missing required steps or validation failed"
                        }
                    }
                }
            },
            "/auth/login": {
                "post": {
                    "tags": ["Authentication"],
                    "summary": "Local user login",
                    "description": "Authenticate a local user account (not admin)",
                    "servers": [{"url": "/api/v1"}],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["username", "password"],
                                    "properties": {
                                        "username": {"type": "string", "description": "Username or email"},
                                        "password": {"type": "string"},
                                        "remember": {"type": "boolean", "default": False}
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Login successful"
                        },
                        "401": {
                            "description": "Invalid credentials"
                        },
                        "403": {
                            "description": "Account disabled or user accounts not enabled"
                        }
                    }
                }
            },
            "/auth/logout": {
                "post": {
                    "tags": ["Authentication"],
                    "summary": "Logout",
                    "description": "End user session",
                    "servers": [{"url": "/api/v1"}],
                    "security": [{"cookieAuth": []}],
                    "responses": {
                        "200": {
                            "description": "Logged out successfully"
                        }
                    }
                }
            }
        },
        "components": {
            "securitySchemes": {
                "cookieAuth": {
                    "type": "apiKey",
                    "in": "cookie",
                    "name": "session"
                }
            }
        }
    }

    return spec


@openapi_bp.route('/openapi.json')
@login_required
def openapi_json():
    """Serve OpenAPI specification as JSON"""
    spec = generate_openapi_spec()
    return jsonify(spec)
