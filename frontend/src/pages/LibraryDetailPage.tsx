import { formatCalendarDate } from '../util/calendarDates';
import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useState, useEffect, useSyncExternalStore, useMemo, useRef } from 'react';
import { useNavigate, Link, useParams, useSearch } from '@tanstack/react-router';
import { useAuth } from '../contexts/AuthContext';
import { getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import { useCatalogueView } from '../lib/catalogueView';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts/AlertContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Pagination } from '../components/common/Pagination';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { TabHeading } from '../components/users/AccountSettings';
import { libraryTypeIcon } from '../components/servers/ServerLibrariesCard';
import { ActivityTable } from '../components/library/ActivityTable';
import { Progress } from '../components/ui/progress';
import { ResponsiveDialog } from '../components/ui/responsive-dialog';
import { Spinner } from '@/components/ui/spinner'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getServicePalette, getServiceMeta } from '@/config/mediaServiceMetadata';
// Catalogue posters use signed session-bound URLs.
import { useLibrarySyncStatus } from '../hooks/useLibrarySyncStatus';
import { purgeLibraryCatalogue, syncLibraryCatalogue } from '../lib/libraryCatalogue';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faStar,
  faTriangleExclamation,
  faFolderOpen,
  faChevronLeft,
  faChevronRight,
  faArrowLeft,
  faRotate,
  faMagnifyingGlass,
  faCircleInfo,
  faFilm,
  faLayerGroup,
  faCompactDisc,
  faMusic,
  faChartBar,
  faPlay,
  faClockRotateLeft,
  faServer,
  faTag,
  faEye,
  faTrash,
  faEllipsis,
  faUsers,
  faClock,
} from '@fortawesome/free-solid-svg-icons';
import { LibraryOverview } from '../components/library/LibraryOverview';
import { Tile } from '../components/library/LibraryOverview';
import { watchTime } from '../lib/identityPlayTotals';

type ServiceType = 'plex' | 'jellyfin' | 'emby' | 'kavita' | 'audiobookshelf' | 'komga' | 'romm';

interface Library {
  id: number;
  internal_id: string;
  external_id: string;
  name: string;
  library_type: string;
  item_count: number;
  last_scanned: string | null;
  server_id: number;
  server?: {
    id: number;
    server_nickname: string;
    server_name: string;
    service_type: ServiceType;
  };
  catalogue?: {
    supported: boolean;
    collections_supported?: boolean;
    episodes_supported?: boolean;
    tracks_supported?: boolean;
    revision: number;
    synced_at: string | null;
    item_count: number | null;
  };
}

interface MediaItem {
  id: number;
  external_id: string;
  title: string;
  sort_title?: string;
  item_type?: string;
  year?: number;
  edition?: string;
  rating?: number;
  thumb?: string;
  added_at?: string;
  stream_count?: number;
}

interface LibraryStats {
  library_type: string;
}

// API response types for stronger typing
interface LibraryCollection {
  id: number;
  title: string;
  child_count: number | null;
  smart: boolean;
  thumb: string | null;
  added_at: string | null;
}

type CollectionsApi = { data?: { collections?: unknown } };

// Accept only the current collection DTO; posters must be this server's signed links.
const readCollections = (value: unknown): LibraryCollection[] | null => {
  if (!Array.isArray(value)) return null;
  const valid = value.every((c) => c && typeof c === 'object'
    && Number.isSafeInteger(c.id) && c.id > 0 && typeof c.title === 'string'
    && (c.child_count === null || Number.isSafeInteger(c.child_count)) && typeof c.smart === 'boolean'
    && (c.thumb === null || (typeof c.thumb === 'string' && c.thumb.startsWith('/api/media/collections/images/')))
    && (c.added_at === null || typeof c.added_at === 'string'));
  return valid ? (value as LibraryCollection[]) : null;
};
type StatsApi = { data?: any };
type ActivityApi = { data?: any[]; meta?: { pagination?: { total_pages?: number } } };
type LibraryApi = { data?: Library };
type MediaListApi = { data?: MediaItem[]; meta?: { pagination?: { total_pages?: number; total_items?: number } } };

type TabType = 'overview' | 'media' | 'collections' | 'stats' | 'activity';

