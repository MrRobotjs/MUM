"""
Media Sync Service
Handles syncing media items from external services to local database for faster access
"""

from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from flask import current_app
from sqlalchemy import and_, or_
from app.extensions import db
from app.models_media_services import MediaItem, MediaLibrary, MediaServer
from app.services.media_service_factory import MediaServiceFactory
from app.routes.api_v2.library_sync_status import update_library_sync_progress


class MediaSyncService:
    """Service for syncing media items from external services to local database"""
    
    @staticmethod
    def sync_library_content(library_id: int, force_full_sync: bool = False, sync_episodes: bool = False) -> Dict[str, Any]:
        """
        Sync content for a specific library
        
        Args:
            library_id: ID of the library to sync
            force_full_sync: If True, sync all items regardless of last sync time
            
        Returns:
            Dict with sync results
        """
        try:
            library = MediaLibrary.query.get(library_id)
            if not library:
                return {'success': False, 'error': 'Library not found'}
            
            current_app.logger.info(f"Starting media sync for library: {library.name}")
            
            # Create service instance
            service = MediaServiceFactory.create_service_from_db(library.server)
            if not service:
                return {'success': False, 'error': 'Could not create service instance'}
            
            # Check if service supports get_library_content
            if not hasattr(service, 'get_library_content'):
                return {'success': False, 'error': 'Service does not support library content retrieval'}
            
            # Get all items from the service with timeout protection
            all_items = []
            page = 1
            per_page = 50  # Smaller batches to prevent timeouts
            max_pages = 100  # Limit total pages to prevent infinite loops
            # Initialize phase for UI
            update_library_sync_progress(
                library.id,
                phase="shows",
                current_page=0,
                total_pages=0,
                total_items=0,
                total_fetched=0,
                message=f"Syncing shows in {library.name}"
            )
            
            while page <= max_pages:
                try:
                    current_app.logger.debug(f"Syncing library {library.name}, page {page}")
                    content_data = service.get_library_content(library.external_id, page=page, per_page=per_page)
                    
                    # Handle error responses
                    if content_data.get('error'):
                        current_app.logger.warning(f"API error on page {page}: {content_data['error']}")
                        break
                    
                    items = content_data.get('items', [])
                    total_items = content_data.get('total') or 0
                    total_pages = (
                        content_data.get('pages')
                        or ((total_items + per_page - 1) // per_page if total_items else None)
                        or 0
                    )

                    if not items:
                        break
                        
                    all_items.extend(items)
                    current_app.logger.debug(f"Retrieved {len(items)} items from page {page}, total so far: {len(all_items)}")

                    # Update per-page progress for UI
                    update_library_sync_progress(
                        library.id,
                        phase="shows",
                        current_page=page,
                        total_pages=int(total_pages) if total_pages else 0,
                        total_items=int(total_items) if total_items else 0,
                        total_fetched=len(all_items),
                        message=f"Syncing shows, page {page}{'/' + str(total_pages) if total_pages else ''}"
                    )
                    
                    # Check if we've got all items
                    if len(items) < per_page:
                        break
                        
                    page += 1
                    
                    # Add a small delay to prevent overwhelming the API
                    import time
                    time.sleep(0.1)
                    
                except Exception as e:
                    current_app.logger.error(f"Error fetching page {page} for library {library.name}: {e}")
                    # Continue with partial data rather than failing completely
                    break
            
            current_app.logger.info(f"Retrieved {len(all_items)} items from {library.name}")
            
            # Sync items to database
            sync_results = MediaSyncService._sync_items_to_db(library, all_items)
            
            # Optionally sync episodes after shows
            episodes_result = None
            is_tv_library = (library.library_type or '').lower()
            if sync_episodes and ('show' in is_tv_library or 'tv' in is_tv_library):
                try:
                    episodes_result = MediaSyncService._sync_episodes_for_shows(library, service)
                except Exception as e:
                    current_app.logger.error(f"Error syncing episodes for library {library.name}: {e}")
            
            # Update library last sync time
            library.last_scanned = datetime.utcnow()
            db.session.add(library)
            db.session.commit()
            
            current_app.logger.info(f"Completed sync for library {library.name}: {sync_results}")
            
            result_payload = {
                'success': True,
                'library_name': library.name,
                'total_items': len(all_items),
                **sync_results
            }
            if episodes_result is not None:
                result_payload['episodes'] = episodes_result
            return result_payload
            
        except Exception as e:
            current_app.logger.error(f"Error syncing library {library_id}: {e}")
            db.session.rollback()
            return {'success': False, 'error': str(e)}
    
    @staticmethod
    def _sync_items_to_db(library: MediaLibrary, items: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Sync items to database
        
        Args:
            library: MediaLibrary instance
            items: List of item dictionaries from service
            
        Returns:
            Dict with counts and details of added, updated, removed items
        """
        added_count = 0
        updated_count = 0
        added_items = []
        updated_items = []
        errors = []
        
        # Get existing items for this library
        existing_items = {item.external_id: item for item in 
                         MediaItem.query.filter_by(library_id=library.id).all()}
        
        current_external_ids = set()
        
        for item_data in items:
            try:
                external_id = str(item_data.get('id', ''))
                if not external_id:
                    continue
                    
                current_external_ids.add(external_id)
                
                # Check if item exists
                existing_item = existing_items.get(external_id)
                
                if existing_item:
                    # Update existing item
                    changes = MediaSyncService._update_media_item(existing_item, item_data)
                    if changes:
                        updated_count += 1
                        updated_items.append({
                            'title': item_data.get('title', 'Unknown Title'),
                            'type': item_data.get('type', 'unknown'),
                            'year': item_data.get('year'),
                            'changes': changes
                        })
                else:
                    # Create new item
                    new_item = MediaSyncService._create_media_item(library, item_data)
                    if new_item:
                        added_count += 1
                        added_items.append({
                            'title': item_data.get('title', 'Unknown Title'),
                            'type': item_data.get('type', 'unknown'),
                            'year': item_data.get('year')
                        })
                        
            except Exception as e:
                error_msg = f"Error processing item {item_data.get('title', 'unknown')}: {str(e)}"
                current_app.logger.warning(error_msg)
                errors.append(error_msg)
                continue
        
        # Remove items that no longer exist on the service
        # IMPORTANT: For TV libraries, library sync only handles shows (not episodes)
        # Episodes are managed separately via sync_show_episodes()
        # So we should NOT delete episodes during library sync - only remove shows/movies/etc
        items_to_remove = [item for external_id, item in existing_items.items()
                          if external_id not in current_external_ids and item.item_type != 'episode']

        removed_count = 0
        removed_items = []
        for item in items_to_remove:
            removed_items.append({
                'title': item.title,
                'type': item.item_type,
                'year': item.year
            })
            db.session.delete(item)
            removed_count += 1
        
        # Commit all changes
        try:
            db.session.commit()
            current_app.logger.info(f"Sync completed: {added_count} added, {updated_count} updated, {removed_count} removed")
        except Exception as e:
            current_app.logger.error(f"Error committing sync changes: {e}")
            db.session.rollback()
            raise
        
        return {
            'added': added_count,
            'updated': updated_count,
            'removed': removed_count,
            'added_items': added_items[:50],  # Limit to first 50 for display
            'updated_items': updated_items[:50],  # Limit to first 50 for display
            'removed_items': removed_items[:50],  # Limit to first 50 for display
            'errors': errors
        }
    
    @staticmethod
    def _create_media_item(library: MediaLibrary, item_data: Dict[str, Any]) -> Optional[MediaItem]:
        """Create a new MediaItem from service data"""
        try:
            # Extract thumbnail path (handle different service formats)
            thumb_path = None
            if item_data.get('thumb'):
                thumb_url = item_data['thumb']
                current_app.logger.info(f"SYNC DEBUG: Processing thumb_url for '{item_data.get('title')}': {thumb_url}")
                if thumb_url.startswith('/api/'):
                    # Already a proxy URL (Jellyfin or other services) - store as-is
                    thumb_path = thumb_url
                    current_app.logger.info(f"SYNC DEBUG: Stored as direct API URL: {thumb_path}")
                elif '/api/media/plex/images/proxy' in thumb_url and 'path=' in thumb_url:
                    # Plex proxy URL: extract path
                    thumb_path = thumb_url.split('path=')[1]
                    current_app.logger.info(f"SYNC DEBUG: Extracted Plex path: {thumb_path}")
                elif '/api/media/audiobookshelf/images/proxy' in thumb_url and 'path=' in thumb_url:
                    # AudioBookshelf proxy URL: store as-is (full proxy URL)
                    thumb_path = thumb_url
                    current_app.logger.info(f"SYNC DEBUG: Stored AudioBookshelf proxy URL: {thumb_path}")
                elif thumb_url.startswith('/'):
                    # Direct path
                    thumb_path = thumb_url
                    current_app.logger.info(f"SYNC DEBUG: Stored as direct path: {thumb_path}")
                elif thumb_url.startswith('http'):
                    # Full URL (like RomM) - store as-is
                    thumb_path = thumb_url
                    current_app.logger.info(f"SYNC DEBUG: Stored as full URL: {thumb_path}")
            else:
                current_app.logger.info(f"SYNC DEBUG: No thumb URL for '{item_data.get('title')}')")
            
            # Parse duration (handle different formats)
            duration = item_data.get('duration')
            if duration and isinstance(duration, str):
                try:
                    duration = int(duration)
                except ValueError:
                    duration = None
            
            # Parse added_at date
            added_at = None
            if item_data.get('added_at'):
                try:
                    if isinstance(item_data['added_at'], str):
                        added_at = datetime.fromisoformat(item_data['added_at'].replace('Z', '+00:00'))
                    else:
                        added_at = item_data['added_at']
                except (ValueError, TypeError):
                    pass
            
            # Extract rating_key for Plex items - every Plex item has a ratingKey
            rating_key = None
            raw_data = item_data.get('raw_data', {})
            if raw_data and isinstance(raw_data, dict):
                rating_key = raw_data.get('ratingKey')
            
            media_item = MediaItem(
                library_id=library.id,
                server_id=library.server_id,
                external_id=str(item_data.get('id', '')),
                parent_id=item_data.get('parent_id'),  # Add parent_id support for episodes
                rating_key=str(rating_key) if rating_key else None,
                title=item_data.get('title', 'Unknown Title'),
                sort_title=item_data.get('sort_title') or item_data.get('title', 'Unknown Title'),
                item_type=item_data.get('type', 'unknown'),
                summary=item_data.get('summary') or item_data.get('plot') or item_data.get('overview'),
                year=item_data.get('year'),
                rating=item_data.get('rating'),
                duration=duration,
                thumb_path=thumb_path,
                added_at=added_at,
                last_synced=datetime.utcnow(),
                extra_metadata=item_data.get('raw_data', {})
            )
            
            db.session.add(media_item)
            return media_item
            
        except Exception as e:
            current_app.logger.error(f"Error creating media item: {e}")
            return None
    
    @staticmethod
    def _update_media_item(item: MediaItem, item_data: Dict[str, Any]) -> List[str]:
        """Update an existing MediaItem with new data"""
        try:
            changes = []
            
            # Extract rating_key for Plex items - every Plex item has a ratingKey
            new_rating_key = None
            raw_data = item_data.get('raw_data', {})
            if raw_data and isinstance(raw_data, dict):
                new_rating_key = raw_data.get('ratingKey')
            
            new_rating_key = str(new_rating_key) if new_rating_key else None
            
            # Check if key fields have changed
            new_title = item_data.get('title', 'Unknown Title')
            new_summary = item_data.get('summary') or item_data.get('plot') or item_data.get('overview')
            new_year = item_data.get('year')
            new_rating = item_data.get('rating')
            
            if item.title != new_title:
                changes.append(f"Title: '{item.title}' → '{new_title}'")
                item.title = new_title
                item.sort_title = item_data.get('sort_title') or new_title
            
            if item.summary != new_summary:
                changes.append("Summary updated")
                item.summary = new_summary
            
            if item.year != new_year:
                changes.append(f"Year: {item.year} → {new_year}")
                item.year = new_year
            
            if item.rating != new_rating:
                old_rating = f"{item.rating:.1f}" if item.rating else "None"
                new_rating_str = f"{new_rating:.1f}" if new_rating else "None"
                changes.append(f"Rating: {old_rating} → {new_rating_str}")
                item.rating = new_rating
            
            if item.rating_key != new_rating_key:
                changes.append(f"Rating Key: {item.rating_key} → {new_rating_key}")
                item.rating_key = new_rating_key
            
            # Always update last_synced and extra_metadata
            item.last_synced = datetime.utcnow()
            item.extra_metadata = item_data.get('raw_data', {})
            
            if changes:
                db.session.add(item)
            
            return changes
            
        except Exception as e:
            current_app.logger.error(f"Error updating media item {item.external_id}: {e}")
            return []
    
    @staticmethod
    def _sync_episodes_for_shows(library: MediaLibrary, service) -> Dict[str, Any]:
        """
        Sync episodes for all TV shows in the library
        
        Args:
            library: MediaLibrary instance
            service: Media service instance
            
        Returns:
            Dict with episode sync results
        """
        added_count = 0
        updated_count = 0
        removed_count = 0
        errors = []
        
        try:
            # Get all TV shows in this library
            tv_shows = MediaItem.query.filter_by(
                library_id=library.id,
                item_type='show'
            ).all()
            shows_total = len(tv_shows)
            update_library_sync_progress(
                library.id,
                phase="episodes",
                shows_current=0,
                shows_total=shows_total,
                message=f"Syncing episodes for {shows_total} shows"
            )

            current_app.logger.info(f"Syncing episodes for {shows_total} TV shows in library {library.name}")
            processed = 0
            for show in tv_shows:
                try:
                    # Use rating_key if available, otherwise external_id
                    show_id = show.rating_key if show.rating_key else show.external_id
                    if not show_id:
                        current_app.logger.warning(f"No show ID available for show: {show.title}")
                        continue
                    
                    current_app.logger.debug(f"Syncing episodes for show: {show.title} (ID: {show_id})")
                    
                    # Get episodes from service
                    if hasattr(service, 'get_show_episodes'):
                        episodes_data = service.get_show_episodes(show_id, page=1, per_page=1000)
                        if episodes_data and episodes_data.get('items'):
                            episodes = episodes_data['items']
                            
                            # Get existing episodes for this show - check both external_id and rating_key as parent_id
                            existing_episodes_query = MediaItem.query.filter(
                                MediaItem.library_id == library.id,
                                MediaItem.item_type == 'episode',
                                or_(
                                    MediaItem.parent_id == show.external_id,
                                    MediaItem.parent_id == show.rating_key
                                )
                            )
                            existing_episodes = {ep.external_id: ep for ep in existing_episodes_query.all()}
                            
                            current_episode_ids = set()
                            
                            for episode_data in episodes:
                                try:
                                    episode_external_id = str(episode_data.get('id', ''))
                                    if not episode_external_id:
                                        continue
                                    
                                    current_episode_ids.add(episode_external_id)
                                    
                                    # Check if episode exists
                                    existing_episode = existing_episodes.get(episode_external_id)
                                    
                                    if existing_episode:
                                        # Update existing episode
                                        changes = MediaSyncService._update_media_item(existing_episode, episode_data)
                                        if changes:
                                            updated_count += 1
                                    else:
                                        # Create new episode - use rating_key as parent_id if available, otherwise external_id
                                        episode_data['parent_id'] = show.rating_key if show.rating_key else show.external_id
                                        new_episode = MediaSyncService._create_media_item(library, episode_data)
                                        if new_episode:
                                            added_count += 1
                                            
                                except Exception as e:
                                    error_msg = f"Error processing episode {episode_data.get('title', 'unknown')} for show {show.title}: {str(e)}"
                                    current_app.logger.warning(error_msg)
                                    errors.append(error_msg)
                                    continue
                            
                            # Remove episodes that no longer exist
                            episodes_to_remove = [ep for ep_id, ep in existing_episodes.items() 
                                                if ep_id not in current_episode_ids]
                            
                            for episode in episodes_to_remove:
                                db.session.delete(episode)
                                removed_count += 1
                                
                        else:
                            current_app.logger.debug(f"No episodes found for show: {show.title}")
                    
                except Exception as e:
                    error_msg = f"Error syncing episodes for show {show.title}: {str(e)}"
                    current_app.logger.error(error_msg)
                    errors.append(error_msg)
                    continue

                # Update progress after each show
                processed += 1
                update_library_sync_progress(
                    library.id,
                    phase="episodes",
                    shows_current=processed,
                    shows_total=shows_total,
                    message=f"Syncing episodes ({processed}/{shows_total})"
                )

                # Commit after each show to reduce long-lived write locks
                try:
                    db.session.commit()
                except Exception as e:
                    current_app.logger.error(f"Error committing episode changes for show {show.title}: {e}")
                    db.session.rollback()
                    # Continue to next show even if this one failed to commit
                    continue

                # Brief yield to avoid starving other requests
                try:
                    import time
                    time.sleep(0.02)
                except Exception:
                    pass
            
            # Final commit in case any pending changes remain
            try:
                db.session.commit()
            except Exception as e:
                current_app.logger.error(f"Final commit error after episode sync loop: {e}")
                db.session.rollback()

            return {
                'added': added_count,
                'updated': updated_count,
                'removed': removed_count,
                'errors': errors
            }
            
        except Exception as e:
            current_app.logger.error(f"Error syncing episodes for library {library.name}: {e}")
            db.session.rollback()
            return {
                'added': 0,
                'updated': 0,
                'removed': 0,
                'errors': [str(e)]
            }
    
    @staticmethod
    def sync_show_episodes(show_id: int) -> Dict[str, Any]:
        """
        Sync episodes for a single TV show on-demand
        
        Args:
            show_id: Database ID of the show (MediaItem.id)
            
        Returns:
            Dict with sync results
        """
        try:
            # Get the show from database
            show = MediaItem.query.get(show_id)
            if not show or show.item_type != 'show':
                return {'success': False, 'error': 'Show not found or not a TV show'}
            
            library = show.library
            if not library:
                return {'success': False, 'error': 'Library not found for show'}
            
            current_app.logger.info(f"Starting episode sync for show: {show.title}")
            
            # Create service instance
            from app.services.media_service_factory import MediaServiceFactory
            service = MediaServiceFactory.create_service_from_db(library.server)
            if not service:
                return {'success': False, 'error': 'Could not create service instance'}
            
            # Use rating_key if available, otherwise external_id
            show_external_id = show.rating_key if show.rating_key else show.external_id
            if not show_external_id:
                return {'success': False, 'error': 'No show ID available'}
            
            added_count = 0
            updated_count = 0
            removed_count = 0
            errors = []
            
            # Get episodes from service
            if hasattr(service, 'get_show_episodes'):
                episodes_data = service.get_show_episodes(show_external_id, page=1, per_page=1000)
                if episodes_data and episodes_data.get('items'):
                    episodes = episodes_data['items']
                    
                    # Get existing episodes for this show - check both external_id and rating_key as parent_id
                    existing_episodes_query = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.item_type == 'episode',
                        or_(
                            MediaItem.parent_id == show.external_id,
                            MediaItem.parent_id == show.rating_key
                        )
                    )
                    existing_episodes = {ep.external_id: ep for ep in existing_episodes_query.all()}
                    
                    # Also check for episodes that might exist without proper parent_id (orphaned episodes)
                    orphaned_episodes_query = MediaItem.query.filter(
                        MediaItem.library_id == library.id,
                        MediaItem.item_type == 'episode',
                        MediaItem.parent_id.is_(None)
                    )
                    orphaned_episodes = orphaned_episodes_query.all()
                    
                    current_app.logger.debug(f"Found {len(existing_episodes)} existing episodes with proper parent_id for show {show.title}")
                    current_app.logger.debug(f"Found {len(orphaned_episodes)} orphaned episodes (no parent_id) in library")
                    
                    # Log some existing episodes for debugging
                    if existing_episodes:
                        sample_episodes = list(existing_episodes.values())[:3]
                        for ep in sample_episodes:
                            current_app.logger.debug(f"Existing episode: {ep.title} (external_id: {ep.external_id}, parent_id: {ep.parent_id})")
                    
                    # Add orphaned episodes to existing episodes dict to prevent duplicates
                    for ep in orphaned_episodes:
                        if ep.external_id not in existing_episodes:
                            existing_episodes[ep.external_id] = ep
                            current_app.logger.debug(f"Added orphaned episode to existing: {ep.title} (external_id: {ep.external_id})")
                    
                    current_app.logger.debug(f"Total episodes in existing_episodes dict after orphan check: {len(existing_episodes)}")
                    
                    current_episode_ids = set()
                    
                    for episode_data in episodes:
                        try:
                            episode_external_id = str(episode_data.get('id', ''))
                            if not episode_external_id:
                                continue
                            
                            current_episode_ids.add(episode_external_id)
                            
                            # Check if episode exists
                            existing_episode = existing_episodes.get(episode_external_id)
                            
                            if existing_episode:
                                # Update existing episode
                                changes = MediaSyncService._update_media_item(existing_episode, episode_data)
                                if changes:
                                    updated_count += 1
                            else:
                                # Create new episode - use rating_key as parent_id if available, otherwise external_id
                                parent_id_to_use = show.rating_key if show.rating_key else show.external_id
                                episode_data['parent_id'] = parent_id_to_use
                                current_app.logger.debug(f"Creating new episode: {episode_data.get('title')} with parent_id: {parent_id_to_use} for show: {show.title}")
                                new_episode = MediaSyncService._create_media_item(library, episode_data)
                                if new_episode:
                                    added_count += 1
                                    current_app.logger.debug(f"Successfully created episode: {new_episode.title} (external_id: {new_episode.external_id}, parent_id: {new_episode.parent_id})")
                                else:
                                    current_app.logger.error(f"Failed to create episode: {episode_data.get('title')}")
                                    
                        except Exception as e:
                            error_msg = f"Error processing episode {episode_data.get('title', 'unknown')}: {str(e)}"
                            current_app.logger.warning(error_msg)
                            errors.append(error_msg)
                            continue
                    
                    # Remove episodes that no longer exist
                    episodes_to_remove = [ep for ep_id, ep in existing_episodes.items() 
                                        if ep_id not in current_episode_ids]
                    
                    for episode in episodes_to_remove:
                        db.session.delete(episode)
                        removed_count += 1
                        
                else:
                    current_app.logger.debug(f"No episodes found for show: {show.title}")
            else:
                return {'success': False, 'error': 'Service does not support episode retrieval'}
            
            # Update show's last synced time for episodes
            show.last_synced = datetime.utcnow()
            db.session.add(show)
            
            # Commit changes
            try:
                db.session.commit()
                current_app.logger.info(f"Episode sync completed for {show.title}: {added_count} added, {updated_count} updated, {removed_count} removed")
            except Exception as e:
                current_app.logger.error(f"Error committing episode sync changes: {e}")
                db.session.rollback()
                raise
            
            return {
                'success': True,
                'show_title': show.title,
                'added': added_count,
                'updated': updated_count,
                'removed': removed_count,
                'total_episodes': added_count + len(existing_episodes) - removed_count,
                'errors': errors
            }
            
        except Exception as e:
            current_app.logger.error(f"Error syncing episodes for show {show_id}: {e}")
            db.session.rollback()
            return {'success': False, 'error': str(e)}
    
    @staticmethod
    def get_cached_library_content(library_id: int, page: int = 1, per_page: int = 24, 
                                 search_query: str = '', sort_by: str = 'title_asc') -> Dict[str, Any]:
        """
        Get library content from cached database
        
        Args:
            library_id: ID of the library
            page: Page number
            per_page: Items per page
            search_query: Search query string
            sort_by: Sort criteria ('title_asc', 'title_desc', 'year_asc', 'year_desc', 'added_at_asc', 'added_at_desc', 'rating_asc', 'rating_desc', 'total_streams_asc', 'total_streams_desc')
            
        Returns:
            Dict with paginated results
        """
        try:
            # Build query - exclude episodes from library media view (episodes should only show in show pages)
            query = MediaItem.query.filter(
                MediaItem.library_id == library_id,
                MediaItem.item_type != 'episode'
            )
            
            # Apply search filter if provided
            if search_query:
                search_term = f"%{search_query.lower()}%"
                query = query.filter(
                    or_(
                        MediaItem.title.ilike(search_term),
                        MediaItem.summary.ilike(search_term)
                    )
                )
            
            # Apply sorting
            if sort_by.startswith('total_streams'):
                # Join with MediaStreamHistory to get stream counts
                from app.models_media_services import MediaStreamHistory
                query = query.outerjoin(
                    MediaStreamHistory,
                    and_(
                        MediaStreamHistory.server_id == MediaItem.server_id,
                        MediaStreamHistory.media_title == MediaItem.title
                    )
                ).group_by(MediaItem.id)
                
                if sort_by == 'total_streams_desc':
                    query = query.order_by(
                        db.func.count(MediaStreamHistory.id).desc(),
                        MediaItem.sort_title.asc()  # Secondary sort by title
                    )
                else:  # total_streams_asc
                    query = query.order_by(
                        db.func.count(MediaStreamHistory.id).asc(),
                        MediaItem.sort_title.asc()  # Secondary sort by title
                    )
            elif sort_by.startswith('year'):
                if sort_by == 'year_desc':
                    query = query.order_by(MediaItem.year.desc().nullslast(), MediaItem.sort_title.asc())
                else:  # year_asc
                    query = query.order_by(MediaItem.year.asc().nullsfirst(), MediaItem.sort_title.asc())
            elif sort_by.startswith('added_at'):
                if sort_by == 'added_at_desc':
                    query = query.order_by(MediaItem.added_at.desc().nullslast(), MediaItem.sort_title.asc())
                else:  # added_at_asc
                    query = query.order_by(MediaItem.added_at.asc().nullsfirst(), MediaItem.sort_title.asc())
            elif sort_by.startswith('rating'):
                if sort_by == 'rating_desc':
                    query = query.order_by(MediaItem.rating.desc().nullslast(), MediaItem.sort_title.asc())
                else:  # rating_asc
                    query = query.order_by(MediaItem.rating.asc().nullsfirst(), MediaItem.sort_title.asc())
            elif sort_by == 'title_desc':
                query = query.order_by(MediaItem.sort_title.desc())
            else:  # Default to title_asc
                query = query.order_by(MediaItem.sort_title.asc())
            
            # Get total count
            total = query.count()
            
            # Get ALL items first (for proper sorting by stream counts)
            all_items = query.all()
            
            # Convert to dict format and add stream counts
            items_data = []
            for item in all_items:
                item_dict = item.to_dict()
                
                # Get stream count for this item
                from app.models_media_services import MediaStreamHistory
                
                # For TV shows, count all episodes (grandparent_title = show title)
                # For movies and other content, count direct matches (media_title = content title)
                if item.item_type and item.item_type.lower() in ['show', 'series']:
                    # For TV shows, count all episodes of the show
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == item.server_id,
                        MediaStreamHistory.grandparent_title == item.title
                    ).count()
                else:
                    # For movies and other content, count direct matches
                    stream_count = MediaStreamHistory.query.filter(
                        MediaStreamHistory.server_id == item.server_id,
                        MediaStreamHistory.media_title == item.title
                    ).count()
                
                item_dict['stream_count'] = stream_count
                items_data.append(item_dict)
            
            # Apply manual sorting after adding stream counts (ensures consistent sorting)
            if sort_by.startswith('total_streams'):
                reverse = sort_by.endswith('_desc')
                items_data.sort(key=lambda x: x.get('stream_count', 0), reverse=reverse)
                current_app.logger.debug(f"Sorted library by streams, first item: '{items_data[0].get('title')}' with {items_data[0].get('stream_count', 0)} streams")
            elif sort_by.startswith('title'):
                reverse = sort_by.endswith('_desc')
                items_data.sort(key=lambda x: x.get('title', '').lower(), reverse=reverse)
            elif sort_by.startswith('year'):
                reverse = sort_by.endswith('_desc')
                items_data.sort(key=lambda x: x.get('year') or (0 if not reverse else 9999), reverse=reverse)
            elif sort_by.startswith('added_at'):
                reverse = sort_by.endswith('_desc')
                items_data.sort(key=lambda x: x.get('added_at') or ('1900-01-01' if not reverse else '9999-12-31'), reverse=reverse)
            elif sort_by.startswith('rating'):
                reverse = sort_by.endswith('_desc')
                items_data.sort(key=lambda x: x.get('rating') or (0 if not reverse else 10), reverse=reverse)
            
            # Apply manual pagination after sorting
            start_idx = (page - 1) * per_page
            end_idx = start_idx + per_page
            paginated_items = items_data[start_idx:end_idx]
            
            # Calculate pagination info
            total_pages = (total + per_page - 1) // per_page
            
            return {
                'items': paginated_items,
                'total': total,
                'page': page,
                'per_page': per_page,
                'pages': total_pages,
                'has_prev': page > 1,
                'has_next': page < total_pages
            }
            
        except Exception as e:
            current_app.logger.error(f"Error getting cached library content: {e}")
            return {
                'items': [],
                'total': 0,
                'page': page,
                'per_page': per_page,
                'pages': 0,
                'has_prev': False,
                'has_next': False,
                'error': str(e)
            }
    
    @staticmethod
    def is_library_synced(library_id: int, max_age_hours: int = 24) -> bool:
        """
        Check if library has been synced recently
        
        Args:
            library_id: ID of the library
            max_age_hours: Maximum age of sync in hours
            
        Returns:
            True if library has been synced within max_age_hours
        """
        try:
            cutoff_time = datetime.utcnow() - timedelta(hours=max_age_hours)
            
            # Check if we have any items synced recently
            recent_item = MediaItem.query.filter(
                and_(
                    MediaItem.library_id == library_id,
                    MediaItem.last_synced >= cutoff_time
                )
            ).first()
            
            return recent_item is not None
            
        except Exception as e:
            current_app.logger.error(f"Error checking library sync status: {e}")
            return False
