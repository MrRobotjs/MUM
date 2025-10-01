# Users Module

A modular user management system for handling local users, service users, and their relationships.

## 📁 Module Structure

```
user_modules/
├── __init__.py          # Package initialization
├── README.md            # This documentation file
├── helpers.py           # Shared utilities and helper functions
├── main.py             # Core user listing and view preferences
├── sync.py             # User synchronization with external services
├── delete.py           # User deletion operations
├── mass_edit.py        # Bulk operations on multiple users
├── linking.py          # Account linking/unlinking functionality
├── api.py              # RESTful API endpoints
└── debug.py            # Debug tools and quick edit functionality
```

## 🚀 Quick Start

### Basic Usage
```python
# Import the main blueprint
from app.routes.users import bp as users_bp

# Register with Flask app
app.register_blueprint(users_bp, url_prefix='/users')
```

### Working with Individual Modules
```python
# Import specific functionality
from app.routes.user_modules.helpers import get_libraries_from_database
from app.routes.user_modules.main import list_users
from app.routes.user_modules.api import get_available_service_users
```

## 📋 Module Descriptions

### `helpers.py` - Shared Utilities
Common functions and classes used across multiple modules.

**Key Functions:**
- `get_libraries_from_database(servers)` - Retrieve library data from database
- `_get_local_user_avatar_url(app_user)` - Get avatar URL for local users
- Uses unified User model (userType=LOCAL or SERVICE) for all operations

### `main.py` - Core Listing
Main user listing functionality with filtering, sorting, and pagination.

**Routes:**
- `GET /` - Main user listing page
- `POST /save_view_preference` - Save user's view preference

**Features:**
- User type filtering (local, service, all)
- Search functionality
- Sorting by various fields
- Pagination support
- View mode preferences (cards/table)

### `sync.py` - Synchronization
User synchronization with external media services.

**Routes:**
- `POST /sync` - Synchronize all users

**Features:**
- Multi-service synchronization
- Error handling and reporting
- HTMX integration for real-time updates

### `delete.py` - Deletion Operations
Comprehensive user deletion functionality with safety checks.

**Routes:**
- `GET /delete-local/<uuid>/accounts` - Preview linked accounts
- `DELETE /delete-local/<uuid>` - Delete local user with options
- `DELETE /delete/<uuid>` - Delete any user
- `DELETE /app/<username>/delete` - Delete app user

**Features:**
- Safe deletion with confirmation
- Linked account handling
- Service-specific deletion
- Comprehensive error handling

### `mass_edit.py` - Bulk Operations
Mass operations for efficient user management.

**Routes:**
- `GET /mass_edit_libraries_form` - Get mass edit form
- `POST /mass_edit` - Execute mass operations
- `POST /purge_inactive` - Purge inactive users
- `POST /purge_inactive/preview` - Preview purge operations

**Features:**
- Bulk library updates
- Access expiration management
- User purging with safety checks
- Preview functionality

### `linking.py` - Account Linking
Link and unlink service accounts to/from local users.

**Routes:**
- `GET /local/<id>/edit` - Edit local user
- `GET /local/<id>/linked-accounts` - View linked accounts
- `POST /local/<id>/link/<service_id>` - Link accounts
- `POST /service/<id>/unlink` - Unlink accounts

**Features:**
- Visual linking interface
- Conflict detection
- Service account management
- Status display

### `api.py` - API Endpoints
RESTful API endpoints for programmatic user management.

**Routes:**
- `GET /api/available-service-users` - Get available users
- `POST /api/link-service-user` - Link single user
- `POST /link-service-users-api` - Link multiple users

**Features:**
- JSON API responses
- Bulk operations support
- Error handling and validation

### `debug.py` - Debug Tools
Debugging and quick edit functionality for development.

**Routes:**
- `GET /debug_info/<uuid>` - Get debug information
- `GET /quick_edit_form/<uuid>` - Get quick edit form

**Features:**
- Raw user data inspection
- Service-specific debugging
- Quick edit forms

## 🔧 Development Guidelines

### Adding New Features

1. **Identify the Right Module**: Determine which module best fits your new functionality
2. **Follow Existing Patterns**: Use existing code as a template
3. **Update Route Registration**: Add new routes to the main `users.py` file
4. **Add Documentation**: Document new functions and routes

### Creating New Modules

1. **Create the Module File**: Add new `.py` file in the `user_modules/` directory
2. **Define Blueprint**: Create a Flask blueprint for the module
3. **Update `__init__.py`**: Add the new module to imports and `__all__`
4. **Register Routes**: Add route registrations to main `users.py`

### Example: Adding a New Module

```python
# user_modules/reports.py
from flask import Blueprint

bp = Blueprint('users_reports', __name__)

@bp.route('/reports/activity')
def user_activity_report():
    # Implementation here
    pass
```

```python
# Update user_modules/__init__.py
from . import reports
__all__ = [..., 'reports']
```

```python
# Update users.py
from app.routes.user_modules import reports
bp.add_url_rule('/reports/activity', 'user_activity_report', 
                 reports.user_activity_report, methods=['GET'])
```

## 🧪 Testing

### Unit Testing Individual Modules
```python
# Test helpers module
from app.routes.user_modules.helpers import get_libraries_from_database

def test_get_libraries_from_database():
    # Test implementation
    pass
```

### Integration Testing
```python
# Test complete user workflows
def test_user_creation_and_deletion():
    # Test implementation
    pass
```

## 🔍 Debugging

### Common Issues

1. **Import Errors**: Ensure all modules are properly imported in `__init__.py`
2. **Route Conflicts**: Check for duplicate route registrations
3. **Missing Dependencies**: Verify all required imports are present

### Debug Tools

Use the debug module for troubleshooting:
```python
# Get comprehensive user debug info
GET /users/debug_info/<user_uuid>
```

## 📊 Performance Considerations

### Database Queries
- Use database queries instead of API calls where possible
- Implement pagination for large result sets
- Cache frequently accessed data

### Memory Usage
- Avoid loading all users into memory at once
- Use generators for large datasets
- Clean up temporary objects

## 🔒 Security

### Permission Checks
All routes include appropriate permission decorators:
```python
@permission_required('view_users')
@permission_required('edit_user')
@permission_required('delete_user')
```

### Input Validation
- Validate all user inputs
- Sanitize data before database operations
- Use UUID-based identification for security

## 📈 Monitoring

### Logging
Each module includes comprehensive logging:
```python
current_app.logger.info(f"User operation: {operation}")
current_app.logger.error(f"Error in user module: {error}")
```

### Performance Metrics
- Track operation execution times
- Monitor database query performance
- Log slow operations for optimization

## 🤝 Contributing

1. **Follow the Module Pattern**: Keep related functionality together
2. **Maintain Backward Compatibility**: Don't break existing APIs
3. **Add Tests**: Include unit tests for new functionality
4. **Document Changes**: Update this README for significant changes

## 📚 Related Documentation

- [Main Refactoring Documentation](../../USERS_MODULE_REFACTORING_DOCUMENTATION.md)
- [API Documentation](../api.md)
- [Database Schema](../../models.py)

---

**Module Version**: 1.0  
**Last Updated**: December 2024  
**Maintainer**: Development Team