import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { requestJson } from '../util/apiClient';
import { useToast } from '../util/toast';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Pagination } from '../components/common/Pagination';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ChartOptions,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);
import { IconArrowLeft, IconRefresh, IconSearch, IconInfoCircle, IconStar, IconMovie, IconStack2, IconChartBar, IconHistory, IconServer, IconTag, IconEye, IconTrash, IconUsers, IconClock } from '@tabler/icons-react';

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
}

interface MediaItem {
  id: number;
  external_id: string;
  title: string;
  sort_title?: string;
  item_type?: string;
  year?: number;
  rating?: number;
  thumb?: string;
  added_at?: string;
  stream_count?: number;
}

interface PopularContent {
  media_title: string;
  play_count: number;
}

interface LibraryStats {
  library_type: string;
  popular_content: PopularContent[];
}

type TabType = 'overview' | 'media' | 'collections' | 'stats' | 'activity';

// Component for individual media poster with loading state
const MediaPosterCard = ({ item, libraryId }: { item: MediaItem; libraryId: string }) => {
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  return (
    <Link to={`/admin/libraries/${libraryId}/${item.id}`} className="group cursor-pointer">
      <div className="relative aspect-[2/3] bg-accent rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 group-hover:scale-105">
        {item.thumb && !imageError ? (
          <>
            {imageLoading && (
              <Skeleton className="absolute inset-0 rounded-lg" />
            )}
            <img
              src={item.thumb}
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
            <IconMovie className="h-12 w-12" />
          </div>
        )}

        {item.rating && (
          <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1">
            <i className="fa-solid fa-star text-yellow-400"></i>
            {item.rating.toFixed(1)}
          </div>
        )}

        {item.stream_count && item.stream_count > 0 && (
          <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1">
            <IconEye className="h-3 w-3" />
            {item.stream_count}
          </div>
        )}

        {item.item_type && (
          <div className="absolute top-2 left-2 bg-primary/80 text-primary-foreground text-xs px-2 py-1 rounded-full capitalize">
            {item.item_type}
          </div>
        )}
      </div>

      <div className="mt-2 text-center">
        <h4 className="font-medium text-sm line-clamp-2 group-hover:text-primary transition-colors" title={item.title}>
          {item.title}
        </h4>
        {item.year && (
          <p className="text-xs text-muted-foreground mt-1">{item.year}</p>
        )}
      </div>
    </Link>
  );
};