const formatMinutesCompact = (rawMinutes: number) => {
  const minutes = Math.max(0, Math.round(rawMinutes || 0));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${minutes}m`;
};

const formatLibraryStatsChartDateShort = (value: string) => formatCalendarDate(value, 'short');
const formatLibraryStatsChartDateFull = (value: string) => formatCalendarDate(value, 'full');

const renderLibraryStatsAreaTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ReadonlyArray<any>;
  label?: string | number;
}) => {
  if (!active || !payload || payload.length === 0) return null;

  const rows = payload
    .filter((entry) => entry && typeof entry.value !== 'undefined')
    .map((entry) => {
      const dataKey = String(entry.dataKey || '').toLowerCase();
      const rawValue = Number(entry.value || 0);
      const isWatchTime = dataKey === 'time' || String(entry.name || '').toLowerCase().includes('watch');
      return {
        key: `${entry.dataKey}-${entry.name}`,
        label: isWatchTime ? 'Watch Time' : 'Total Plays',
        value: isWatchTime ? formatMinutesCompact(rawValue) : String(Math.round(rawValue)),
        dotClass: isWatchTime ? 'bg-emerald-500' : 'bg-primary',
      };
    });

  return (
    <div className="min-w-[220px] rounded-xl border border-border/60 bg-popover/95 px-4 py-3 text-popover-foreground shadow-2xl backdrop-blur">
      <div className="text-sm font-semibold">{formatLibraryStatsChartDateFull(String(label || ''))}</div>
      <div className="my-3 h-px bg-border/60" />
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className={`h-2.5 w-2.5 rounded-full ${row.dotClass}`} />
              <span>{row.label}</span>
            </div>
            <span className="font-semibold text-popover-foreground">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Component for individual media poster with loading state
const MediaPosterCard = ({ item, serverId, libraryId }: { item: MediaItem; serverId: string; libraryId: string }) => {
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  return (
    <Link to="/admin/servers/$serverId/libraries/$libraryId/$mediaId" params={{ serverId, libraryId: String(libraryId), mediaId: String(item.id) }} className="group cursor-pointer">
      <div className="relative aspect-[2/3] bg-accent rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 group-hover:scale-105">
        {item.thumb && !imageError ? (
          <>
            {imageLoading && (
              <Skeleton className="absolute inset-0 rounded-lg" />
            )}
            <img
              src={item.thumb || ''}
              alt={item.title}
              className={`w-full h-full object-cover ${imageLoading ? 'opacity-0' : 'opacity-100'} transition-opacity duration-200`}
              loading="lazy"
              onLoad={() => setImageLoading(false)}
              onError={() => {
                setImageLoading(false);
                setImageError(true);
              }}
            />
          </>
        ) : (
          <div className="absolute inset-0 bg-accent flex items-center justify-center text-muted-foreground">
            <FontAwesomeIcon icon={faFilm} className="h-12 w-12" />
          </div>
        )}

        {item.rating && (
          <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1">
            <FontAwesomeIcon icon={faStar} className="text-yellow-400" />
            {item.rating.toFixed(1)}
          </div>
        )}

        {(item.stream_count ?? 0) > 0 && (
          <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1">
            <FontAwesomeIcon icon={faEye} className="h-3 w-3" />
            {item.stream_count}
          </div>
        )}

        {(item as any).type && (
          <div className="absolute top-2 left-2 bg-primary/80 text-primary-foreground text-xs px-2 py-1 rounded-full capitalize">
            {(item as any).type}
          </div>
        )}
      </div>

      <div className="mt-2 text-left">
        <h4 className="font-medium text-sm line-clamp-1 truncate group-hover:text-primary transition-colors" title={item.title}>
          {item.title}
        </h4>
        {(item.year || item.edition) && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-1 truncate">
            {item.year ? item.year : null}
            {item.year && item.edition ? ' · ' : null}
            {item.edition ? item.edition : null}
          </p>
        )}
      </div>
    </Link>
  );
};

// Component for individual collection card with loading state
const CollectionCard = ({ collection }: { collection: LibraryCollection }) => {
  const { formatTimestamp } = useAccountDisplay();
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  return (
    <div className="group cursor-pointer">
      <div className="relative aspect-[2/3] bg-accent rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 group-hover:scale-105">
        {collection.thumb && !imageError ? (
          <>
            {imageLoading && (
              <Skeleton className="absolute inset-0 rounded-lg" />
            )}
            <img
              src={collection.thumb}
              alt={collection.title}
              className={`w-full h-full object-cover ${imageLoading ? 'opacity-0' : 'opacity-100'} transition-opacity duration-200`}
              loading="lazy"
              onLoad={() => setImageLoading(false)}
              onError={() => {
                setImageLoading(false);
                setImageError(true);
              }}
            />
          </>
        ) : (
          <div className="absolute inset-0 bg-accent flex items-center justify-center text-muted-foreground">
            <FontAwesomeIcon icon={faLayerGroup} className="h-12 w-12" />
          </div>
        )}

        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
          <div className="text-center text-white p-2">
            <FontAwesomeIcon icon={faLayerGroup} className="h-8 w-8 mx-auto mb-2" />
            <div className="text-xs">View Collection</div>
          </div>
        </div>

        {collection.child_count !== null && collection.child_count > 0 && (
          <div className="absolute top-2 left-2 bg-primary/80 text-primary-foreground text-xs px-2 py-1 rounded-full">
            {collection.child_count} item{collection.child_count === 1 ? '' : 's'}
          </div>
        )}

        {collection.smart && (
          <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full">
            Smart
          </div>
        )}
      </div>

      <div className="mt-2 text-center">
        <h4 className="font-medium text-sm line-clamp-2 group-hover:text-primary transition-colors" title={collection.title}>
          {collection.title}
        </h4>
        {collection.added_at && (
          <p className="text-xs text-muted-foreground mt-1">
            Added {formatTimestamp(collection.added_at, 'date')}
          </p>
        )}
      </div>
    </div>
  );
};

export const LibraryDetailPage = () => {
  const { libraryId } = useParams({ from: '/admin/servers/$serverId/libraries/$libraryId' });
  const { user, isAdministrator } = useAuth();
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  if (!user || !isAdministrator || !auth.accessToken) return null;
  return <LibraryDetailPageView key={JSON.stringify([user.uuid, auth.accessToken, libraryId])} />;
};

const LibraryDetailPageView = () => {
  const { formatTimestamp, timeZone } = useAccountDisplay();
  // Use TanStack Router APIs for params and search
  const { serverId, libraryId } = useParams({ from: '/admin/servers/$serverId/libraries/$libraryId' });
  const search = useSearch({ strict: false }) as { tab?: TabType };
  const activeTab: TabType = search.tab ?? 'overview';
  
  const navigate = useNavigate({ from: '/admin/servers/$serverId/libraries/$libraryId' });
  const { success, error: showError, info } = useAlerts();

  const [library, setLibrary] = useState<Library | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [libraryStats, setLibraryStats] = useState<LibraryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  
  // Early return if libraryId is not available
  if (!libraryId) {
    return (
      <div className="p-6">
        <p className="text-destructive">Library ID not found in route parameters.</p>
      </div>
    );
  }

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [pageSize, setPageSize] = useState(24);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('title_asc');
  const [syncing, setSyncing] = useState(false);
  const [purging, setPurging] = useState(false);
  const [pollMs, setPollMs] = useState(2000);
  const { status: libSyncStatus, refetch: refetchLibSync } = useLibrarySyncStatus(libraryId, pollMs);
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionSearch, setCollectionSearch] = useState('');
  const [statsData, setStatsData] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsDays, setStatsDays] = useState(30);
  // The Stats tab's tiles: the period in words and times like "3 days 4 hrs".
  const statsPeriod = statsDays === 365 ? 'Last year' : `Last ${statsDays} days`;
  const statsDuration = (seconds?: number | null) => {
    const value = Math.max(0, Math.round(seconds ?? 0));
    if (value < 60) return value === 0 ? '0 mins' : '1 min';
    // Zero parts are dropped: "1 hr", not "1 hr 0 mins".
    const parts = watchTime(String(value)).filter(([n]) => Number(n) !== 0);
    return parts.length ? parts.map(([n, unit]) => `${n} ${unit}`).join(' ') : '0 mins';
  };
  const [activityData, setActivityData] = useState<any[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityDays, setActivityDays] = useState(30);
  const [activityPage, setActivityPage] = useState(1);
  const [activityTotalPages, setActivityTotalPages] = useState(1);
  const [needsInspection, setNeedsInspection] = useState(false);
  const queries = {
    library: String(libraryId),
    media: JSON.stringify([libraryId, activeTab, currentPage, pageSize, sortBy, searchQuery]),
    collections: JSON.stringify([libraryId, activeTab]),
    stats: JSON.stringify([libraryId, activeTab, statsDays, timeZone]),
    activity: JSON.stringify([libraryId, activeTab, activityDays, activityPage]),
  };
  const view = useCatalogueView(queries);


  useEffect(() => {
    loadLibraryData();
  }, [libraryId]);

  // no timer fallback

  useEffect(() => {
    if (activeTab === 'media') {
      loadMediaItems();
    } else if (activeTab === 'collections' && library?.catalogue?.collections_supported === true) {
      loadCollections();
    } else if (activeTab === 'stats') {
      loadStats();
    } else if (activeTab === 'activity') {
      loadActivity();
    }
  }, [libraryId, activeTab, currentPage, pageSize, sortBy, searchQuery, statsDays, timeZone, activityDays, activityPage, library?.server?.service_type, library?.catalogue?.collections_supported]);

  // A TV library syncs shows and their episodes; a music library its albums
  // and their tracks. These are the words each uses.
  const libraryKind = (library?.library_type || '').toLowerCase();
  const isMusicLibrary = libraryKind === 'artist' || libraryKind.includes('music');
  const words = isMusicLibrary
    ? { parent: 'album', parents: 'albums', Parents: 'Albums', entry: 'album', Child: 'Track', children: 'tracks', Children: 'Tracks', kind: 'music', supported: library?.catalogue?.tracks_supported === true }
    : { parent: 'show', parents: 'shows', Parents: 'TV Shows', entry: 'TV show', Child: 'Episode', children: 'episodes', Children: 'Episodes', kind: 'TV show', supported: library?.catalogue?.episodes_supported === true };

  // A "TV Shows + Episodes" (or "Albums + Tracks") run continues after its request: this page waits
  // for its outcome (a new last_episode_run), then reports it and reloads.
  const episodeRunWatch = useRef<{ previous: string | null } | null>(null);
  useEffect(() => {
    const watch = episodeRunWatch.current;
    const run = libSyncStatus?.last_episode_run;
    if (!watch || libSyncStatus?.is_syncing || !run || run.finished_at === watch.previous) return;
    episodeRunWatch.current = null;
    const changes = run.added + run.updated + run.removed > 0
      ? `${run.added} added, ${run.updated} updated, ${run.removed} removed`
      : 'no changes needed';
    const shows = `${run.shows_synced} of ${run.shows_total} ${run.shows_total === 1 ? words.parent : words.parents}`;
    const stopped: Record<string, string> = {
      library_changed: 'the server or library changed',
      forbidden: 'your session ended',
      shutdown: 'MUM is shutting down',
      timeout: 'it reached its time limit',
    };
    if (run.stopped) {
      showError(`${words.Child} sync stopped because ${stopped[run.stopped] ?? 'it could not continue'}. ${words.Children} saved for ${shows} (${changes}).`);
    } else if (run.shows_failed > 0) {
      showError(`${words.Children} saved for ${shows} (${changes}). ${run.shows_failed} could not be read and kept their previous ${words.children}.`);
    } else if (run.added + run.updated + run.removed > 0) {
      success(`${words.Children} synced for ${shows}: ${changes}`);
    } else {
      info(`${words.Children} synced for ${shows}: ${changes}`);
    }
    void refreshSavedState();
  }, [libSyncStatus?.is_syncing, libSyncStatus?.last_episode_run]);

  // Adapt polling interval for snappy updates during active sync
  useEffect(() => {
    const fast = (syncing || Boolean((libSyncStatus as any)?.is_syncing)) ? 250 : 2000;
    setPollMs((prev) => (prev === fast ? prev : fast));
  }, [syncing, libSyncStatus?.is_syncing]);

  const loadCollections = async () => {
    if (library?.catalogue?.collections_supported !== true) return;

    if (!view.current()) return false;
    const read = view.begin('collections', queries.collections);
    if (!read.current()) return false;
    try {
      setCollectionsLoading(true);
      const response = await requestJson<CollectionsApi>(`/api/libraries/${libraryId}/collections`, { signal: read.signal, retryAuthentication: false });
      if (!read.current()) return false;
      const saved = readCollections(response.data?.collections);
      if (!saved) throw new Error('Unexpected collections response');
      setCollections(saved);
      return true;
    } catch (err) {
      if (!read.current()) return false;
      // Keep this view's saved list rather than implying the library has none.
      console.error('Failed to load collections:', err);
      return false;
    } finally {
      read.finish();
      if (read.current()) setCollectionsLoading(false);
    }
  };

  const loadStats = async () => {
    if (!libraryId) return;

    if (!view.current()) return false;
    const read = view.begin('stats', queries.stats);
    if (!read.current()) return false;
    try {
      setStatsLoading(true);
      // Days are counted in the account's timezone; the read waits until it is known.
      if (!timeZone) return false;
      const response = await requestJson<StatsApi>(`/api/libraries/${libraryId}/stats?days=${statsDays}&tz=${encodeURIComponent(timeZone)}`, { signal: read.signal, retryAuthentication: false });
      if (!read.current()) return false;
      setStatsData(response.data);
      return true;
    } catch (err) {
      if (!read.current()) return false;
      console.error('Failed to load stats:', err);
      setStatsData(null);
      return false;
    } finally {
      read.finish();
      if (read.current()) setStatsLoading(false);
    }
  };

  const loadActivity = async () => {
    if (!libraryId) return;

    if (!view.current()) return false;
    const read = view.begin('activity', queries.activity);
    if (!read.current()) return false;
    try {
      setActivityLoading(true);
      const response = await requestJson<ActivityApi>(`/api/libraries/${libraryId}/activity?days=${activityDays}&page=${activityPage}&page_size=20`, { signal: read.signal, retryAuthentication: false });
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

  const refreshSavedState = async () => {
    if (!view.current()) return;
    const inspection = view.inspectionRevision();
    const detail = await loadLibraryData();
    if (!view.current()) return;
    const items = await loadMediaItems();
    if (!view.current()) return;
    if (activeTab === 'collections' && library?.catalogue?.collections_supported === true) await loadCollections();
    if (!view.current()) return;
    if (detail && items && view.inspected(inspection)) setNeedsInspection(false);
  };

  const handleSyncLibrary = async (syncEpisodes: boolean | null = null) => {
    if (!libraryId) return;

    // Check if this is a TV library (covers Plex 'show/tv' and Jellyfin 'series')
    const libType = (library?.library_type || '').toLowerCase();
    const isTvLibrary = libType.includes('show') || libType.includes('tv') || libType.includes('series');

    // A TV or music library asks whether to include episodes or tracks
    if ((isTvLibrary || isMusicLibrary) && syncEpisodes === null) {
      setShowSyncDialog(true);
      return;
    }

    const catalogue = library?.catalogue;
    if (!catalogue?.supported || (syncEpisodes && !words.supported)) {
      showError(catalogue?.supported ? `${words.Child} catalogues are not available for this server.` : 'Item catalogues are not available for this library.');
      setShowSyncDialog(false);
      return;
    }

    const mutation = view.beginMutation();
    if (!mutation) return;
    try {
      setSyncing(true);
      setShowSyncDialog(false);
      // Immediately fetch server status to avoid initial lag
      refetchLibSync();
      // Backend publishes real progress; no local timer
      // Sync library content (all media items within this library)
      const previousEpisodeRun = libSyncStatus?.last_episode_run?.finished_at ?? null;
      const outcome = await syncLibraryCatalogue(Number(libraryId), catalogue.revision, { episodes: syncEpisodes === true });
      if (!mutation.current()) return;
      view.requireInspection();
      setNeedsInspection(true);
      if (outcome.kind !== 'committed') {
        showError(outcome.message);
        await refreshSavedState();
        return;
      }

      // Show success toast with sync results
      {
        const result = outcome.receipt;
        const added = result.added;
        const updated = result.updated;
        const removed = result.removed;

        // For TV show libraries this receipt counts shows; episodes are
        // reported when their background run finishes (episodeRunWatch).
        const isTvLibrary = (library?.library_type || '').toLowerCase().includes('show')
          || (library?.library_type || '').toLowerCase().includes('tv')
          || (library?.library_type || '').toLowerCase().includes('series')
          || isMusicLibrary;

        if (added > 0 || updated > 0 || removed > 0) {
          let message = `${added} added, ${updated} updated`;

          // Only show removed count for non-TV libraries
          // TV libraries count shows here; episodes are reported separately
          if (!isTvLibrary && removed > 0) {
            message += `, ${removed} removed`;
          } else if (isTvLibrary && removed > 0) {
            message += ` (${removed} ${words.parents} no longer available)`;
          }

          success(message);
        } else {
          info(result.message || 'No changes detected');
        }

        // The shows are saved; their episodes now synchronize show by show.
        if (result.episodes?.started) {
          episodeRunWatch.current = { previous: previousEpisodeRun };
          refetchLibSync();
          info(`Syncing ${words.children} for ${result.episodes.shows} ${result.episodes.shows === 1 ? words.parent : words.parents}…`);
        } else if (result.episodes) {
          showError(`The ${words.parents} were saved, but their ${words.children} could not start syncing. Try again.`);
        }

        // Reload library data after sync
        await refreshSavedState();
      }
    } catch (err) {
      if (!mutation.current()) return;
      console.error('Failed to sync library content:', err);
      showError(err instanceof Error ? err.message : 'Failed to sync library content');
    } finally {
      if (mutation.current()) setSyncing(false);
      mutation.finish();
    }
  };

  const handleSyncClick = () => {
    const type = (library?.library_type || '').toLowerCase();
    const isTvLibrary = type.includes('show') || type.includes('tv') || type.includes('series');
    if (isTvLibrary || isMusicLibrary) {
      setShowSyncDialog(true);
      return;
    }
    void handleSyncLibrary(false);
  };

  const handlePurgeLibrary = async () => {
    if (!libraryId) return;

    // Show confirmation dialog
    if (!window.confirm('Are you sure you want to purge all cached items for this library from the database? This will delete all stored media items and they will need to be re-synced.')) {
      return;
    }

    const catalogue = library?.catalogue;
    if (!catalogue?.supported) return;

    const mutation = view.beginMutation();
    if (!mutation) return;
    try {
      setPurging(true);
      const outcome = await purgeLibraryCatalogue(Number(libraryId), catalogue.revision);
      if (!mutation.current()) return;
      view.requireInspection();
      setNeedsInspection(true);
      if (outcome.kind !== 'committed') {
        showError(outcome.message);
        await refreshSavedState();
        return;
      }

      {
        const deletedCount = outcome.receipt.deleted;
        success(`Purged ${deletedCount} item${deletedCount === 1 ? '' : 's'} from library`);

        // Reload library data after purge
        await refreshSavedState();
      }
    } catch (err) {
      if (!mutation.current()) return;
      console.error('Failed to purge library:', err);
      showError(err instanceof Error ? err.message : 'Failed to purge library');
    } finally {
      if (mutation.current()) setPurging(false);
      mutation.finish();
    }
  };

  const loadLibraryData = async () => {
    if (!libraryId) return;

    if (!view.current()) return false;
    const read = view.begin('library', queries.library);
    if (!read.current()) return false;
    try {
      setLoading(true);
      const response = await requestJson<LibraryApi>(`/api/libraries/${libraryId}?include_server=true`, { signal: read.signal, retryAuthentication: false });
      if (!read.current()) return false;

      if (response.data?.id !== Number(libraryId)) throw new Error('Library detail does not match this route');
      // The library's own server decides its address; a different server in
      // the address is replaced with the right one.
      if (typeof response.data.server_id === 'number' && response.data.server_id !== Number(serverId)) {
        navigate({ to: '/admin/servers/$serverId/libraries/$libraryId', params: { serverId: String(response.data.server_id), libraryId }, search: (prev: { tab?: TabType }) => prev, replace: true });
        return false;
      }
      if (response.data) {
        setLibrary(response.data);
        setError(null);
        setLibraryStats({ library_type: response.data.library_type || 'Mixed' });
      }
      return true;
    } catch (err) {
      if (!read.current()) return false;
      if (!library) setError(err instanceof Error ? err.message : 'Failed to load library');
      return false;
    } finally {
      read.finish();
      if (read.current()) setLoading(false);
    }
  };

  const loadMediaItems = async () => {
    if (!libraryId) return;

    if (!view.current()) return false;
    const read = view.begin('media', queries.media);
    if (!read.current()) return false;
    try {
      setMediaLoading(true);
      const response = await requestJson<MediaListApi>(
        `/api/libraries/${libraryId}/media?page=${currentPage}&page_size=${pageSize}&sort_by=${sortBy}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}`,
        { signal: read.signal, retryAuthentication: false });
      if (!read.current()) return false;

      if (!Array.isArray(response.data) || !response.meta?.pagination) throw new Error('Invalid library item list');
      if (response.data && response.meta) {
        setMediaItems(response.data);
        setTotalPages(response.meta.pagination?.total_pages || 1);
        setTotalItems(response.meta.pagination?.total_items || 0);
      }
      return true;
    } catch (err) {
      if (!read.current()) return false;
      console.error('Failed to load media items:', err);
      return false;
    } finally {
      read.finish();
      if (read.current()) setMediaLoading(false);
    }
  };

  const setTab = (tab: TabType) => {
    navigate({
      search: (prev: { tab?: TabType }) => ({ ...prev, tab }),
      replace: true,
    });
  };

  const getServiceBadge = (serviceType?: ServiceType) => {
    if (!serviceType) return null;

    const palette = getServicePalette(serviceType);
    const meta = getServiceMeta(serviceType);

    // Create small icon (w-3 h-3) based on the service's icon
    const smallIcon = serviceType === 'plex' ? (
      <svg className="w-3 h-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" strokeLinejoin="round" strokeWidth="12">
        <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/>
      </svg>
    ) : (
      <span className="w-3 h-3 flex items-center justify-center text-xs">{meta.icon}</span>
    );

    return (
      <span className={`inline-flex items-center rounded-md ${palette.bg} ${palette.bgDark} px-2 py-1 text-xs font-medium ${palette.text} ${palette.textDark} ring-1 ring-inset ${palette.ring} ${palette.ringDark} gap-1`}>
        {smallIcon}
        {meta.label}
      </span>
    );
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setCurrentPage(1);
    loadMediaItems();
  };

  if (loading) {
    return (
      <div className="container mx-auto space-y-6">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !library) {
    return (
      <div className="container mx-auto space-y-6">
        <div className="space-y-4">
          <h1 className="text-3xl font-bold">Library Not Found</h1>
          <p className="text-muted-foreground">The requested library could not be loaded</p>
        </div>
        <Card className="border-destructive">
          <CardContent className="p-6 flex items-center gap-3">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive" />
            <span className="text-destructive">{error || 'Library not found'}</span>
          </CardContent>
        </Card>
        <Link to="/admin/servers">
          <Button>
            <FontAwesomeIcon icon={faArrowLeft} className="mr-2 h-4 w-4" />
            Back to Servers
          </Button>
        </Link>
      </div>
    );
  }

  const serviceType = library.server?.service_type;

  // Compute sync display state
  const backendSyncing = Boolean(libSyncStatus?.is_syncing);
  const effectiveIsSyncing = syncing || backendSyncing;
  let pagesDone = 0;
  let pagesTotal = 0;
  let itemsTotal = 0;
  let itemsFetched = 0;
  const phase = (libSyncStatus?.progress as any)?.phase as 'shows' | 'episodes' | undefined;
  const showsCurrent = (libSyncStatus?.progress as any)?.shows_current || 0;
  const showsTotal = (libSyncStatus?.progress as any)?.shows_total || 0;
  let progressValue = 0;

  if (backendSyncing) {
    pagesDone = libSyncStatus?.progress?.current_page || 0;
    pagesTotal = libSyncStatus?.progress?.total_pages || 0;
    itemsTotal = libSyncStatus?.progress?.total_items || 0;
    itemsFetched = libSyncStatus?.progress?.total_fetched || 0;
    if (phase === 'episodes') {
      // Use shows progress during episodes phase
      if (showsTotal > 0) {
        progressValue = (showsCurrent / showsTotal) * 100;
      }
    } else {
      if (pagesTotal > 0) {
        progressValue = (pagesDone / pagesTotal) * 100;
      } else if (itemsTotal > 0) {
        progressValue = (itemsFetched / itemsTotal) * 100;
      }
    }
  } else if (syncing) {
    // A new sync just started locally but backend hasn't published yet
    pagesDone = 0;
    pagesTotal = 0;
    itemsTotal = 0;
    itemsFetched = 0;
    progressValue = 0;
  }
  progressValue = Math.min(100, Math.max(0, progressValue));

  // The tab headings' summary lines.
  const query = searchQuery.trim();
  const range = totalItems > pageSize ? ` · showing ${((currentPage - 1) * pageSize + 1).toLocaleString()}–${Math.min(currentPage * pageSize, totalItems).toLocaleString()}` : '';
  const mediaSummary = mediaLoading && totalItems === 0 ? `Titles in ${library.name}`
    : query ? `${totalItems.toLocaleString()} ${totalItems === 1 ? 'match' : 'matches'} for “${query}”${range}`
    : `${totalItems.toLocaleString()} ${totalItems === 1 ? 'title' : 'titles'}${range}`;
  const collectionQuery = collectionSearch.trim().toLowerCase();
  const shownCollections = collectionQuery ? collections.filter(c => c.title.toLowerCase().includes(collectionQuery)) : collections;
  const collectionsSummary = `${collections.length.toLocaleString()} ${collections.length === 1 ? 'collection' : 'collections'} in ${library.name}`
    + (collectionQuery ? ` · ${shownCollections.length.toLocaleString()} shown` : '');

  

  return (
    <div className="container mx-auto space-y-6">
      {/* Header Section */}
      <Card className="bg-gradient-to-r from-primary/10 to-secondary/10">
        <CardContent className="p-8">
          <div className="flex flex-col items-center space-y-4">
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-center break-words">
              {library.name}
            </h1>
            <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
              {getServiceBadge(serviceType)}

              <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border gap-1">
                <FontAwesomeIcon icon={faServer} className="w-3 h-3" />
                {library.server?.server_nickname}
              </span>

              <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1">
                <FontAwesomeIcon icon={faTag} className="w-3 h-3" />
                {libraryStats?.library_type || 'Mixed'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabType)}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">
            <FontAwesomeIcon icon={faCircleInfo} className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="media">
            <FontAwesomeIcon icon={faFilm} className="mr-2 h-4 w-4" />
            Media
          </TabsTrigger>
          {serviceType === 'plex' && (
            <TabsTrigger value="collections">
              <FontAwesomeIcon icon={faLayerGroup} className="mr-2 h-4 w-4" />
              Collections
            </TabsTrigger>
          )}
          <TabsTrigger value="stats">
            <FontAwesomeIcon icon={faChartBar} className="mr-2 h-4 w-4" />
            Stats
          </TabsTrigger>
          <TabsTrigger value="activity">
            <FontAwesomeIcon icon={faClockRotateLeft} className="mr-2 h-4 w-4" />
            Recent Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-3">
          <LibraryOverview serverId={Number(library.server_id ?? serverId)} serviceLabel={getServiceMeta(serviceType).label} library={library} />
        </TabsContent>

        <TabsContent value="media" className="space-y-4 mt-3">
          {/* The heading, toolbar and sync progress share one panel above the posters. */}
          <div className="space-y-4 rounded-lg border border-border/70 bg-muted/40 p-4">
            {/* Heading and actions: the same layout as the server's Libraries and Users tabs. */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <TabHeading icon={libraryTypeIcon(library.library_type ?? null)} title="Media" description={mediaSummary} />
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleSyncClick} disabled={syncing || purging || needsInspection || !library?.catalogue?.supported}>
                  <FontAwesomeIcon icon={faRotate} className={syncing ? 'animate-spin' : undefined} />
                  {syncing ? 'Syncing…' : 'Sync library'}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label="More library actions"><FontAwesomeIcon icon={faEllipsis} /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onClick={handlePurgeLibrary} disabled={purging || syncing || needsInspection || !library?.catalogue?.supported}>
                      <FontAwesomeIcon icon={faTrash} />
                      {purging ? 'Purging…' : 'Purge DB'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Shown only when the last sync or purge couldn't be confirmed and the page's own
                re-read didn't clear it: Sync stays locked until the saved state is read again. */}
            {needsInspection && (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span>Inspect saved state before another action.</span>
                <Button onClick={refreshSavedState} disabled={syncing || purging} variant="outline" size="sm">Refresh saved state</Button>
              </div>
            )}

            {/* One toolbar: search, then sort and page size; on a phone the search takes the whole row. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <form onSubmit={handleSearch} className="relative w-full sm:max-w-md">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search this library"
                  aria-label="Search this library"
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                />
              </form>
              <div className="flex gap-2">
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="w-[180px]" aria-label="Sort"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="title_asc">Title (A-Z)</SelectItem>
                    <SelectItem value="title_desc">Title (Z-A)</SelectItem>
                    <SelectItem value="year_desc">Year (Newest)</SelectItem>
                    <SelectItem value="year_asc">Year (Oldest)</SelectItem>
                    <SelectItem value="total_streams_desc">Streams (Most)</SelectItem>
                    <SelectItem value="total_streams_asc">Streams (Least)</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={pageSize.toString()} onValueChange={(val) => { setPageSize(Number(val)); setCurrentPage(1); }}>
                  <SelectTrigger className="w-32" aria-label="Titles per page"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[12, 24, 48, 96].map(size => <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Sync progress, only while a sync runs. */}
            {effectiveIsSyncing && (
              <div className="space-y-2" role="status">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Spinner className="h-4 w-4 text-primary" />
                    {(backendSyncing && libSyncStatus?.progress?.message) || (
                      phase === 'episodes'
                        ? <>Syncing {words.children} across {words.parents}…</>
                        : <>Syncing library content from {library?.server?.server_nickname || 'server'}…</>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {phase === 'episodes' && showsTotal > 0 ? <>{showsCurrent} / {showsTotal} {words.parents}</>
                      : pagesTotal > 0 ? <>Page {pagesDone} / {pagesTotal}</>
                      : <>{Math.round(progressValue)}%</>}
                  </span>
                </div>
                <Progress value={progressValue} className="h-2" />
              </div>
            )}
          </div>

          {/* Media Grid */}
          {mediaLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
              {Array.from({ length: pageSize }).map((_, idx) => (
                <div key={idx} className="space-y-2">
                  <Skeleton className="aspect-[2/3] w-full rounded-lg" />
                  <Skeleton className="h-4 w-3/4 mx-auto" />
                  <Skeleton className="h-3 w-1/2 mx-auto" />
                </div>
              ))}
            </div>
          ) : mediaItems.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
              {mediaItems.filter(item => item.id != null).map((item) => (
                <MediaPosterCard
                  key={item.id}
                  item={item}
                  serverId={serverId}
                  libraryId={libraryId!}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                  <FontAwesomeIcon icon={faFolderOpen} className="text-2xl text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-2">No Media Found</h3>
                <p className="text-muted-foreground">This library appears to be empty or no results match your search.</p>
              </CardContent>
            </Card>
          )}

          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} loading={mediaLoading} />
        </TabsContent>

        <TabsContent value="collections" className="space-y-4 mt-3">
          {library?.catalogue?.collections_supported !== true ? (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                  <FontAwesomeIcon icon={faLayerGroup} className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-2">Collections Not Available</h3>
                <p className="text-muted-foreground">Collection browsing is not implemented for this library.</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* The heading and search share one panel above the collections. */}
              <div className="space-y-4 rounded-lg border border-border/70 bg-muted/40 p-4">
                <TabHeading icon={faLayerGroup} title="Collections" description={collectionsLoading ? `Collections in ${library.name}` : collectionsSummary} />
                {collections.length > 0 && (
                  <div className="relative w-full sm:max-w-md">
                    <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={collectionSearch} onChange={e => setCollectionSearch(e.target.value)} placeholder="Search collections" aria-label="Search collections" className="pl-9" maxLength={200} />
                  </div>
                )}
              </div>

              {collectionsLoading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                  {Array.from({ length: 24 }).map((_, idx) => (
                    <div key={idx} className="space-y-2">
                      <Skeleton className="aspect-[2/3] w-full rounded-lg" />
                      <Skeleton className="h-4 w-3/4 mx-auto" />
                      <Skeleton className="h-3 w-1/2 mx-auto" />
                    </div>
                  ))}
                </div>
              ) : shownCollections.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                  {shownCollections.map((collection) => (
                    <CollectionCard key={collection.id} collection={collection} />
                  ))}
                </div>
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                      <FontAwesomeIcon icon={faLayerGroup} className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-medium mb-2">No Collections Found</h3>
                    <p className="text-muted-foreground">{collections.length > 0 ? 'No collections match this search.' : "This library doesn't have any collections yet."}</p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="stats" className="space-y-6">
          {/* Time Range Selector */}
          <div className="flex justify-end">
            <Select value={statsDays.toString()} onValueChange={(val) => setStatsDays(Number(val))}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 Days</SelectItem>
                <SelectItem value="30">Last 30 Days</SelectItem>
                <SelectItem value="90">Last 90 Days</SelectItem>
                <SelectItem value="365">Last Year</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {statsLoading ? (
            <div className="dashboard-overview-grid">
              {Array.from({ length: 4 }).map((_, idx) => (
                <div key={idx} className="dashboard-health-tile dashboard-overview-tile">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="dashboard-health-body">
                    <Skeleton className="h-4 w-24 mb-2" />
                    <Skeleton className="h-8 w-16" />
                  </div>
                </div>
              ))}
            </div>
          ) : statsData ? (
            <>
              {/* Summary for the chosen period, in the Overview tiles' style */}
              <div className="dashboard-overview-grid">
                <Tile icon={faPlay} label="Plays" value={(statsData.stats.total_streams || 0).toLocaleString()} note={statsPeriod} />
                <Tile icon={faUsers} label="Viewers" value={(statsData.stats.unique_users || 0).toLocaleString()} note="People who played something" />
                <Tile icon={faClock} label="Watch time" value={statsDuration(statsData.stats.total_duration)} note="Recorded by MUM" />
                <Tile icon={faChartBar} label="Average play" value={statsDuration(statsData.stats.average_session_length)} note="Per play" />
              </div>

              {/* Activity Chart */}
              {statsData.chart_data && statsData.chart_data.length > 0 && (() => {
                const chartData = statsData.chart_data.map((day: any) => ({
                  label: day.label,
                  plays: Number(day.plays || 0),
                  time: Number(day.time || 0),
                }));

                return (
                  <Card className="pt-0 gap-0 overflow-hidden border border-border/60 shadow-md">
                    <CardHeader className="pt-6 border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent pb-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-start gap-3">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-inner">
                            <FontAwesomeIcon icon={faChartBar} className="text-lg" />
                          </div>
                          <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-2xl text-foreground">
                              Watch Time Activity
                            </CardTitle>
                            <CardDescription className="text-sm text-muted-foreground space-y-1">
                              <p>Playback trends for this library across the selected time range.</p>
                            </CardDescription>
                          </div>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="px-3 pt-5 pb-6 sm:px-4">
                      <div className="relative h-[320px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={chartData} margin={{ top: 8, right: 6, left: 4, bottom: 0 }}>
                            <defs>
                              <linearGradient id="library-stats-plays-area" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.55} />
                                <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.06} />
                              </linearGradient>
                              <linearGradient id="library-stats-time-area" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.45} />
                                <stop offset="95%" stopColor="#22c55e" stopOpacity={0.04} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" opacity={0.35} />
                            <XAxis
                              dataKey="label"
                              tickFormatter={formatLibraryStatsChartDateShort}
                              tickLine={false}
                              axisLine={false}
                              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                              minTickGap={12}
                            />
                            <YAxis
                              yAxisId="plays"
                              orientation="left"
                              allowDecimals={false}
                              tickLine={false}
                              axisLine={false}
                              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                              label={{
                                value: 'Total Plays',
                                angle: -90,
                                position: 'insideLeft',
                                fill: 'var(--muted-foreground)',
                                style: { fontSize: 11 },
                              }}
                            />
                            <YAxis
                              yAxisId="time"
                              orientation="right"
                              tickLine={false}
                              axisLine={false}
                              tickFormatter={(value) => formatMinutesCompact(Number(value))}
                              tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                              label={{
                                value: 'Watch Time',
                                angle: 90,
                                position: 'insideRight',
                                fill: 'var(--muted-foreground)',
                                style: { fontSize: 11 },
                              }}
                            />
                            <Tooltip
                              content={renderLibraryStatsAreaTooltip}
                              cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
                            />
                            <Area
                              yAxisId="plays"
                              dataKey="plays"
                              name="Total Plays"
                              type="monotone"
                              stroke="var(--primary)"
                              strokeWidth={2}
                              fill="url(#library-stats-plays-area)"
                              dot={false}
                              activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
                            />
                            <Area
                              yAxisId="time"
                              dataKey="time"
                              name="Watch Time"
                              type="monotone"
                              stroke="#22c55e"
                              strokeWidth={2}
                              fill="url(#library-stats-time-area)"
                              dot={false}
                              activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>

                      {/* Custom Legend */}
                      <div className="flex flex-wrap gap-4 mt-4 justify-center">
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 rounded bg-primary"></div>
                          <span className="text-sm text-muted-foreground">Total Plays</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 rounded bg-emerald-500"></div>
                          <span className="text-sm text-muted-foreground">Watch Time</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })()}

              {/* Trending Content */}
              {statsData.stats.trending_content && statsData.stats.trending_content.length > 0 && (
                <Card>
                  <CardContent className="p-6">
                    <h3 className="text-lg font-semibold mb-4 flex items-center">
                      <FontAwesomeIcon icon={faStar} className="mr-2 h-5 w-5" />
                      Most Popular Content
                    </h3>
                    <div className="space-y-3">
                      {statsData.stats.trending_content.slice(0, 10).map((item: any, idx: number) => (
                        <div key={idx} className="flex justify-between items-center">
                          <span className="font-medium truncate mr-2">{item.title}</span>
                          <span className="text-sm bg-primary/20 text-primary px-2 py-1 rounded-full whitespace-nowrap">
                            {item.streams} plays
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                  <FontAwesomeIcon icon={faChartBar} className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-2">No Statistics Available</h3>
                <p className="text-muted-foreground">
                  No streaming activity found for this library in the selected time period.
                </p>
              </CardContent>
            </Card>
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
            emptyMessage="No streaming activity found for this library in the selected time period."
          />
        </TabsContent>
      </Tabs>

      {/* TV Library Sync Options Dialog */}
      <ResponsiveDialog
        open={showSyncDialog}
        onOpenChange={setShowSyncDialog}
        title={isMusicLibrary ? 'Sync Music Library' : 'Sync TV Library'}
        description={`Choose what you want to sync for this ${words.kind} library`}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setShowSyncDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleSyncLibrary(false)}
            >
              {words.Parents} Only
            </Button>
            <Button
              onClick={() => handleSyncLibrary(true)}
              disabled={!words.supported}
              title={!words.supported ? `${words.Child} catalogues are not available for this server` : undefined}
            >
              {words.Parents} + {words.Children}
            </Button>
          </>
        }
      >
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <h4 className="font-medium flex items-center gap-2">
              <FontAwesomeIcon icon={isMusicLibrary ? faCompactDisc : faFilm} className="h-4 w-4" />
              {words.Parents} Only
            </h4>
            <p className="text-sm text-muted-foreground">
              Syncs only the {words.entry} entries. {words.Children} will not be synced. Use this for a quick library update.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium flex items-center gap-2">
              <FontAwesomeIcon icon={isMusicLibrary ? faMusic : faLayerGroup} className="h-4 w-4" />
              {words.Parents} + {words.Children}
            </h4>
            <p className="text-sm text-muted-foreground">
              Syncs {words.Parents === 'TV Shows' ? 'TV shows' : words.parents} and all their {words.children}. This will take significantly longer but ensures all {words.children} are up to date.
            </p>
          </div>
        </div>
      </ResponsiveDialog>
    </div>
  );
};

export default LibraryDetailPage;
