import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useState, useEffect, useSyncExternalStore } from 'react';
import { useParams, Link, useSearch, useNavigate } from '@tanstack/react-router';
import { useAuth } from '../contexts/AuthContext';
import { getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import { useCatalogueView } from '../lib/catalogueView';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts/AlertContext';
import { purgeChildCatalogue, syncChildCatalogue } from '../lib/libraryCatalogue';
// Catalogue posters use signed session-bound URLs.
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { ActivityTable } from '../components/library/ActivityTable';
import { ExpandableText } from '../components/common/ExpandableText';
import { Pagination } from '../components/common/Pagination';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCube,
  faCirclePlay,
  faBook,
  faHeadphones,
  faBookOpen,
  faGamepad,
  faTriangleExclamation,
  faFileLines,
  faChevronLeft,
  faChevronRight,
  faArrowLeft,
  faRotate,
  faMagnifyingGlass,
  faCircleInfo,
  faStar,
  faFilm,
  faList,
  faChartLine,
  faServer,
  faTag,
  faFolder,
  faCalendar,
  faClock,
  faPlus,
  faEye,
  faTv,
  faMusic,
  faVideo,
  faXmark,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';

type ServiceType = 'plex' | 'jellyfin' | 'emby' | 'kavita' | 'audiobookshelf' | 'komga' | 'romm';

interface MediaItem {
  id: number;
  external_id: string;
  title: string;
  sort_title?: string;
  item_type?: string;
  year?: number;
  rating?: number;
  duration?: number;
  summary?: string;
  thumb?: string;
  added_at?: string;
  stream_count?: number;
  catalogue_supported?: boolean;
  episode_catalogue_supported?: boolean;
  track_catalogue_supported?: boolean;
  episode_revision?: number;
  // Episodes only: their numbers and their show.
  season_number?: number | null;
  episode_number?: number | null;
  show?: { id: number; title: string };
  library?: {
    id: number;
    name: string;
    library_type: string;
    server_id: number;
    server?: {
      id: number;
      server_nickname: string;
      server_name: string;
      service_type: ServiceType;
    };
  };
}

type TabType = 'overview' | 'episodes' | 'tracks' | 'activity';

// An episode, or an album's track or music video.
interface Episode {
  id: number;
  title: string;
  item_type?: string;
  duration?: number | null;
  season_number?: number;
  episode_number?: number;
  year?: number;
  rating?: number;
  thumb?: string;
  stream_count?: number;
}

const MEDIA_ROUTE = '/admin/servers/$serverId/libraries/$libraryId/$mediaId';
const EPISODE_ROUTE = '/admin/servers/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId';

export const MediaDetailPage = () => {
  const { libraryId, mediaId } = useParams({ from: MEDIA_ROUTE });
  const { user, isAdministrator } = useAuth();
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  if (!user || !isAdministrator || !auth.accessToken) return null;
  return <MediaDetailPageView key={JSON.stringify([user.uuid, auth.accessToken, libraryId, mediaId])} />;
};

/** An episode's page: the same layout as its show's, with Overview and Activity. */
export const EpisodeDetailPage = () => {
  const { libraryId, mediaId, episodeId } = useParams({ from: EPISODE_ROUTE });
  const { user, isAdministrator } = useAuth();
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  if (!user || !isAdministrator || !auth.accessToken) return null;
  return <MediaDetailPageView key={JSON.stringify([user.uuid, auth.accessToken, libraryId, mediaId, episodeId])} />;
};

const MediaDetailPageView = () => {
  const { formatTimestamp } = useAccountDisplay();
  const { success, error: showError, info } = useAlerts();
  // On an episode's page mediaId is its show and episodeId the episode.
  const { serverId, libraryId, mediaId, episodeId } = useParams({ strict: false }) as {
    serverId: string
    libraryId: string
    mediaId: string
    episodeId?: string
  };
  const isEpisode = episodeId !== undefined;
  const search = useSearch({ strict: false }) as { tab?: TabType };
  const navigate = useNavigate();

  const [mediaItem, setMediaItem] = useState<MediaItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Episodes state
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesPage, setEpisodesPage] = useState(1);
  const [episodesTotalPages, setEpisodesTotalPages] = useState(1);
  const [episodesTotalItems, setEpisodesTotalItems] = useState(0);
  const [episodesSearch, setEpisodesSearch] = useState('');
  const [episodesSortBy, setEpisodesSortBy] = useState('season_episode_asc');
  const [episodesPerPage, setEpisodesPerPage] = useState('24');
  const [syncing, setSyncing] = useState(false);
  const [purgingEpisodes, setPurgingEpisodes] = useState(false);

  // Activity state: this item's recent plays (a show's include its episodes).
  const [activityData, setActivityData] = useState<any[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityDays, setActivityDays] = useState(30);
  const [activityPage, setActivityPage] = useState(1);
  const [activityTotalPages, setActivityTotalPages] = useState(1);

  const activeTab: TabType = search.tab ?? 'overview';
  const [needsInspection, setNeedsInspection] = useState(false);
  const queries = {
    item: JSON.stringify([libraryId, mediaId, episodeId]),
    episodes: JSON.stringify([libraryId, mediaId, activeTab, episodesPage, episodesSearch, episodesSortBy, episodesPerPage]),
    activity: JSON.stringify([libraryId, mediaId, episodeId, activeTab, activityDays, activityPage]),
  };
  const view = useCatalogueView(queries);

  // Check if this is a TV show library (show, tv, series, tvshows)
  const libraryType = mediaItem?.library?.library_type?.toLowerCase() || '';
  const isTVShow = ['show', 'tv', 'series', 'tvshows'].includes(libraryType) && !isEpisode;
  // An album lists its tracks the way a show lists its episodes; both use the
  // child list state and actions below.
  const isAlbum = mediaItem?.item_type === 'album' && !isEpisode;
  const childNoun = isAlbum ? 'tracks' : 'episodes';
  const childSupported = isAlbum ? mediaItem?.track_catalogue_supported === true : mediaItem?.episode_catalogue_supported === true;
  const episodeCode = isEpisode && mediaItem?.season_number != null && mediaItem?.episode_number != null
    ? `S${mediaItem.season_number.toString().padStart(2, '0')}E${mediaItem.episode_number.toString().padStart(2, '0')}`
    : null;

  useEffect(() => {
    loadMediaItem();
  }, [libraryId, mediaId]);

  useEffect(() => {
    if (childSupported && (isTVShow && activeTab === 'episodes' || isAlbum && activeTab === 'tracks')) {
      loadEpisodes();
    }
  }, [libraryId, mediaId, activeTab, episodesPage, episodesSearch, episodesSortBy, episodesPerPage, isTVShow, isAlbum, childSupported]);

  useEffect(() => {
    if (activeTab === 'activity') loadActivity();
  }, [libraryId, mediaId, episodeId, activeTab, activityDays, activityPage]);

  const loadActivity = async () => {
    if (!libraryId || !mediaId) return false;
    if (!view.current()) return false;
    const read = view.begin('activity', queries.activity);
    if (!read.current()) return false;
    try {
      setActivityLoading(true);
      const response = await requestJson<{ data?: any[]; meta?: { pagination?: { total_pages?: number } } }>(
        `/api/libraries/${libraryId}/media/${mediaId}${isEpisode ? `/episodes/${episodeId}` : ''}/activity?days=${activityDays}&page=${activityPage}&page_size=20`,
        { signal: read.signal, retryAuthentication: false });
      if (!read.current()) return false;
      setActivityData(response.data || []);
      setActivityTotalPages(response.meta?.pagination?.total_pages || 1);
      return true;
    } catch (err) {
      if (!read.current()) return false;
      console.error('Failed to load activity:', err);
      setActivityData([]);
      return false;
    } finally {
      read.finish();
      if (read.current()) setActivityLoading(false);
    }
  };

  const loadMediaItem = async () => {
    if (!libraryId || !mediaId) return;

    if (!view.current()) return false;
    const read = view.begin('item', queries.item);
    if (!read.current()) return false;
    try {
      setLoading(true);
      const response = await requestJson<{data?: MediaItem}>(
        isEpisode
          ? `/api/libraries/${libraryId}/media/${mediaId}/episodes/${episodeId}`
          : `/api/libraries/${libraryId}/media/${mediaId}?include_library=true`,
        { signal: read.signal, retryAuthentication: false });
      if (!read.current()) return false;

      const matches = isEpisode
        ? response.data?.id === Number(episodeId) && response.data?.show?.id === Number(mediaId)
        : response.data?.id === Number(mediaId);
      if (!matches || response.data?.library?.id !== Number(libraryId)) throw new Error('Media detail does not match this route');
      // The library's own server decides the address; a different server in
      // the address is replaced with the right one.
      const ownServer = response.data!.library?.server_id;
      if (typeof ownServer === 'number' && ownServer !== Number(serverId)) {
        if (isEpisode) {
          navigate({ to: EPISODE_ROUTE, params: { serverId: String(ownServer), libraryId, mediaId, episodeId: episodeId! }, search: (prev: { tab?: 'overview' | 'activity' }) => prev, replace: true });
        } else {
          navigate({ to: MEDIA_ROUTE, params: { serverId: String(ownServer), libraryId, mediaId }, search: (prev: { tab?: TabType }) => prev, replace: true });
        }
        return false;
      }
      if (response.data) {
        setMediaItem(response.data);
        setError(null);
      }
      return true;
    } catch (err) {
      if (!read.current()) return false;
      if (!mediaItem) setError(err instanceof Error ? err.message : 'Failed to load media item');
      return false;
    } finally {
      read.finish();
      if (read.current()) setLoading(false);
    }
  };

  const loadEpisodes = async () => {
    if (!libraryId || !mediaId || !childSupported) return false;

    if (!view.current()) return false;
    const read = view.begin('episodes', queries.episodes);
    if (!read.current()) return false;
    try {
      setEpisodesLoading(true);
      // An album's tracks are listed in disc and track order, 100 at a time.
      const params = new URLSearchParams(isAlbum
        ? { page: episodesPage.toString(), page_size: '100', sort_by: 'season_episode_asc' }
        : { page: episodesPage.toString(), page_size: episodesPerPage, sort_by: episodesSortBy });
      if (episodesSearch && !isAlbum) {
        params.append('search', episodesSearch);
      }

      const response = await requestJson<{data?: {episodes?: Episode[]; tracks?: Episode[]}; meta?: {pagination?: {total_pages?: number; total_items?: number}}}>(
        `/api/libraries/${libraryId}/media/${mediaId}/${childNoun}?${params}`,
        { signal: read.signal, retryAuthentication: false });
      if (!read.current()) return false;

      const children = response.data?.[childNoun];
      if (!Array.isArray(children) || !response.meta?.pagination) throw new Error(`Invalid ${childNoun} list`);
      if (response.data) {
        setEpisodes(children);
        setEpisodesTotalPages(response.meta?.pagination?.total_pages || 1);
        setEpisodesTotalItems(response.meta?.pagination?.total_items || 0);
      }
      return true;
    } catch (err) {
      if (!read.current()) return false;
      console.error('Failed to load episodes:', err);
      setEpisodes([]);
      return false;
    } finally {
      read.finish();
      if (read.current()) setEpisodesLoading(false);
    }
  };

  const refreshSavedState = async () => {
    if (!view.current()) return;
    const inspection = view.inspectionRevision();
    const detail = await loadMediaItem();
    if (!view.current()) return;
    const items = await loadEpisodes();
    if (!view.current()) return;
    if (detail && items && view.inspected(inspection)) setNeedsInspection(false);
  };

  const handleSyncEpisodes = async () => {
    if (!libraryId || !mediaId || !childSupported || mediaItem?.episode_revision == null) return;

    const mutation = view.beginMutation();
    if (!mutation) return;
    try {
      setSyncing(true);
      const outcome = await syncChildCatalogue(childNoun, Number(libraryId), Number(mediaId), mediaItem.episode_revision);
      if (!mutation.current()) return;
      view.requireInspection();
      setNeedsInspection(true);
      if (outcome.kind !== 'committed') {
        showError(outcome.message);
      } else {
        const { added, updated, removed } = outcome.receipt;
        if (added + updated + removed > 0) {
          success(outcome.receipt.message);
        } else {
          info(outcome.receipt.message || 'No changes detected');
        }
      }
      // Reload the saved state either way; a refused or unconfirmed outcome is never retried.
      await refreshSavedState();
    } finally {
      if (mutation.current()) setSyncing(false);
      mutation.finish();
    }
  };

  const handlePurgeEpisodes = async () => {
    if (!libraryId || !mediaId || !childSupported || mediaItem?.episode_revision == null) return;
    const confirmed = window.confirm(
      isAlbum
        ? 'Purge all cached tracks for this album? They will need to be re-synced from the server.'
        : 'Purge all cached episodes for this show? They will need to be re-synced from the server.'
    );
    if (!confirmed) {
      return;
    }

    const mutation = view.beginMutation();
    if (!mutation) return;
    try {
      setPurgingEpisodes(true);
      const outcome = await purgeChildCatalogue(childNoun, Number(libraryId), Number(mediaId), mediaItem.episode_revision);
      if (!mutation.current()) return;
      view.requireInspection();
      setNeedsInspection(true);
      if (outcome.kind !== 'committed') {
        showError(outcome.message);
      } else {
        const deleted = outcome.receipt.deleted;
        success(`Purged ${deleted} episode${deleted === 1 ? '' : 's'}`);
        setEpisodesPage(1);
      }
      await refreshSavedState();
    } finally {
      if (mutation.current()) setPurgingEpisodes(false);
      mutation.finish();
    }
  };

  const setTab = (tab: TabType) => {
    if (isEpisode) {
      // An episode has only Overview and Activity.
      navigate({ from: EPISODE_ROUTE, search: (prev) => ({ ...prev, tab: tab === 'overview' || tab === 'activity' ? tab : undefined }) });
    } else {
      navigate({ from: MEDIA_ROUTE, search: (prev) => ({ ...prev, tab }) });
    }
  };

  const getServiceBadge = (serviceType?: ServiceType) => {
    if (!serviceType) return null;

    const badges = {
      plex: {
        bg: 'bg-plex-50 dark:bg-plex-400/10',
        text: 'text-plex-700 dark:text-plex-400',
        ring: 'ring-plex-600/20 dark:ring-plex-500/20',
        icon: (
          <svg className="w-3 h-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" strokeLinejoin="round" strokeWidth="12">
            <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/>
          </svg>
        ),
        name: 'Plex'
      },
      jellyfin: {
        bg: 'bg-jellyfin-50 dark:bg-jellyfin-400/10',
        text: 'text-jellyfin-700 dark:text-jellyfin-400',
        ring: 'ring-jellyfin-600/20 dark:ring-jellyfin-500/20',
        icon: <FontAwesomeIcon icon={faCube} className="w-3 h-3" />,
        name: 'Jellyfin'
      },
      emby: {
        bg: 'bg-emby-50 dark:bg-emby-400/10',
        text: 'text-emby-700 dark:text-emby-400',
        ring: 'ring-emby-600/20 dark:ring-emby-500/20',
        icon: <FontAwesomeIcon icon={faCirclePlay} className="w-3 h-3" />,
        name: 'Emby'
      },
      kavita: {
        bg: 'bg-kavita-50 dark:bg-kavita-400/10',
        text: 'text-kavita-700 dark:text-kavita-400',
        ring: 'ring-kavita-600/20 dark:ring-kavita-500/20',
        icon: <FontAwesomeIcon icon={faBook} className="w-3 h-3" />,
        name: 'Kavita'
      },
      audiobookshelf: {
        bg: 'bg-audiobookshelf-50 dark:bg-audiobookshelf-400/10',
        text: 'text-audiobookshelf-700 dark:text-audiobookshelf-400',
        ring: 'ring-audiobookshelf-600/20 dark:ring-audiobookshelf-500/20',
        icon: <FontAwesomeIcon icon={faHeadphones} className="w-3 h-3" />,
        name: 'AudiobookShelf'
      },
      komga: {
        bg: 'bg-komga-50 dark:bg-komga-400/10',
        text: 'text-komga-700 dark:text-komga-400',
        ring: 'ring-komga-600/20 dark:ring-komga-500/20',
        icon: <FontAwesomeIcon icon={faBookOpen} className="w-3 h-3" />,
        name: 'Komga'
      },
      romm: {
        bg: 'bg-romm-50 dark:bg-romm-400/10',
        text: 'text-romm-700 dark:text-romm-400',
        ring: 'ring-romm-600/20 dark:ring-romm-500/20',
        icon: <FontAwesomeIcon icon={faGamepad} className="w-3 h-3" />,
        name: 'RomM'
      }
    };

    const badge = badges[serviceType];
    if (!badge) return null;

    return (
      <span className={`inline-flex items-center rounded-md ${badge.bg} px-2 py-1 text-xs font-medium ${badge.text} ring-1 ring-inset ${badge.ring} gap-1`}>
        {badge.icon}
        {badge.name}
      </span>
    );
  };

  // A track's length as minutes:seconds (hours:minutes:seconds when longer).
  const formatTrackDuration = (ms?: number | null) => {
    if (ms == null) return '';
    const total = Math.round(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return null;
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !mediaItem) {
    return (
      <div className="container mx-auto px-4 py-8 space-y-6">
        <Card className="border-destructive">
          <CardContent className="p-6 flex items-center gap-3">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive" />
            <span className="text-destructive">{error || 'Media item not found'}</span>
          </CardContent>
        </Card>
        <Link to="/admin/servers/$serverId/libraries/$libraryId" params={{ serverId, libraryId }} search={{ tab: 'media' }}>
          <Button>
            <FontAwesomeIcon icon={faArrowLeft} className="mr-2 h-4 w-4" />
            Back to Library
          </Button>
        </Link>
      </div>
    );
  }

  const serviceType = mediaItem.library?.server?.service_type;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      {/* Hero Header Section */}
      <Card className="bg-gradient-to-r from-primary/10 to-secondary/10">
        <CardContent className="p-8">
          <div className="flex flex-col lg:flex-row items-center gap-8">
            {/* Media Poster */}
            <div className="flex-shrink-0">
              {mediaItem.thumb ? (
                <div className="w-48 h-72 rounded-lg overflow-hidden shadow-lg bg-accent">
                  <img
                    src={mediaItem.thumb || ''}
                    alt={mediaItem.title}
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div className="w-48 h-72 rounded-lg bg-accent flex items-center justify-center text-6xl text-muted-foreground">
                  <FontAwesomeIcon icon={faFilm} className="h-24 w-24" />
                </div>
              )}
            </div>

            {/* Media Info */}
            <div className="text-center lg:text-left space-y-4 flex-1">
              <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold break-words">
                {mediaItem.title}
              </h1>

              <div className="flex flex-wrap items-center justify-center lg:justify-start gap-3 text-sm">
                {getServiceBadge(serviceType)}

                <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border gap-1">
                  <FontAwesomeIcon icon={faServer} className="w-3 h-3" />
                  {mediaItem.library?.server?.server_nickname}
                </span>

                <Link to="/admin/servers/$serverId/libraries/$libraryId" params={{ serverId, libraryId }}>
                  <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1 hover:bg-blue-100 dark:hover:bg-blue-400/20 transition-colors cursor-pointer">
                    <FontAwesomeIcon icon={faFolder} className="w-3 h-3" />
                    {mediaItem.library?.name}
                  </span>
                </Link>

                {isEpisode && mediaItem.show && (
                  <Link to={MEDIA_ROUTE} params={{ serverId, libraryId, mediaId }} search={{ tab: 'episodes' }}>
                    <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1 hover:bg-blue-100 dark:hover:bg-blue-400/20 transition-colors cursor-pointer">
                      <FontAwesomeIcon icon={faTv} className="w-3 h-3" />
                      {mediaItem.show.title}
                    </span>
                  </Link>
                )}

                {episodeCode && (
                  <span className="inline-flex items-center rounded-md bg-purple-50 dark:bg-purple-400/10 px-2 py-1 text-xs font-medium text-purple-700 dark:text-purple-400 ring-1 ring-inset ring-purple-600/20 dark:ring-purple-500/20 gap-1">
                    <FontAwesomeIcon icon={faList} className="w-3 h-3" />
                    {episodeCode}
                  </span>
                )}

                {(mediaItem as any).type && (
                  <span className="inline-flex items-center rounded-md bg-purple-50 dark:bg-purple-400/10 px-2 py-1 text-xs font-medium text-purple-700 dark:text-purple-400 ring-1 ring-inset ring-purple-600/20 dark:ring-purple-500/20 gap-1">
                    <FontAwesomeIcon icon={faTag} className="w-3 h-3" />
                    {(mediaItem as any).type}
                  </span>
                )}

                {mediaItem.year && (
                  <span className="inline-flex items-center rounded-md bg-orange-50 dark:bg-orange-400/10 px-2 py-1 text-xs font-medium text-orange-700 dark:text-orange-400 ring-1 ring-inset ring-orange-600/20 dark:ring-orange-500/20 gap-1">
                    <FontAwesomeIcon icon={faCalendar} className="w-3 h-3" />
                    {mediaItem.year}
                  </span>
                )}
              </div>

              {/* Summary */}
              {mediaItem.summary && (
                <div className="text-left max-w-2xl">
                  <ExpandableText text={mediaItem.summary} limit={300} className="text-sm text-muted-foreground leading-relaxed" />
                </div>
              )}

              {/* Additional Info */}
              <div className="flex flex-wrap gap-4 text-sm text-muted-foreground justify-center lg:justify-start">
                {mediaItem.rating && (
                  <div className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faStar} className="h-4 w-4 text-yellow-500" />
                    <span>{mediaItem.rating.toFixed(1)}</span>
                  </div>
                )}
                {mediaItem.duration && (
                  <div className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faClock} className="h-4 w-4" />
                    <span>{formatDuration(mediaItem.duration)}</span>
                  </div>
                )}
                {mediaItem.added_at && (
                  <div className="flex items-center gap-1">
                    <FontAwesomeIcon icon={faPlus} className="h-4 w-4" />
                    <span>Added {formatTimestamp(mediaItem.added_at, 'date')}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabType)}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="overview">
            <FontAwesomeIcon icon={faCircleInfo} className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          {isTVShow && (
            <TabsTrigger value="episodes">
              <FontAwesomeIcon icon={faList} className="mr-2 h-4 w-4" />
              Episodes
            </TabsTrigger>
          )}
          {isAlbum && (
            <TabsTrigger value="tracks">
              <FontAwesomeIcon icon={faMusic} className="mr-2 h-4 w-4" />
              Tracks
            </TabsTrigger>
          )}
          <TabsTrigger value="activity">
            <FontAwesomeIcon icon={faChartLine} className="mr-2 h-4 w-4" />
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Media Information */}
            <Card>
              <CardContent className="p-6 space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <FontAwesomeIcon icon={faCircleInfo} className="h-5 w-5 text-primary" />
                  Media Information
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground mr-2">Title:</span>
                    <span className="font-medium">{mediaItem.title}</span>
                  </div>
                  {isEpisode && mediaItem.show && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground mr-2">Show:</span>
                      <Link to={MEDIA_ROUTE} params={{ serverId, libraryId, mediaId }} search={{ tab: 'episodes' }} className="font-medium text-primary hover:underline">
                        {mediaItem.show.title}
                      </Link>
                    </div>
                  )}
                  {isEpisode && mediaItem.season_number != null && mediaItem.episode_number != null && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground mr-2">Episode:</span>
                      <span className="font-medium">Season {mediaItem.season_number}, Episode {mediaItem.episode_number}</span>
                    </div>
                  )}
                  {(mediaItem as any).type && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Type:</span>
                      <span className="font-medium capitalize">{(mediaItem as any).type}</span>
                    </div>
                  )}
                  {mediaItem.year && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Year:</span>
                      <span className="font-medium">{mediaItem.year}</span>
                    </div>
                  )}
                  {mediaItem.rating && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Rating:</span>
                      <span className="font-medium">{mediaItem.rating.toFixed(1)}/10</span>
                    </div>
                  )}
                  {mediaItem.duration && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Duration:</span>
                      <span className="font-medium">{formatDuration(mediaItem.duration)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Library:</span>
                    <span className="font-medium">{mediaItem.library?.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Server:</span>
                    <span className="font-medium">{mediaItem.library?.server?.server_nickname}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Service:</span>
                    <span className="font-medium capitalize">{serviceType}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">External ID:</span>
                    <span className="font-medium font-mono text-sm">{mediaItem.external_id}</span>
                  </div>
                  {mediaItem.added_at && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Added:</span>
                      <span className="font-medium">
                        {formatTimestamp(mediaItem.added_at)}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Summary */}
            {mediaItem.summary && (
              <Card>
                <CardContent className="p-6 space-y-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <FontAwesomeIcon icon={faFileLines} className="text-primary" />
                    Summary
                  </h3>
                  <ExpandableText text={mediaItem.summary} limit={600} className="text-sm text-muted-foreground leading-relaxed" />
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="episodes" className="space-y-6">
          {isTVShow && (
            <>
              {/* Episodes Header */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <h3 className="text-lg font-semibold flex items-center">
                  <FontAwesomeIcon icon={faList} className="text-primary mr-2 h-5 w-5" />
                  Episodes
                  <span className="text-sm text-muted-foreground ml-2">
                    ({episodesTotalItems} episodes)
                  </span>
                </h3>

                {/* Actions */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handlePurgeEpisodes}
                    disabled={purgingEpisodes || syncing || needsInspection || !mediaItem?.episode_catalogue_supported}
                    title="Delete cached episodes for this show from the database"
                  >
                    {purgingEpisodes ? (
                      <>
                        <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4 animate-spin" />
                        Purging...
                      </>
                    ) : (
                      <>
                        <FontAwesomeIcon icon={faTrash} className="mr-2 h-4 w-4" />
                        Purge
                      </>
                    )}
                  </Button>
                  <Button onClick={refreshSavedState} disabled={syncing || purgingEpisodes || !mediaItem?.episode_catalogue_supported} size="sm" variant="outline">Refresh saved state</Button>
                  {needsInspection && <span>Inspect saved state before another action.</span>}
                  <Button onClick={handleSyncEpisodes} disabled={syncing || purgingEpisodes || needsInspection || !mediaItem?.episode_catalogue_supported} size="sm">
                    {syncing ? (
                      <>
                        <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4 animate-spin" />
                        Syncing...
                      </>
                    ) : (
                      <>
                        <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
                        Sync
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Search and Sort */}
              <Card>
                <CardContent>
                  <div className="flex flex-col sm:flex-row gap-4">
                    {/* Search Box */}
                    <div className="flex-1">
                      <div className="relative">
                        <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          type="text"
                          placeholder="Search episodes..."
                          className="pl-10 pr-10"
                          value={episodesSearch}
                          onChange={(e) => {
                            setEpisodesSearch(e.target.value);
                            setEpisodesPage(1);
                          }}
                        />
                        {episodesSearch && (
                          <button
                            type="button"
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            onClick={() => setEpisodesSearch('')}
                          >
                            <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Sort Dropdown */}
                    <div className="flex items-center gap-2">
                      <Label className="text-sm whitespace-nowrap">Sort by:</Label>
                      <Select value={episodesSortBy} onValueChange={setEpisodesSortBy}>
                        <SelectTrigger className="w-[240px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="season_episode_asc">Season/Episode (S01E01)</SelectItem>
                          <SelectItem value="season_episode_desc">Season/Episode (Reverse)</SelectItem>
                          <SelectItem value="title_asc">Title (A to Z)</SelectItem>
                          <SelectItem value="title_desc">Title (Z to A)</SelectItem>
                          <SelectItem value="year_desc">Year (Newest First)</SelectItem>
                          <SelectItem value="year_asc">Year (Oldest First)</SelectItem>
                          <SelectItem value="added_at_desc">Date Added (Newest)</SelectItem>
                          <SelectItem value="added_at_asc">Date Added (Oldest)</SelectItem>
                          <SelectItem value="total_streams_desc">Streams (Most)</SelectItem>
                          <SelectItem value="total_streams_asc">Streams (Least)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Per Page Dropdown */}
                    <div className="flex items-center gap-2">
                      <Label className="text-sm whitespace-nowrap">Per page:</Label>
                      <Select
                        value={episodesPerPage}
                        onValueChange={(value) => {
                          setEpisodesPerPage(value);
                          setEpisodesPage(1);
                        }}
                      >
                        <SelectTrigger className="w-[100px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="12">12</SelectItem>
                          <SelectItem value="24">24</SelectItem>
                          <SelectItem value="48">48</SelectItem>
                          <SelectItem value="96">96</SelectItem>
                          <SelectItem value="200">200</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Episodes Grid */}
              {episodesLoading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <div key={idx} className="space-y-2">
                      <Skeleton className="aspect-[2/3] w-full rounded-lg" />
                      <Skeleton className="h-4 w-3/4 mx-auto" />
                    </div>
                  ))}
                </div>
              ) : episodes.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                    {episodes.map((episode) => (
                      <Link key={episode.id} to={EPISODE_ROUTE} params={{ serverId, libraryId, mediaId, episodeId: String(episode.id) }} className="group cursor-pointer block">
                        {/* Episode Poster Container */}
                        <div className="relative aspect-[2/3] bg-accent rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 group-hover:scale-105">
                          {episode.thumb ? (
                            <img
                              src={episode.thumb || ''}
                              alt={episode.title}
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="absolute inset-0 bg-accent flex items-center justify-center text-muted-foreground">
                              <FontAwesomeIcon icon={faTv} className="h-12 w-12" />
                            </div>
                          )}

                          {/* Hover Overlay */}
                          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                            <div className="text-center text-white p-2">
                              <FontAwesomeIcon icon={faTv} className="h-8 w-8 mx-auto mb-2" />
                              <div className="text-xs">View Episode</div>
                            </div>
                          </div>

                          {/* Rating Badge */}
                          {episode.rating && (
                            <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1">
                              <FontAwesomeIcon icon={faStar} className="h-3 w-3 text-yellow-400" />
                              {episode.rating.toFixed(1)}
                            </div>
                          )}

                          {/* Episode Type Badge */}
                          <div className="absolute top-2 left-2 bg-primary/80 text-primary-foreground text-xs px-2 py-1 rounded-full capitalize">
                            Episode
                          </div>

                          {/* Stream Count Badge */}
                          {episode.stream_count !== undefined && episode.stream_count > 0 && (
                            <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1">
                              <FontAwesomeIcon icon={faEye} className="h-3 w-3" />
                              {episode.stream_count}
                            </div>
                          )}
                        </div>

                        {/* Episode Title and Details */}
                        <div className="mt-2 text-center">
                          <h4 className="font-medium text-sm line-clamp-2 group-hover:text-primary transition-colors" title={episode.title}>
                            {episode.title}
                          </h4>
                          {episode.season_number != null && episode.episode_number != null && (
                            <p className="text-xs text-muted-foreground mt-1">
                              S{episode.season_number.toString().padStart(2, '0')}E{episode.episode_number.toString().padStart(2, '0')}
                              {episode.year && ` • ${episode.year}`}
                            </p>
                          )}
                        </div>
                      </Link>
                    ))}
                  </div>

                  {/* Pagination */}
                  {episodesTotalPages > 1 && (
                    <div className="flex justify-center gap-2 flex-wrap">
                      {episodesPage > 1 && (
                        <Button variant="outline" size="sm" onClick={() => setEpisodesPage(episodesPage - 1)}>
                          <FontAwesomeIcon icon={faChevronLeft} />
                        </Button>
                      )}

                      {(() => {
                        const pages: (number | string)[] = [];
                        const maxPagesToShow = 7; // Show up to 7 page buttons
                        const halfWindow = Math.floor((maxPagesToShow - 3) / 2); // Pages on each side of current

                        if (episodesTotalPages <= maxPagesToShow) {
                          // Show all pages if total is small
                          for (let i = 1; i <= episodesTotalPages; i++) {
                            pages.push(i);
                          }
                        } else {
                          // Always show first page
                          pages.push(1);

                          // Calculate start and end of the middle range
                          let start = Math.max(2, episodesPage - halfWindow);
                          let end = Math.min(episodesTotalPages - 1, episodesPage + halfWindow);

                          // Adjust if we're near the start
                          if (episodesPage <= halfWindow + 2) {
                            end = Math.min(episodesTotalPages - 1, maxPagesToShow - 1);
                          }

                          // Adjust if we're near the end
                          if (episodesPage >= episodesTotalPages - halfWindow - 1) {
                            start = Math.max(2, episodesTotalPages - maxPagesToShow + 2);
                          }

                          // Add ellipsis after first page if needed
                          if (start > 2) {
                            pages.push('ellipsis-start');
                          }

                          // Add middle pages
                          for (let i = start; i <= end; i++) {
                            pages.push(i);
                          }

                          // Add ellipsis before last page if needed
                          if (end < episodesTotalPages - 1) {
                            pages.push('ellipsis-end');
                          }

                          // Always show last page
                          pages.push(episodesTotalPages);
                        }

                        return pages.map((page, index) => {
                          if (typeof page === 'string') {
                            return (
                              <span key={page} className="px-2 py-1 text-muted-foreground">
                                ...
                              </span>
                            );
                          }
                          return (
                            <Button
                              key={page}
                              variant={episodesPage === page ? "default" : "outline"}
                              size="sm"
                              onClick={() => setEpisodesPage(page)}
                            >
                              {page}
                            </Button>
                          );
                        });
                      })()}

                      {episodesPage < episodesTotalPages && (
                        <Button variant="outline" size="sm" onClick={() => setEpisodesPage(episodesPage + 1)}>
                          <FontAwesomeIcon icon={faChevronRight} />
                        </Button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                      <FontAwesomeIcon icon={faList} className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-medium mb-2">{mediaItem?.episode_catalogue_supported ? 'No Episodes Found' : 'Episodes unavailable'}</h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                      {mediaItem?.episode_catalogue_supported ? 'No episodes are available for this show. Click the Sync button to fetch episodes.' : 'Episode synchronization is unavailable for this provider.'}
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="tracks" className="space-y-6">
          {isAlbum && (
            <>
              {/* Tracks Header */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <h3 className="text-lg font-semibold flex items-center">
                  <FontAwesomeIcon icon={faMusic} className="text-primary mr-2 h-5 w-5" />
                  Tracks
                  <span className="text-sm text-muted-foreground ml-2">
                    ({episodesTotalItems} {episodesTotalItems === 1 ? 'item' : 'items'})
                  </span>
                </h3>

                {/* Actions */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handlePurgeEpisodes}
                    disabled={purgingEpisodes || syncing || needsInspection || !childSupported}
                    title="Delete cached tracks for this album from the database"
                  >
                    {purgingEpisodes ? (
                      <>
                        <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4 animate-spin" />
                        Purging...
                      </>
                    ) : (
                      <>
                        <FontAwesomeIcon icon={faTrash} className="mr-2 h-4 w-4" />
                        Purge
                      </>
                    )}
                  </Button>
                  <Button onClick={refreshSavedState} disabled={syncing || purgingEpisodes || !childSupported} size="sm" variant="outline">Refresh saved state</Button>
                  {needsInspection && <span>Inspect saved state before another action.</span>}
                  <Button onClick={handleSyncEpisodes} disabled={syncing || purgingEpisodes || needsInspection || !childSupported} size="sm">
                    {syncing ? (
                      <>
                        <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4 animate-spin" />
                        Syncing...
                      </>
                    ) : (
                      <>
                        <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
                        Sync
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Track List: in disc and track order, each music video on its own row after its track */}
              {episodesLoading ? (
                <Card className="py-0 overflow-hidden">
                  <CardContent className="p-0 divide-y">
                    {Array.from({ length: 8 }).map((_, idx) => (
                      <div key={idx} className="flex items-center gap-4 px-4 py-3">
                        <Skeleton className="h-4 w-6" />
                        <Skeleton className="h-4 flex-1" />
                        <Skeleton className="h-4 w-12" />
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ) : episodes.length > 0 ? (
                <>
                  <Card className="py-0 overflow-hidden">
                    <CardContent className="p-0 divide-y">
                      {episodes.map((track, index) => {
                        const isVideo = track.item_type === 'music_video';
                        const discs = new Set(episodes.map((t) => t.season_number ?? null));
                        const newDisc = discs.size > 1 && (index === 0 || episodes[index - 1].season_number !== track.season_number);
                        return (
                          <div key={track.id}>
                            {newDisc && (
                              <div className="px-4 py-2 text-xs font-semibold text-muted-foreground bg-muted/50">
                                {track.season_number != null ? `Disc ${track.season_number}` : 'Other'}
                              </div>
                            )}
                            <div className="flex items-center gap-4 px-4 py-3 hover:bg-accent/50 transition-colors">
                              <span className="w-8 text-right text-sm text-muted-foreground">
                                {isVideo ? '' : track.episode_number ?? '—'}
                              </span>
                              <div className="flex min-w-0 flex-1 items-center gap-2">
                                {isVideo && (
                                  <FontAwesomeIcon icon={faVideo} className="h-4 w-4 text-primary" title="Music video" />
                                )}
                                <span className="truncate font-medium" title={track.title}>{track.title}</span>
                              </div>
                              {track.stream_count !== undefined && track.stream_count > 0 && (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`${track.stream_count} ${track.stream_count === 1 ? 'play' : 'plays'}`}>
                                  <FontAwesomeIcon icon={faEye} className="h-3 w-3" />
                                  {track.stream_count}
                                </span>
                              )}
                              <span className="w-12 text-right text-sm text-muted-foreground">
                                {formatTrackDuration(track.duration)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                  {episodesTotalPages > 1 && (
                    <Pagination
                      currentPage={episodesPage}
                      totalPages={episodesTotalPages}
                      onPageChange={setEpisodesPage}
                      loading={episodesLoading}
                    />
                  )}
                </>
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                      <FontAwesomeIcon icon={faMusic} className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-medium mb-2">{childSupported ? 'No Tracks Found' : 'Tracks unavailable'}</h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                      {childSupported ? 'No tracks are saved for this album. Click the Sync button to fetch tracks.' : 'Track synchronization is unavailable for this provider.'}
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="activity" className="space-y-6">
          <ActivityTable
            days={activityDays}
            onDaysChange={(days) => { setActivityDays(days); setActivityPage(1); }}
            page={activityPage}
            totalPages={activityTotalPages}
            onPageChange={setActivityPage}
            loading={activityLoading}
            rows={activityData}
            emptyMessage={`No streaming activity found for this ${isEpisode ? 'episode' : isTVShow ? 'show' : isAlbum ? 'album' : 'item'} in the selected time period.`}
          />
        </TabsContent>
      </Tabs>

      {/* Back Button */}
      {isEpisode ? (
        <Link to={MEDIA_ROUTE} params={{ serverId, libraryId, mediaId }} search={{ tab: 'episodes' }}>
          <Button variant="ghost">
            <FontAwesomeIcon icon={faArrowLeft} className="mr-2 h-4 w-4" />
            Back to Show
          </Button>
        </Link>
      ) : (
        <Link to="/admin/servers/$serverId/libraries/$libraryId" params={{ serverId, libraryId }} search={{ tab: 'media' }}>
          <Button variant="ghost">
            <FontAwesomeIcon icon={faArrowLeft} className="mr-2 h-4 w-4" />
            Back to Library
          </Button>
        </Link>
      )}
    </div>
  );
};

export default MediaDetailPage;
