import { useState, useEffect } from 'react';
import { useParams, Link, useSearch, useNavigate } from '@tanstack/react-router';
import { requestJson } from '../util/apiClient';
// Images are authenticated via cookie; no token param needed
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
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
  faPlay,
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

type TabType = 'overview' | 'episodes' | 'activity';

interface Episode {
  id: number;
  title: string;
  season_number?: number;
  episode_number?: number;
  year?: number;
  rating?: number;
  thumb?: string;
  stream_count?: number;
}

export const MediaDetailPage = () => {
  const { libraryId, mediaId } = useParams({ from: '/admin/libraries/$libraryId/$mediaId' }) as {
    libraryId: string
    mediaId: string
  };
  const search = useSearch({ from: '/admin/libraries/$libraryId/$mediaId', strict: false }) as { tab?: TabType };
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

  const activeTab: TabType = search.tab ?? 'overview';
  // Check if this is a TV show library (show, tv, series, tvshows)
  const libraryType = mediaItem?.library?.library_type?.toLowerCase() || '';
  const isTVShow = ['show', 'tv', 'series', 'tvshows'].includes(libraryType);

  useEffect(() => {
    loadMediaItem();
  }, [libraryId, mediaId]);

  useEffect(() => {
    if (isTVShow && activeTab === 'episodes') {
      loadEpisodes();
    }
  }, [activeTab, episodesPage, episodesSearch, episodesSortBy, episodesPerPage, isTVShow]);

  const loadMediaItem = async () => {
    if (!libraryId || !mediaId) return;

    try {
      setLoading(true);
      const response = await requestJson(
        `/admin/api/v2/libraries/${libraryId}/media/${mediaId}?include_library=true`
      );

      if (response.data) {
        setMediaItem(response.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load media item');
    } finally {
      setLoading(false);
    }
  };

  const loadEpisodes = async () => {
    if (!libraryId || !mediaId) return;

    try {
      setEpisodesLoading(true);
      const params = new URLSearchParams({
        page: episodesPage.toString(),
        page_size: episodesPerPage,
        sort_by: episodesSortBy
      });
      if (episodesSearch) {
        params.append('search', episodesSearch);
      }

      const response = await requestJson(
        `/admin/api/v2/libraries/${libraryId}/media/${mediaId}/episodes?${params}`
      );

      if (response.data) {
        setEpisodes(response.data.episodes || []);
        setEpisodesTotalPages(response.meta?.pagination?.total_pages || 1);
        setEpisodesTotalItems(response.meta?.pagination?.total_items || 0);
      }
    } catch (err) {
      console.error('Failed to load episodes:', err);
      setEpisodes([]);
    } finally {
      setEpisodesLoading(false);
    }
  };

  const handleSyncEpisodes = async () => {
    if (!libraryId || !mediaId) return;

    try {
      setSyncing(true);
      const response = await requestJson(
        `/admin/api/v2/libraries/${libraryId}/media/${mediaId}/episodes/sync`,
        { method: 'POST' }
      );

      if (response.success) {
        await loadEpisodes();
      }
    } catch (err) {
      console.error('Failed to sync episodes:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handlePurgeEpisodes = async () => {
    if (!libraryId || !mediaId) return;
    const confirmed = window.confirm(
      'Purge all cached episodes for this show? They will need to be re-synced from the server.'
    );
    if (!confirmed) {
      return;
    }

    try {
      setPurgingEpisodes(true);
      const response = await requestJson(
        `/admin/api/v2/libraries/${libraryId}/media/${mediaId}/episodes/purge`,
        { method: 'POST' }
      );

      if (response.success) {
        setEpisodesPage(1);
        await loadEpisodes();
      }
    } catch (err) {
      console.error('Failed to purge episodes:', err);
    } finally {
      setPurgingEpisodes(false);
    }
  };

  const setTab = (tab: TabType) => {
    navigate({ from: '/admin/libraries/$libraryId/$mediaId', search: (prev) => ({ ...prev, tab }) });
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
        <Link to={`/admin/libraries/${libraryId}?tab=media`}>
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

                <Link to={`/admin/libraries/${libraryId}`}>
                  <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1 hover:bg-blue-100 dark:hover:bg-blue-400/20 transition-colors cursor-pointer">
                    <FontAwesomeIcon icon={faFolder} className="w-3 h-3" />
                    {mediaItem.library?.name}
                  </span>
                </Link>

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
                  <p className="text-sm text-muted-foreground leading-relaxed">{mediaItem.summary}</p>
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
                    <span>Added {new Date(mediaItem.added_at).toLocaleDateString()}</span>
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
                        {new Date(mediaItem.added_at).toLocaleString()}
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
                  <p className="text-sm text-muted-foreground leading-relaxed">{mediaItem.summary}</p>
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
                    disabled={purgingEpisodes || syncing}
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
                  <Button onClick={handleSyncEpisodes} disabled={syncing || purgingEpisodes} size="sm">
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
                      <div key={episode.id} className="group cursor-pointer">
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
                              <FontAwesomeIcon icon={faPlay} className="text-2xl mb-2" />
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
                      </div>
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
                    <h3 className="text-lg font-medium mb-2">No Episodes Found</h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                      No episodes are available for this show. Click the Sync button to fetch episodes.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="activity">
          <Card>
            <CardContent className="p-12 text-center">
              <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                <FontAwesomeIcon icon={faChartLine} className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-2">Activity</h3>
              <p className="text-muted-foreground">Activity tracking feature coming soon</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Back Button */}
      <Link to={`/admin/libraries/${libraryId}?tab=media`}>
        <Button variant="ghost">
          <FontAwesomeIcon icon={faArrowLeft} className="mr-2 h-4 w-4" />
          Back to Library
        </Button>
      </Link>
    </div>
  );
};

export default MediaDetailPage;
