"""DEPRECATED: Legacy API endpoints for library operations. Use v2 endpoints under /api/v2."""

from flask import current_app, make_response, json, request
from flask_login import login_required, current_user
from app.utils.helpers import setup_required, permission_required
from app.services.media_service_factory import MediaServiceFactory
from app.models_media_services import MediaLibrary, MediaServer, MediaItem
from app.extensions import db
from datetime import datetime
from . import libraries_bp


@libraries_bp.route('/api/sync-episodes/<int:show_id>', methods=['POST'])
@login_required
@setup_required
@permission_required('view_libraries')
def sync_show_episodes_api(show_id):
    """API endpoint to sync episodes for a specific show"""
    try:
        from app.services.media_sync_service import MediaSyncService
        from .helpers import get_show_episodes_by_item
        from flask import render_template
        
        current_app.logger.info(f"Starting episode sync for show ID: {show_id}")
        
        # Get the show from database
        show = MediaItem.query.get(show_id)
        if not show or show.item_type != 'show':
            current_app.logger.error(f"Show not found or not a TV show: ID {show_id}")
            return f'<div class="alert alert-error"><span>Show not found or not a TV show</span></div>', 404
        
        current_app.logger.info(f"Found show: {show.title} (external_id: {show.external_id}, rating_key: {show.rating_key})")
        
        library = show.library
        server = library.server
        
        # Trigger episode sync
        current_app.logger.info(f"Triggering sync for show: {show.title}")
        result = MediaSyncService.sync_show_episodes(show_id)
        
        current_app.logger.info(f"Sync result: {result}")
        
        if result['success']:
            # Get the synced episodes with default sorting
            page = request.args.get('page', 1, type=int)
            per_page = request.args.get('per_page', 24, type=int)
            search_query = request.args.get('search', '').strip()
            sort_by = request.args.get('sort_by', 'season_episode_asc').strip()
            
            current_app.logger.info(f"Getting episodes after sync: page={page}, per_page={per_page}, sort_by={sort_by}")
            episodes_content = get_show_episodes_by_item(server, library, show, page, per_page, search_query, sort_by)
            
            current_app.logger.info(f"Episodes content after sync: {episodes_content.get('total', 0) if episodes_content else 'None'} total episodes")
            
            # Return the episodes content HTML (for HTMX replacement)
            return render_template('library/_partials/episodes_content.html',
                                 episodes_content=episodes_content,
                                 episodes_cached=True,  # After sync, episodes are cached
                                 media_details=show.to_dict(),
                                 media_item=show,
                                 library=library,
                                 server=server,
                                 current_sort_by=sort_by)
        else:
            current_app.logger.error(f"Sync failed for show {show.title}: {result.get('error', 'Unknown error')}")
            return f'<div class="alert alert-error"><span>Sync failed: {result["error"]}</span></div>', 400
            
    except Exception as e:
        current_app.logger.error(f"Error in episode sync API for show {show_id}: {e}", exc_info=True)
        return f'<div class="alert alert-error"><span>Sync failed: {str(e)}</span></div>', 500