// Component for individual collection card with loading state
const CollectionCard = ({ collection }: { collection: any }) => {
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
              src={`/admin/api/media/plex/images/proxy?path=${encodeURIComponent(collection.thumb.replace(/^\//, ''))}`}
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
            <IconStack2 className="h-12 w-12" />
          </div>
        )}

        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
          <div className="text-center text-white p-2">
            <IconStack2 className="h-8 w-8 mx-auto mb-2" />
            <div className="text-xs">View Collection</div>
          </div>
        </div>

        {collection.childCount && (
          <div className="absolute top-2 left-2 bg-primary/80 text-primary-foreground text-xs px-2 py-1 rounded-full">
            {collection.childCount} item{collection.childCount === 1 ? '' : 's'}
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
        {collection.addedAt && (
          <p className="text-xs text-muted-foreground mt-1">
            Added {new Date(collection.addedAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  );
};

export const LibraryDetailPage = () => {
  const { libraryId } = useParams<{ libraryId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showToast } = useToast();

  const [library, setLibrary] = useState<Library | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [libraryStats, setLibraryStats] = useState<LibraryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);

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
  const [collections, setCollections] = useState<any[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [statsData, setStatsData] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsDays, setStatsDays] = useState(30);
  const [activityData, setActivityData] = useState<any[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityDays, setActivityDays] = useState(30);
  const [activityPage, setActivityPage] = useState(1);
  const [activityTotalPages, setActivityTotalPages] = useState(1);

  const activeTab = (searchParams.get('tab') as TabType) || 'overview';

  useEffect(() => {
    loadLibraryData();
  }, [libraryId]);

  useEffect(() => {
    if (activeTab === 'media') {
      loadMediaItems();
    } else if (activeTab === 'collections' && library?.service_type === 'plex') {
      loadCollections();
    } else if (activeTab === 'stats') {
      loadStats();
    } else if (activeTab === 'activity') {
      loadActivity();
    }
  }, [activeTab, currentPage, pageSize, sortBy, searchQuery, statsDays, activityDays, activityPage]);

  const loadCollections = async () => {
    if (!library || library.server?.service_type !== 'plex') return;

    try {
      setCollectionsLoading(true);
      const response = await requestJson(`/admin/api/v1/libraries/${libraryId}/collections`);
      setCollections(response.data?.collections || []);
    } catch (err) {
      console.error('Failed to load collections:', err);
      setCollections([]);
    } finally {
      setCollectionsLoading(false);
    }
  };

  const loadStats = async () => {
    if (!libraryId) return;

    try {
      setStatsLoading(true);
      const response = await requestJson(`/admin/api/v1/libraries/${libraryId}/stats?days=${statsDays}`);
      setStatsData(response.data);
    } catch (err) {
      console.error('Failed to load stats:', err);
      setStatsData(null);
    } finally {
      setStatsLoading(false);
    }
  };

  const loadActivity = async () => {
    if (!libraryId) return;

    try {
      setActivityLoading(true);
      const response = await requestJson(`/admin/api/v1/libraries/${libraryId}/activity?days=${activityDays}&page=${activityPage}&page_size=20`);
      setActivityData(response.data || []);
      setActivityTotalPages(response.meta?.pagination?.total_pages || 1);
    } catch (err) {
      console.error('Failed to load activity:', err);
      setActivityData([]);
    } finally {
      setActivityLoading(false);
    }
  };

  const handleSyncLibrary = async () => {
    if (!libraryId) return;

    try {
      setSyncing(true);
      // Sync library content (all media items within this library)
      const response = await requestJson(`/admin/api/libraries/${libraryId}/sync`, {
        method: 'POST'
      });

      // Show success toast with sync results
      if (response.success) {
        const result = response.result;
        const added = result.added || 0;
        const updated = result.updated || 0;
        const removed = result.removed || 0;

        if (added > 0 || updated > 0 || removed > 0) {
          showToast({
            type: 'success',
            title: 'Library Sync Complete',
            description: `${added} added, ${updated} updated, ${removed} removed`
          });
        } else {
          showToast({
            type: 'info',
            title: response.message || 'No changes detected'
          });
        }

        // Reload library data after sync
        await loadLibraryData();
        if (activeTab === 'media') {
          await loadMediaItems();
        }
      }
    } catch (err) {
      console.error('Failed to sync library content:', err);
      showToast({
        type: 'error',
        title: 'Failed to sync library content',
        description: err instanceof Error ? err.message : undefined
      });
    } finally {
      setSyncing(false);
    }
  };

  const handlePurgeLibrary = async () => {
    if (!libraryId) return;

    // Show confirmation dialog
    if (!window.confirm('Are you sure you want to purge all cached items for this library from the database? This will delete all stored media items and they will need to be re-synced.')) {
      return;
    }

    try {
      setPurging(true);
      const response = await requestJson(`/admin/api/libraries/${libraryId}/purge`, {
        method: 'POST'
      });

      if (response.success) {
        const deletedCount = response.deleted_count || 0;
        showToast({
          type: 'success',
          title: 'Library Purged',
          description: `Purged ${deletedCount} item${deletedCount === 1 ? '' : 's'} from library`
        });

        // Reload library data after purge
        await loadLibraryData();
        if (activeTab === 'media') {
          await loadMediaItems();
        }
      }
    } catch (err) {
      console.error('Failed to purge library:', err);
      showToast({
        type: 'error',
        title: 'Failed to purge library',
        description: err instanceof Error ? err.message : undefined
      });
    } finally {
      setPurging(false);
    }
  };

  const loadLibraryData = async () => {
    if (!libraryId) return;

    try {
      setLoading(true);
      const response = await requestJson(`/admin/api/v1/libraries/${libraryId}?include_server=true`);

      if (response.data) {
        setLibrary(response.data);
        // Load mock stats (in real app, would come from API)
        setLibraryStats({
          library_type: response.data.library_type || 'Mixed',
          popular_content: []
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  };

  const loadMediaItems = async () => {
    if (!libraryId) return;

    try {
      setMediaLoading(true);
      const response = await requestJson(
        `/admin/api/v1/libraries/${libraryId}/media?page=${currentPage}&page_size=${pageSize}&sort_by=${sortBy}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}`
      );

      if (response.data && response.meta) {
        setMediaItems(response.data);
        setTotalPages(response.meta.pagination?.total_pages || 1);
        setTotalItems(response.meta.pagination?.total_items || 0);
      }
    } catch (err) {
      console.error('Failed to load media items:', err);
    } finally {
      setMediaLoading(false);
    }
  };

  const setTab = (tab: TabType) => {
    setSearchParams({ tab });
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
        icon: <i className="fa-solid fa-cube w-3 h-3"></i>,
        name: 'Jellyfin'
      },
      emby: {
        bg: 'bg-emby-50 dark:bg-emby-400/10',
        text: 'text-emby-700 dark:text-emby-400',
        ring: 'ring-emby-600/20 dark:ring-emby-500/20',
        icon: <i className="fa-solid fa-play-circle w-3 h-3"></i>,
        name: 'Emby'
      },
      kavita: {
        bg: 'bg-kavita-50 dark:bg-kavita-400/10',
        text: 'text-kavita-700 dark:text-kavita-400',
        ring: 'ring-kavita-600/20 dark:ring-kavita-500/20',
        icon: <i className="fa-solid fa-book w-3 h-3"></i>,
        name: 'Kavita'
      },
      audiobookshelf: {
        bg: 'bg-audiobookshelf-50 dark:bg-audiobookshelf-400/10',
        text: 'text-audiobookshelf-700 dark:text-audiobookshelf-400',
        ring: 'ring-audiobookshelf-600/20 dark:ring-audiobookshelf-500/20',
        icon: <i className="fa-solid fa-headphones w-3 h-3"></i>,
        name: 'AudiobookShelf'
      },
      komga: {
        bg: 'bg-komga-50 dark:bg-komga-400/10',
        text: 'text-komga-700 dark:text-komga-400',
        ring: 'ring-komga-600/20 dark:ring-komga-500/20',
        icon: <i className="fa-solid fa-book-open w-3 h-3"></i>,
        name: 'Komga'
      },
      romm: {
        bg: 'bg-romm-50 dark:bg-romm-400/10',
        text: 'text-romm-700 dark:text-romm-400',
        ring: 'ring-romm-600/20 dark:ring-romm-500/20',
        icon: <i className="fa-solid fa-gamepad w-3 h-3"></i>,
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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setCurrentPage(1);
    loadMediaItems();
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !library) {
    return (
      <div className="container mx-auto px-4 py-8 space-y-6">
        <div className="space-y-4">
          <h1 className="text-3xl font-bold">Library Not Found</h1>
          <p className="text-muted-foreground">The requested library could not be loaded</p>
        </div>
        <Card className="border-destructive">
          <CardContent className="p-6 flex items-center gap-3">
            <i className="fa-solid fa-exclamation-triangle text-destructive"></i>
            <span className="text-destructive">{error || 'Library not found'}</span>
          </CardContent>
        </Card>
        <Link to="/admin/libraries">
          <Button>
            <IconArrowLeft className="mr-2 h-4 w-4" />
            Back to Libraries
          </Button>
        </Link>
      </div>
    );
  }

  const serviceType = library.server?.service_type;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
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
                <IconServer className="w-3 h-3" />
                {library.server?.server_nickname}
              </span>

              <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1">
                <IconTag className="w-3 h-3" />
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
            <IconInfoCircle className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="media">
            <IconMovie className="mr-2 h-4 w-4" />
            Media
          </TabsTrigger>
          {serviceType === 'plex' && (
            <TabsTrigger value="collections">
              <IconStack2 className="mr-2 h-4 w-4" />
              Collections
            </TabsTrigger>
          )}
          <TabsTrigger value="stats">
            <IconChartBar className="mr-2 h-4 w-4" />
            Stats
          </TabsTrigger>
          <TabsTrigger value="activity">
            <IconHistory className="mr-2 h-4 w-4" />
            Recent Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Library Details */}
            <Card>
              <CardContent className="p-6 space-y-4">
                <h3 className="text-lg font-semibold flex items-center">
                  <IconInfoCircle className="mr-2 h-5 w-5 text-blue-500" />
                  Library Details
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Name:</span>
                    <span className="font-medium">{library.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type:</span>
                    <span className="font-medium">{libraryStats?.library_type || 'Mixed'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Server Nickname:</span>
                    <span className="font-medium">{library.server?.server_nickname}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Server:</span>
                    <span className="font-medium">{library.server?.server_name || library.server?.server_nickname}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Service:</span>
                    <span className="font-medium capitalize">{serviceType}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">External ID:</span>
                    <span className="font-medium font-mono text-sm">{library.external_id}</span>
                  </div>
                  {library.last_scanned && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Last Scanned:</span>
                      <span className="font-medium">
                        {new Date(library.last_scanned).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Popular Content */}
            <Card>
              <CardContent className="p-6 space-y-4">
                <h3 className="text-lg font-semibold flex items-center">
                  <IconStar className="mr-2 h-5 w-5 text-yellow-500" />
                  Most Popular Content
                </h3>
                {libraryStats?.popular_content && libraryStats.popular_content.length > 0 ? (
                  <div className="space-y-3">
                    {libraryStats.popular_content.map((content, idx) => (
                      <div key={idx} className="flex justify-between items-center">
                        <span className="font-medium truncate mr-2">{content.media_title}</span>
                        <span className="text-sm bg-primary/20 text-primary px-2 py-1 rounded-full">
                          {content.play_count} plays
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-center py-4">No streaming activity yet</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="media" className="space-y-6">
          {/* Action Buttons */}
          <div className="flex justify-end gap-2">
            <Button
              variant="destructive"
              onClick={handlePurgeLibrary}
              disabled={purging || syncing}
              title="Delete all cached items for this library from database"
            >
              {purging ? (
                <>
                  <IconTrash className="mr-2 h-4 w-4 animate-spin" />
                  Purging...
                </>
              ) : (
                <>
                  <IconTrash className="mr-2 h-4 w-4" />
                  Purge DB
                </>
              )}
            </Button>
            <Button onClick={handleSyncLibrary} disabled={syncing || purging}>
              {syncing ? (
                <>
                  <IconRefresh className="mr-2 h-4 w-4 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <IconRefresh className="mr-2 h-4 w-4" />
                  Sync Library
                </>
              )}
            </Button>
          </div>

          {/* Search and Controls */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <form onSubmit={handleSearch} className="flex-1">
                  <div className="relative">
                    <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder="Search library content..."
                      className="pl-10"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </form>

                <div className="flex items-center gap-2">
                  <Label className="text-sm whitespace-nowrap">Sort:</Label>
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="title_asc">Title (A-Z)</SelectItem>
                      <SelectItem value="title_desc">Title (Z-A)</SelectItem>
                      <SelectItem value="year_desc">Year (Newest)</SelectItem>
                      <SelectItem value="year_asc">Year (Oldest)</SelectItem>
                      <SelectItem value="total_streams_desc">Streams (Most)</SelectItem>
                      <SelectItem value="total_streams_asc">Streams (Least)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2">
                  <Label className="text-sm whitespace-nowrap">Per page:</Label>
                  <Select value={pageSize.toString()} onValueChange={(val) => {
                    setPageSize(Number(val));
                    setCurrentPage(1);
                  }}>
                    <SelectTrigger className="w-[100px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="12">12</SelectItem>
                      <SelectItem value="24">24</SelectItem>
                      <SelectItem value="48">48</SelectItem>
                      <SelectItem value="96">96</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Results Info */}
          {totalItems > 0 && (
            <div className="text-sm text-muted-foreground">
              Showing {((currentPage - 1) * pageSize) + 1}-{Math.min(currentPage * pageSize, totalItems)} of {totalItems}
            </div>
          )}

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
              {mediaItems.map((item) => (
                <MediaPosterCard
                  key={item.id}
                  item={item}
                  libraryId={libraryId!}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                  <i className="fa-solid fa-folder-open text-2xl text-muted-foreground"></i>
                </div>
                <h3 className="text-lg font-medium mb-2">No Media Found</h3>
                <p className="text-muted-foreground">This library appears to be empty or no results match your search.</p>
              </CardContent>
            </Card>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2">
              {currentPage > 1 && (
                <Button variant="outline" size="sm" onClick={() => handlePageChange(currentPage - 1)}>
                  <i className="fa-solid fa-chevron-left"></i>
                </Button>
              )}

              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const page = i + 1;
                return (
                  <Button
                    key={page}
                    variant={page === currentPage ? "default" : "outline"}
                    size="sm"
                    onClick={() => handlePageChange(page)}
                  >
                    {page}
                  </Button>
                );
              })}

              {currentPage < totalPages && (
                <Button variant="outline" size="sm" onClick={() => handlePageChange(currentPage + 1)}>
                  <i className="fa-solid fa-chevron-right"></i>
                </Button>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="collections" className="space-y-6">
          {library?.server?.service_type !== 'plex' ? (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                  <IconStack2 className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-2">Collections Not Available</h3>
                <p className="text-muted-foreground">Collections are only available for Plex libraries.</p>
              </CardContent>
            </Card>
          ) : collectionsLoading ? (
            <>
              <Skeleton className="h-8 w-64" />
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                {Array.from({ length: 24 }).map((_, idx) => (
                  <div key={idx} className="space-y-2">
                    <Skeleton className="aspect-[2/3] w-full rounded-lg" />
                    <Skeleton className="h-4 w-3/4 mx-auto" />
                    <Skeleton className="h-3 w-1/2 mx-auto" />
                  </div>
                ))}
              </div>
            </>
          ) : collections.length > 0 ? (
            <>
              <div>
                <h3 className="text-lg font-semibold mb-2 flex items-center">
                  <IconStack2 className="mr-2 h-5 w-5" />
                  Collections in {library.name}
                </h3>
                <p className="text-muted-foreground">
                  Found {collections.length} collection{collections.length === 1 ? '' : 's'}
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                {collections.map((collection: any, idx: number) => (
                  <CollectionCard key={idx} collection={collection} />
                ))}
              </div>
            </>
          ) : (
            <Card>
              <CardContent className="p-12 text-center">
                <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                  <IconStack2 className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-2">No Collections Found</h3>
                <p className="text-muted-foreground">This library doesn't have any collections yet.</p>
              </CardContent>
            </Card>
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
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, idx) => (
                <Card key={idx}>
                  <CardContent className="p-6">
                    <Skeleton className="h-4 w-24 mb-2" />
                    <Skeleton className="h-8 w-16" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : statsData ? (
            <>
              {/* Summary Stats */}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Total Streams</p>
                        <p className="text-2xl font-bold text-primary">{statsData.stats.total_streams || 0}</p>
                      </div>
                      <IconEye className="h-8 w-8 text-primary opacity-20" />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Unique Users</p>
                        <p className="text-2xl font-bold text-secondary">{statsData.stats.unique_users || 0}</p>
                      </div>
                      <IconUsers className="h-8 w-8 text-secondary opacity-20" />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Total Watch Time</p>
                        <p className="text-2xl font-bold">
                          {Math.floor((statsData.stats.total_duration || 0) / 3600)}h
                        </p>
                      </div>
                      <IconClock className="h-8 w-8 text-muted-foreground opacity-20" />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Avg Session</p>
                        <p className="text-2xl font-bold">
                          {Math.floor((statsData.stats.average_session_length || 0) / 60)}m
                        </p>
                      </div>
                      <IconChartBar className="h-8 w-8 text-muted-foreground opacity-20" />
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Activity Chart */}
              {statsData.chart_data && statsData.chart_data.length > 0 && (() => {
                // Get CSS variables for colors
                const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
                const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--secondary').trim();

                // Convert HSL to RGB for Chart.js
                const hslToRgb = (h: number, s: number, l: number) => {
                  s /= 100;
                  l /= 100;
                  const k = (n: number) => (n + h / 30) % 12;
                  const a = s * Math.min(l, 1 - l);
                  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
                  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
                };

                const parseHsl = (hslString: string) => {
                  const match = hslString.match(/(\d+\.?\d*)\s+(\d+\.?\d*)%\s+(\d+\.?\d*)%/);
                  if (match) {
                    return hslToRgb(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
                  }
                  return [59, 130, 246]; // fallback blue
                };

                const primaryRgb = parseHsl(primaryColor);
                const secondaryRgb = parseHsl(secondaryColor);
                const primaryColorStr = `rgb(${primaryRgb[0]}, ${primaryRgb[1]}, ${primaryRgb[2]})`;
                const primaryColorAlpha = `rgba(${primaryRgb[0]}, ${primaryRgb[1]}, ${primaryRgb[2]}, 0.8)`;
                const secondaryColorStr = `rgb(${secondaryRgb[0]}, ${secondaryRgb[1]}, ${secondaryRgb[2]})`;
                const secondaryColorAlpha = `rgba(${secondaryRgb[0]}, ${secondaryRgb[1]}, ${secondaryRgb[2]}, 0.8)`;

                const chartData = {
                  labels: statsData.chart_data.map((day: any) => day.label),
                  datasets: [
                    {
                      label: 'Total Plays',
                      data: statsData.chart_data.map((day: any) => day.plays || 0),
                      backgroundColor: primaryColorAlpha,
                      borderColor: primaryColorStr,
                      borderWidth: 1,
                      borderRadius: 4,
                      yAxisID: 'y',
                    },
                    {
                      label: 'Watch Time (minutes)',
                      data: statsData.chart_data.map((day: any) => day.time || 0),
                      backgroundColor: secondaryColorAlpha,
                      borderColor: secondaryColorStr,
                      borderWidth: 1,
                      borderRadius: 4,
                      yAxisID: 'y1',
                    },
                  ],
                };

                const options: ChartOptions<'bar'> = {
                  responsive: true,
                  maintainAspectRatio: false,
                  interaction: {
                    mode: 'index',
                    intersect: false,
                  },
                  plugins: {
                    legend: {
                      display: false,
                    },
                    tooltip: {
                      backgroundColor: 'rgba(0, 0, 0, 0.8)',
                      titleColor: 'white',
                      bodyColor: 'white',
                      borderColor: 'rgba(255, 255, 255, 0.1)',
                      borderWidth: 1,
                      cornerRadius: 8,
                      displayColors: true,
                      callbacks: {
                        label: function(context) {
                          if (context.dataset.label === 'Total Plays') {
                            return `${context.dataset.label}: ${context.parsed.y}`;
                          } else {
                            const minutes = Math.round(context.parsed.y);
                            const hours = Math.floor(minutes / 60);
                            const remainingMinutes = minutes % 60;

                            let timeStr;
                            if (hours > 0) {
                              timeStr = `${hours}h ${remainingMinutes}m`;
                            } else {
                              timeStr = `${minutes}m`;
                            }

                            return `${context.dataset.label}: ${timeStr}`;
                          }
                        }
                      }
                    }
                  },
                  scales: {
                    x: {
                      grid: {
                        display: false,
                      },
                      ticks: {
                        color: 'rgba(156, 163, 175, 0.8)',
                        font: {
                          size: 11,
                        },
                      },
                    },
                    y: {
                      type: 'linear',
                      display: true,
                      position: 'left',
                      beginAtZero: true,
                      grid: {
                        color: 'rgba(156, 163, 175, 0.1)',
                      },
                      ticks: {
                        color: 'rgba(156, 163, 175, 0.8)',
                        font: {
                          size: 11,
                        },
                        callback: function(value) {
                          return Math.round(value as number);
                        }
                      },
                      title: {
                        display: true,
                        text: 'Total Plays',
                        color: 'rgba(156, 163, 175, 0.8)',
                      },
                    },
                    y1: {
                      type: 'linear',
                      display: true,
                      position: 'right',
                      beginAtZero: true,
                      grid: {
                        drawOnChartArea: false,
                      },
                      ticks: {
                        color: 'rgba(156, 163, 175, 0.8)',
                        font: {
                          size: 11,
                        },
                        callback: function(value) {
                          const numValue = value as number;
                          const hours = Math.floor(numValue / 60);
                          const minutes = numValue % 60;

                          if (hours > 0) {
                            return `${hours}h ${minutes}m`;
                          } else {
                            return `${Math.round(numValue)}m`;
                          }
                        }
                      },
                      title: {
                        display: true,
                        text: 'Watch Time (minutes)',
                        color: 'rgba(156, 163, 175, 0.8)',
                      },
                    },
                  },
                };

                return (
                  <Card>
                    <CardContent className="p-6">
                      <h3 className="text-lg font-semibold mb-4 flex items-center">
                        <IconChartBar className="mr-2 h-5 w-5" />
                        Watch Time Activity
                      </h3>
                      <div className="relative h-[300px]">
                        <Bar data={chartData} options={options} />
                      </div>

                      {/* Custom Legend */}
                      <div className="flex flex-wrap gap-4 mt-4 justify-center">
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 rounded bg-primary"></div>
                          <span className="text-sm text-muted-foreground">Total Plays</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 rounded bg-secondary"></div>
                          <span className="text-sm text-muted-foreground">Watch Time (minutes)</span>
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
                      <IconStar className="mr-2 h-5 w-5" />
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
                  <IconChartBar className="h-8 w-8 text-muted-foreground" />
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
          {/* Time Range Selector */}
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold flex items-center">
              <IconHistory className="mr-2 h-5 w-5" />
              Recent Activity
            </h3>
            <Select value={activityDays.toString()} onValueChange={(val) => { setActivityDays(Number(val)); setActivityPage(1); }}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 Days</SelectItem>
                <SelectItem value="30">Last 30 Days</SelectItem>
                <SelectItem value="90">Last 90 Days</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-hidden rounded-xl border shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Content</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Player / Platform</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activityLoading ? (
                  Array.from({ length: 10 }).map((_, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Skeleton className="w-12 h-16 flex-shrink-0" />
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-48" />
                            <Skeleton className="h-3 w-32" />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Skeleton className="w-8 h-8 rounded-full" />
                          <Skeleton className="h-4 w-24" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-3 w-20" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-16" />
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-3 w-16" />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : activityData.length > 0 ? (
                  activityData.map((stream: any) => {
                    const formatDuration = (seconds: number) => {
                      const hours = Math.floor(seconds / 3600);
                      const minutes = Math.floor((seconds % 3600) / 60);
                      if (hours > 0) {
                        return `${hours}h ${minutes}m`;
                      }
                      return `${minutes}m`;
                    };

                    const formatDate = (dateStr: string) => {
                      const date = new Date(dateStr);
                      return date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
                    };

                    const formatTime = (dateStr: string) => {
                      const date = new Date(dateStr);
                      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
                    };

                    return (
                      <TableRow key={stream.id} className="hover:bg-accent/50">
                        <TableCell>
                          <div className="flex items-center gap-3">
                            {/* Poster Thumbnail */}
                            <div className="w-12 h-16 flex-shrink-0">
                              {stream.thumb_path ? (
                                <img
                                  src={stream.thumb_path}
                                  alt={stream.media_title || 'Unknown'}
                                  className="w-full h-full object-cover rounded border border-border shadow-sm"
                                  loading="lazy"
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                    if (e.currentTarget.nextElementSibling) {
                                      (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                                    }
                                  }}
                                />
                              ) : null}
                              <div className={`w-full h-full bg-muted/50 rounded border border-border flex items-center justify-center ${stream.thumb_path ? 'hidden' : 'flex'}`}>
                                <IconMovie className="h-6 w-6 text-muted-foreground opacity-40" />
                              </div>
                            </div>

                            {/* Content Info */}
                            <div className="flex flex-col min-w-0 flex-1">
                              <div className="font-medium truncate">{stream.media_title || 'Unknown'}</div>
                              {(stream.grandparent_title || stream.parent_title) && (
                                <div className="text-sm text-muted-foreground truncate">
                                  {stream.grandparent_title}
                                  {stream.grandparent_title && stream.parent_title && ' • '}
                                  {stream.parent_title}
                                </div>
                              )}
                              {stream.media_type && (
                                <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1 w-fit mt-1">
                                  {stream.media_type}
                                </span>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            {/* User Avatar */}
                            <div className="w-8 h-8 flex-shrink-0">
                              {stream.user_avatar_url ? (
                                <img
                                  src={stream.user_avatar_url}
                                  alt={`${stream.user_display_name} avatar`}
                                  className="w-full h-full object-cover rounded-full border border-border"
                                  loading="lazy"
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                    if (e.currentTarget.nextElementSibling) {
                                      (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                                    }
                                  }}
                                />
                              ) : null}
                              <div className={`w-full h-full rounded-full border border-border flex items-center justify-center text-white text-xs font-medium bg-primary ${stream.user_avatar_url ? 'hidden' : 'flex'}`}>
                                {stream.user_display_name?.[0]?.toUpperCase() || 'U'}
                              </div>
                            </div>

                            {/* User Name */}
                            <div className="flex flex-col">
                              <div className="font-medium truncate">{stream.user_display_name}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{stream.started_at ? formatDate(stream.started_at) : '—'}</span>
                            <span className="text-sm text-muted-foreground">{stream.started_at ? formatTime(stream.started_at) : ''}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="font-medium">
                            {stream.duration_seconds ? formatDuration(stream.duration_seconds) : '—'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            {stream.platform && (
                              <span className="font-medium">{stream.platform}</span>
                            )}
                            {stream.player && (
                              <span className="text-sm text-muted-foreground">{stream.player}</span>
                            )}
                            {!stream.platform && !stream.player && (
                              <span className="text-muted-foreground">Unknown</span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center">
                      <div className="flex flex-col items-center">
                        <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mb-4">
                          <IconHistory className="h-8 w-8 text-muted-foreground" />
                        </div>
                        <h3 className="text-lg font-medium mb-2">No Recent Activity</h3>
                        <p className="text-sm text-muted-foreground">
                          No streaming activity found for this library in the selected time period.
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            {/* Pagination */}
            {activityTotalPages > 1 && (
              <div className="border-t">
                <Pagination
                  currentPage={activityPage}
                  totalPages={activityTotalPages}
                  onPageChange={setActivityPage}
                  loading={activityLoading}
                />
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default LibraryDetailPage;
