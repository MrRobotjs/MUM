import { useServerRoutes } from '../../lib/serverRoutes';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBook, faFilm, faMusic, faTv, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ServerAccountPlay } from '../../lib/serverAccounts';

// What was played, as a small icon before its title.
export function mediaTypeIcon(type: string): IconDefinition | null {
  const t = type.toLowerCase();
  if (t.includes('movie')) return faFilm;
  if (t.includes('episode') || t.includes('show')) return faTv;
  if (t.includes('track') || t.includes('audio') || t.includes('music')) return faMusic;
  if (t.includes('book')) return faBook;
  return null;
}

// The last play's title shows its poster on hover, and opens
// its page in the library when the item has been catalogued.
export function LastPlayed({ serverId, play }: { serverId: number; play: ServerAccountPlay }) {
  const routes = useServerRoutes();
  const slug = routes.slugFor(serverId);
  const [failed, setFailed] = useState(false);
  const icon = mediaTypeIcon(play.media_type);
  const text = <span className="block"><span className="block">{icon && <FontAwesomeIcon icon={icon} className="mr-1 h-3 w-3 text-muted-foreground" aria-hidden="true" />}{play.title || 'Removed item'}</span>{play.parent_title && <span className="block text-xs text-muted-foreground">{play.parent_title}</span>}</span>;
  const target = play.link && slug
    ? play.link.episode_id === null
      ? <Link to="/admin/servers/$serverId/libraries/$libraryId/$mediaId" params={{ serverId: slug, libraryId: String(play.link.library_id), mediaId: String(play.link.media_id) }} className="account-last-played-link">{text}</Link>
      : <Link to="/admin/servers/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId" params={{ serverId: slug, libraryId: String(play.link.library_id), mediaId: String(play.link.media_id), episodeId: String(play.link.episode_id) }} className="account-last-played-link">{text}</Link>
    : text;
  if (!play.poster_url || failed) return target;
  return <Tooltip>
    <TooltipTrigger asChild>{play.link ? target : <span tabIndex={0} className="account-last-played-link">{text}</span>}</TooltipTrigger>
    <TooltipContent side="right" className="account-poster-tip">
      <img src={play.poster_url} alt={play.title || 'Media poster'} onError={() => setFailed(true)} />
    </TooltipContent>
  </Tooltip>;
}