@libraries_bp.route('/api/purge-episodes/<int:show_id>', methods=['DELETE'])
@login_required
@setup_required
@permission_required('view_libraries')
def purge_show_episodes_api(show_id):
    """API endpoint to purge cached episodes for a specific show"""
    try:
        # Get the show from database
        show = MediaItem.query.get(show_id)
        if not show or show.item_type != 'show':
            return {'success': False, 'error': 'Show not found or not a TV show'}, 404
        
        current_app.logger.info(f"Purging cached episodes for show: {show.title}")
        
        # Find all episodes for this show (check both parent_id patterns for safety)
        episodes_to_delete = MediaItem.query.filter(
            MediaItem.library_id == show.library_id,
            MediaItem.item_type == 'episode',
            db.or_(
                MediaItem.parent_id == show.external_id,  # Correct parent_id
                MediaItem.parent_id.is_(None)  # Episodes with no parent_id (from incomplete syncs)
            )
        ).all()
        
        # Also find episodes by checking if their external_id matches any episode from this show's ratingKey
        # This catches episodes that might have been synced with wrong parent_id
        if show.rating_key:
            # Get episodes from Plex to find their external_ids
            service = MediaServiceFactory.create_service_from_db(show.library.server)
            if service and hasattr(service, 'get_show_episodes'):
                episodes_data = service.get_show_episodes(show.rating_key, page=1, per_page=1000)
                if episodes_data and episodes_data.get('items'):
                    episode_external_ids = [str(ep.get('id', '')) for ep in episodes_data['items']]
                    
                    # Find any episodes in database with these external_ids
                    orphaned_episodes = MediaItem.query.filter(
                        MediaItem.library_id == show.library_id,
                        MediaItem.item_type == 'episode',
                        MediaItem.external_id.in_(episode_external_ids)
                    ).all()
                    
                    # Add to deletion list (avoid duplicates)
                    for ep in orphaned_episodes:
                        if ep not in episodes_to_delete:
                            episodes_to_delete.append(ep)
        
        deleted_count = len(episodes_to_delete)
        deleted_titles = [ep.title for ep in episodes_to_delete[:10]]  # First 10 for logging
        
        # Delete episodes
        for episode in episodes_to_delete:
            db.session.delete(episode)
        
        # Commit changes
        db.session.commit()
        
        current_app.logger.info(f"Purged {deleted_count} episodes for show {show.title}")
        if deleted_titles:
            current_app.logger.debug(f"Deleted episodes include: {', '.join(deleted_titles)}")
        
        return {
            'success': True,
            'message': f"Purged {deleted_count} cached episodes for {show.title}",
            'deleted_count': deleted_count,
            'show_title': show.title
        }
        
    except Exception as e:
        current_app.logger.error(f"Error in episode purge API: {e}")
        db.session.rollback()
        return {'success': False, 'error': str(e)}, 500


@libraries_bp.route('/api/media-output/<server_nickname>/<library_name>/<int:media_id>')
@login_required
@setup_required
@permission_required('view_libraries')
def get_media_api_output(server_nickname, library_name, media_id):
    """Get raw API output for a specific media item for debugging"""
    try:
        import urllib.parse
        from app.utils.helpers import decode_url_component, decode_url_component_variations
        
        # URL decode the parameters
        server_nickname = urllib.parse.unquote(server_nickname)
        library_name = urllib.parse.unquote(library_name)
        library_name_for_lookup = decode_url_component(library_name)
        
        # Find the server by nickname
        server = MediaServer.query.filter_by(server_nickname=server_nickname).first_or_404()
        
        # Find the library by name and server - try multiple variations
        library = None
        library_name_variations = decode_url_component_variations(library_name)
        
        for variation in library_name_variations:
            library = MediaLibrary.query.filter_by(
                server_id=server.id,
                name=variation
            ).first()
            if library:
                library_name_for_lookup = variation
                break
        
        if not library:
            return make_response(json.dumps({
                'success': False,
                'error': 'Library not found'
            }), 404, {'Content-Type': 'application/json'})
        
        # Get media item from database
        media_item = MediaItem.query.filter_by(
            id=media_id,
            library_id=library.id
        ).first_or_404()
        
        # Create service instance
        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return make_response(json.dumps({
                'success': False,
                'error': 'Could not create service instance'
            }), 500, {'Content-Type': 'application/json'})
        
        # Get raw API data for this media item
        api_output = None
        if hasattr(service, 'get_media_raw'):
            # Use rating_key if available, otherwise fall back to external_id
            media_id_for_api = media_item.rating_key if media_item.rating_key else media_item.external_id
            api_output = service.get_media_raw(media_id_for_api)
        elif hasattr(service, 'get_media_details'):
            # Fallback to processed data
            media_id_for_api = media_item.rating_key if media_item.rating_key else media_item.external_id
            api_output = service.get_media_details(media_id_for_api)
        
        if api_output:
            return make_response(json.dumps({
                'success': True,
                'media_item_db': {
                    'id': media_item.id,
                    'title': media_item.title,
                    'external_id': media_item.external_id,
                    'rating_key': media_item.rating_key,
                    'item_type': media_item.item_type
                },
                'api_output': api_output,
                'server_info': {
                    'name': server.server_nickname,
                    'service_type': server.service_type.value,
                    'url': server.url
                }
            }), 200, {'Content-Type': 'application/json'})
        else:
            return make_response(json.dumps({
                'success': False,
                'error': 'No API data available for this media item'
            }), 404, {'Content-Type': 'application/json'})
        
    except Exception as e:
        current_app.logger.error(f"Error getting API output for media {media_id}: {e}")
        return make_response(json.dumps({
            'success': False,
            'error': str(e)
        }), 500, {'Content-Type': 'application/json'})


