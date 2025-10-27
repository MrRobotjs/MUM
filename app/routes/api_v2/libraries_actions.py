from __future__ import annotations

from flask import jsonify
from flask_login import login_required
from pydantic import BaseModel
from pydantic import ConfigDict
from flask_openapi3 import Tag

from app.routes.api_v2 import api_v2


libraries_tag = Tag(name="Libraries", description="Media libraries and items")


class LibraryPath(BaseModel):
    library_id: int


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


class SyncResult(BaseModel):
    # Accept unknown keys from MediaSyncService without failing schema
    model_config = ConfigDict(extra='allow')
    added: int | None = 0
    updated: int | None = 0
    removed: int | None = 0
    errors: list[str] | None = None
    total_items: int | None = None
    duration: float | None = None


class LibrarySyncResponse(BaseModel):
    success: bool
    message: str | None = None
    result: SyncResult | None = None


@api_v2.post(
    "/libraries/<library_id>/sync",
    tags=[libraries_tag],
    summary="Sync library content",
    responses={200: LibrarySyncResponse, 404: ErrorResponse, 500: ErrorResponse},
)
@login_required
def v2_sync_library_content(path: LibraryPath):
    from flask import current_app
    from app.services.media_sync_service import MediaSyncService
    from app.models_media_services import MediaLibrary
    import time

    try:
        library = MediaLibrary.query.get(path.library_id)
        if not library:
            return jsonify({
                "error": {"code": "LIBRARY_NOT_FOUND", "message": "Library not found"}
            }), 404

        current_app.logger.info(f"API v2: Starting library content sync for: {library.name}")
        start_time = time.time()
        result = MediaSyncService.sync_library_content(path.library_id)
        duration = time.time() - start_time

        if result.get("success"):
            result["duration"] = duration

            added = result.get("added", 0)
            updated = result.get("updated", 0)
            removed = result.get("removed", 0)
            errors_list = result.get("errors", []) or []

            has_changes = bool(added > 0 or updated > 0 or removed > 0 or (errors_list and len(errors_list) > 0))
            if has_changes:
                if errors_list:
                    message = f"Library sync completed with {len(errors_list)} errors. See details."
                else:
                    message = f"Library sync complete. {added} added, {updated} updated, {removed} removed."
                return jsonify({"success": True, "message": message, "result": result})
            else:
                total_items = result.get("total_items", 0)
                return jsonify({
                    "success": True,
                    "message": f"Library sync complete. No changes were made to {total_items} items.",
                    "result": result,
                })
        else:
            return jsonify({
                "error": {
                    "code": "SYNC_FAILED",
                    "message": result.get("error", "Unknown error"),
                }
            }), 500

    except Exception as e:
        current_app.logger.error(f"API v2: Error in library sync endpoint: {e}")
        return jsonify({
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Failed to sync library",
                "details": {"error": str(e)},
            }
        }), 500


class LibraryPurgeResponse(BaseModel):
    success: bool
    deleted_count: int | None = None
    library_name: str | None = None
    message: str | None = None


@api_v2.post(
    "/libraries/<library_id>/purge",
    tags=[libraries_tag],
    summary="Purge cached media items for a library",
    responses={200: LibraryPurgeResponse, 404: ErrorResponse, 500: ErrorResponse},
)
@login_required
def v2_purge_library_content(path: LibraryPath):
    from flask import current_app
    from app.extensions import db
    from app.models_media_services import MediaLibrary, MediaItem

    try:
        library = MediaLibrary.query.get(path.library_id)
        if not library:
            return jsonify({
                "error": {"code": "LIBRARY_NOT_FOUND", "message": "Library not found"}
            }), 404

        current_app.logger.info(f"API v2: Starting library purge for: {library.name}")

        # Delete all media items for this library
        deleted_count = MediaItem.query.filter_by(library_id=path.library_id).delete()
        db.session.commit()

        current_app.logger.info(
            f"API v2: Library purge completed: deleted {deleted_count} items from {library.name}"
        )
        return jsonify({
            "success": True,
            "deleted_count": deleted_count,
            "library_name": library.name,
            "message": f"Successfully purged {deleted_count} items from library {library.name}",
        })
    except Exception as e:
        current_app.logger.error(f"API v2: Error in library purge endpoint: {e}")
        from app.extensions import db as _db
        _db.session.rollback()
        return jsonify({
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Failed to purge library items",
                "details": {"error": str(e)},
            }
        }), 500