@libraries_bp.route('/api/episode-output/<server_nickname>/<library_name>/<int:media_id>/<tv_show_slug>/<episode_slug>')
@login_required
@setup_required
@permission_required('view_libraries')
def get_episode_api_output(server_nickname, library_name, media_id, tv_show_slug, episode_slug):
    """Get raw API output for a specific episode for debugging"""
    try:
        import urllib.parse
        from app.utils.helpers import decode_url_component, decode_url_component_variations, generate_url_slug
        
        # URL decode the parameters
        server_nickname = urllib.parse.unquote(server_nickname)
        library_name = urllib.parse.unquote(library_name)
        tv_show_slug = urllib.parse.unquote(tv_show_slug)
        episode_slug = urllib.parse.unquote(episode_slug)
        
        library_name_for_lookup = decode_url_component(library_name)
        
        # Find the server by nickname
        server = MediaServer.query.filter_by(server_nickname=server_nickname).first_or_404()
        
        # Find the library by name and server - try multiple variations
        library = None
        library_name_variations = decode_url_component_variations(library_name)
        
        for variation in library_name_variations:
            library = MediaLibrary.query.filter_by(
                server_id=server.id,
                name=variation
            ).first()
            if library:
                library_name_for_lookup = variation
                break
        
        if not library:
            return make_response(json.dumps({
                'success': False,
                'error': 'Library not found'
            }), 404, {'Content-Type': 'application/json'})
        
        # Get TV show item from database
        tv_show_item = MediaItem.query.filter_by(
            id=media_id,
            library_id=library.id
        ).first_or_404()
        
        # Create service instance
        service = MediaServiceFactory.create_service_from_db(server)
        if not service:
            return make_response(json.dumps({
                'success': False,
                'error': 'Could not create service instance'
            }), 500, {'Content-Type': 'application/json'})
        
        # Get episodes for the show to find the specific episode
        episode_api_output = None
        if hasattr(service, 'get_show_episodes'):
            # Use rating_key if available, otherwise fall back to external_id
            show_id = tv_show_item.rating_key if tv_show_item.rating_key else tv_show_item.external_id
            episodes_data = service.get_show_episodes(show_id, page=1, per_page=1000)
            
            if episodes_data and episodes_data.get('items'):
                for episode in episodes_data['items']:
                    if generate_url_slug(episode.get('title', '')) == episode_slug:
                        episode_api_output = episode
                        break
        
        if episode_api_output:
            return make_response(json.dumps({
                'success': True,
                'tv_show_item_db': {
                    'id': tv_show_item.id,
                    'title': tv_show_item.title,
                    'external_id': tv_show_item.external_id,
                    'rating_key': tv_show_item.rating_key,
                    'item_type': tv_show_item.item_type
                },
                'episode_api_output': episode_api_output,
                'server_info': {
                    'name': server.server_nickname,
                    'service_type': server.service_type.value,
                    'url': server.url
                },
                'url_params': {
                    'tv_show_slug': tv_show_slug,
                    'episode_slug': episode_slug,
                    'decoded_episode_slug': decode_url_component(episode_slug)
                }
            }), 200, {'Content-Type': 'application/json'})
        else:
            return make_response(json.dumps({
                'success': False,
                'error': f'Episode not found with slug: {episode_slug}'
            }), 404, {'Content-Type': 'application/json'})
        
    except Exception as e:
        current_app.logger.error(f"Error getting episode API output: {e}")
        return make_response(json.dumps({
            'success': False,
            'error': str(e)
        }), 500, {'Content-Type': 'application/json'})
