import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { StreamingTable, StreamingSummaryCard, StreamingSettingsModal } from '../components/dashboard';
import { useServers } from '../hooks/useServers';
import { useStreamingSettings } from '../hooks/useStreamingSettings';
import { useStreamingSummary } from '../hooks/useStreamingSummary';
import { useStreamingWebSocket } from '../hooks/useStreamingWebSocket';
import { Button, PageHeader } from '../components';
import { requestJson } from '../util/apiClient';
import { useToast } from '../util/toast';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconDots } from '@tabler/icons-react';

type ActiveSession = {
  // Basic identifiers
  session_key: string;
  user: string;
  user_avatar_url?: string;
  mum_user_id?: number;

  // Media info
  media_title: string;
  grandparent_title?: string;
  parent_title?: string;
  media_type: string;
  library_name: string;
  year?: string;
  thumb_url?: string;

  // Server info
  service_type: string;
  server_name: string;

  // Player info
  player_title?: string;
  player_platform?: string;
  product?: string;
  state: string;

  // Progress
  progress: number;
  current_time: string;
  duration: string;

  // Quality and streaming details
  quality_detail: string;
  stream_detail: string;
  container_detail?: string;
  video_detail?: string;
  audio_detail?: string;
  subtitle_detail?: string;
  transcode_reason?: string;

  // Location
  location_detail: string;
  location_ip?: string;
  is_public_ip?: boolean;
  bandwidth_detail?: string;

  // Raw data for debugging
  raw_data_json?: string;

  // Calculated fields for statistics
  bitrate_calc?: number;
  location_type_calc?: string;
  is_transcode_calc?: boolean;
};

const parseDurationToSeconds = (value?: string) => {
  if (!value) return 0;
  const parts = value.split(':').map(Number).filter((part) => !Number.isNaN(part));
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return 0;
};

const formatSecondsToTimestamp = (totalSeconds: number) => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
    .toString()
    .padStart(2, '0')}`;
};

const calculateProgress = (currentSeconds: number, duration?: string) => {
  const totalSeconds = parseDurationToSeconds(duration);
  if (totalSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (currentSeconds / totalSeconds) * 100));
};

type ActiveSessionsResponse = {
  sessions: ActiveSession[];
  total_count: number;
  by_server?: Record<string, ActiveSession[]>;
  by_service?: Record<string, ActiveSession[]>;
};

type ViewMode = 'merged' | 'categorized' | 'service';

export const StreamingPage = () => {
  const [page, setPage] = useState(1);
  const [serviceType, setServiceType] = useState('all');
  const [status, setStatus] = useState('all');
  const [userUuid, setUserUuid] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const { summary } = useStreamingSummary();
  const { servers: mediaServers } = useServers();
  const { settings: streamingSettings } = useStreamingSettings();
  // Use the admin-configured interval for truth refreshes, defaulting to 30s with a hard
  // floor of 2s to prevent thrashing.
  const websocketTruthIntervalSeconds = useMemo(() => {
    const plexIntervals = mediaServers
      .filter((server) => server.service_type === 'plex')
      .map((server) => Math.max(2, server.websocket_refresh_interval ?? 30));

    if (plexIntervals.length > 0) {
      return Math.max(2, Math.min(...plexIntervals));
    }

    return Math.max(2, streamingSettings?.websocket_refresh_interval ?? 30);
  }, [mediaServers, streamingSettings?.websocket_refresh_interval]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // For live WebSocket-backed services we snapshot the server-provided progress and then
  // animate locally between truth updates. These refs keep track of the last
  // authoritative payload so we can re-sync roughly every 30s without hammering Plex.
  const [activeSessions, setActiveSessions] = useState<ActiveSessionsResponse | null>(null);
  const [sessionOffsets, setSessionOffsets] = useState<Record<string, number>>({});
  const [lastUpdateAt, setLastUpdateAt] = useState<Date | null>(null);
  const [tick, forceTick] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('merged');
  const [loading, setLoading] = useState(false);
  const [showTerminateModal, setShowTerminateModal] = useState(false);
  const [selectedSession, setSelectedSession] = useState<ActiveSession | null>(null);
  const [terminateMessage, setTerminateMessage] = useState('');

  const toast = useToast();
  const liveServicesRef = useRef<string[]>([]);
  const lastUpdateRef = useRef<Date | null>(null);
  const truthTimeoutRef = useRef<number | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  const websocketTruthIntervalMs = websocketTruthIntervalSeconds * 1000;

  const fetchActiveSessions = useCallback(
    async (options?: { silent?: boolean; force?: boolean; reason?: 'websocket' | 'timeout' | 'manual' | 'interval-change' | 'initial' }) => {
      const silent = options?.silent ?? false;
      const force = options?.force ?? false;
      const reason = options?.reason ?? 'manual';
      const previousUpdateAt = lastUpdateRef.current;
      const now = new Date();
      const hasNonWebsocketServers = mediaServers.some((server) => server.service_type !== 'plex');
      if (!hasNonWebsocketServers && (reason === 'manual' || reason === 'initial' || reason === 'interval-change')) {
        return;
      }
      const shouldFetch =
        !silent ||
        force ||
        !previousUpdateAt ||
        now.getTime() - previousUpdateAt.getTime() >= websocketTruthIntervalMs;

      if (!shouldFetch) {
        setBootstrapping(false);
        return;
      }

      try {
        // Grabbing the latest session payload gives us a source-of-truth baseline.
        // Between these fetches we rely on the local clock to advance the UI smoothly,
        // so we keep the frequency low to avoid piling extra load on Plex.
        if (!silent) {
          setLoading(true);
        }
        const response = await requestJson<ActiveSessionsResponse>('/admin/api/v1/streaming/active');
        setActiveSessions(response);
        const fetchCompletedAt = new Date();
        const liveServicesCurrent = new Set(liveServicesRef.current);
        setSessionOffsets((previous) => {
          const offsets: Record<string, number> = {};
          response.sessions.forEach((session) => {
            const key = session.session_key;
            const serviceType = session.service_type?.toLowerCase() ?? '';
            const isLiveService = liveServicesCurrent.has(serviceType);
            const baseSeconds = parseDurationToSeconds(session.current_time);
            const previousBase = previous[key];
            let value = baseSeconds;
            const sessionState = session.state?.toLowerCase();

            if (
              isLiveService &&
              sessionState === 'playing' &&
              previousBase !== undefined &&
              previousUpdateAt
            ) {
              const elapsed = (fetchCompletedAt.getTime() - previousUpdateAt.getTime()) / 1000;
              if (elapsed > 0) {
                const predicted = previousBase + elapsed;
                if (predicted > value && predicted - value <= 3) {
                  value = predicted;
                }
              }
            }

            offsets[key] = value;
          });
          return offsets;
        });
        setLastUpdateAt(fetchCompletedAt);
        lastUpdateRef.current = fetchCompletedAt;

        if (truthTimeoutRef.current) {
          window.clearTimeout(truthTimeoutRef.current);
        }
        truthTimeoutRef.current = window.setTimeout(() => {
          fetchActiveSessions({ silent: true, reason: 'timeout', force: true });
        }, websocketTruthIntervalMs);
      } catch (error) {
        console.error('Failed to fetch active sessions:', error);
      } finally {
        if (!silent) {
          setLoading(false);
        }
        setBootstrapping(false);
      }
    },
    [websocketTruthIntervalMs, mediaServers]
  );

  // Use WebSocket for real-time updates instead of polling
  const { isConnected, liveServices } = useStreamingWebSocket({
    autoConnect: true,
    onUpdate: (data) => {
      if (Array.isArray(data.live_services)) {
        liveServicesRef.current = data.live_services.map((service) =>
          String(service).toLowerCase()
        );
      }
      // When we receive a WebSocket update, refresh the active sessions
      console.log('[StreamingPage] WebSocket update received, refreshing sessions');
      fetchActiveSessions({ silent: true, reason: 'websocket' });
    }
  });

  useEffect(() => {
    liveServicesRef.current = liveServices;
  }, [liveServices]);

  const liveServiceSet = useMemo(
    () => new Set(liveServices.map((service) => service.toLowerCase())),
    [liveServices]
  );

  useEffect(() => {
    fetchActiveSessions({ silent: false, reason: 'initial' });
  }, [fetchActiveSessions]);

  useEffect(() => {
    fetchActiveSessions({ silent: false, reason: 'interval-change' });
  }, [websocketTruthIntervalSeconds, fetchActiveSessions]);

  useEffect(() => {
    // Drive a lightweight animation tick so we can advance "playing" sessions locally
    // between source-of-truth refreshes. This keeps the UI feeling live without
    // hammering Plex for every heartbeat.
    const interval = window.setInterval(() => {
      forceTick((prev) => prev + 1);
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (truthTimeoutRef.current) {
        window.clearTimeout(truthTimeoutRef.current);
      }
    };
  }, []);

  const interpolatedSessions = useMemo(() => {
    if (!activeSessions) return null;
    const now = new Date();
    const baseline = lastUpdateAt ? (now.getTime() - lastUpdateAt.getTime()) / 1000 : 0;
    const updatedSessions = activeSessions.sessions.map((session) => {
      const serviceType = session.service_type?.toLowerCase();
      const isLiveService = serviceType ? liveServiceSet.has(serviceType) : false;
      if (!isLiveService || session.state?.toLowerCase() !== 'playing') {
        return session;
      }

      const baselineOffset = sessionOffsets[session.session_key] ?? parseDurationToSeconds(session.current_time);
      const interpolatedOffset = Math.max(0, baselineOffset + baseline);
      const clampedOffset = Math.min(
        interpolatedOffset,
        parseDurationToSeconds(session.duration)
      );
      return {
        ...session,
        current_time: formatSecondsToTimestamp(clampedOffset),
        progress: calculateProgress(clampedOffset, session.duration),
      };
    });

    const updatedSessionMap = new Map(
      updatedSessions.map((session) => [session.session_key, session])
    );

    const updatedByServer = activeSessions.by_server
      ? Object.fromEntries(
          Object.entries(activeSessions.by_server).map(([server, sessions]) => [
            server,
            sessions.map(
              (session) => updatedSessionMap.get(session.session_key) ?? session
            ),
          ])
        )
      : undefined;

    const updatedByService = activeSessions.by_service
      ? Object.fromEntries(
          Object.entries(activeSessions.by_service).map(([service, sessions]) => [
            service,
            sessions.map(
              (session) => updatedSessionMap.get(session.session_key) ?? session
            ),
          ])
        )
      : undefined;

    return {
      ...activeSessions,
      sessions: updatedSessions,
      by_server: updatedByServer,
      by_service: updatedByService,
    };
  }, [activeSessions, lastUpdateAt, sessionOffsets, tick, liveServiceSet]);

  const sessionsData = interpolatedSessions ?? activeSessions;

  const handleManualRefresh = () => {
    fetchActiveSessions({ silent: false, reason: 'manual' });
  };

  const hasLiveWebsocketSessions = Boolean(
    sessionsData?.sessions?.some((session) =>
      session.service_type ? liveServiceSet.has(session.service_type.toLowerCase()) : false
    )
  );


  const handleTerminateSession = async () => {
    if (!selectedSession) return;

    try {
      await requestJson('/admin/api/v1/streaming/terminate', {
        method: 'POST',
        body: JSON.stringify({
          session_key: selectedSession.session_key,
          service_type: selectedSession.service_type,
          server_name: selectedSession.server_name,
          message: terminateMessage
        })
      });

      toast.showToast({
        type: 'success',
        title: 'Session Terminated',
        description: `Session for ${selectedSession.user} has been terminated`
      });

      setShowTerminateModal(false);
      setSelectedSession(null);
      setTerminateMessage('');
      fetchActiveSessions();
    } catch (error) {
      toast.showToast({
        type: 'error',
        title: 'Failed to terminate session',
        description: String(error)
      });
    }
  };

  const openTerminateModal = (session: ActiveSession) => {
    setSelectedSession(session);
    setTerminateMessage('');
    setShowTerminateModal(true);
  };

  const renderActiveSessions = () => {
    if (!sessionsData) return null;

    const renderSessionCard = (session: ActiveSession) => {
      // Determine service-specific gradient background
      const getCardBgClass = () => {
        switch (session.service_type) {
          case 'plex': return 'bg-gradient-to-br from-base-200 to-plex/10';
          case 'jellyfin': return 'bg-gradient-to-br from-base-200 to-jellyfin/10';
          case 'emby': return 'bg-gradient-to-br from-base-200 to-emby/10';
          case 'kavita': return 'bg-gradient-to-br from-base-200 to-kavita/10';
          case 'audiobookshelf': return 'bg-gradient-to-br from-base-200 to-audiobookshelf/10';
          case 'komga': return 'bg-gradient-to-br from-base-200 to-komga/10';
          case 'romm': return 'bg-gradient-to-br from-base-200 to-romm/10';
          default: return 'bg-base-200';
        }
      };

      const getServiceBgClass = () => {
        switch (session.service_type) {
          case 'plex': return 'bg-plex';
          case 'jellyfin': return 'bg-jellyfin';
          case 'emby': return 'bg-emby';
          case 'kavita': return 'bg-kavita';
          case 'audiobookshelf': return 'bg-audiobookshelf';
          case 'komga': return 'bg-komga';
          case 'romm': return 'bg-romm';
          default: return 'bg-primary';
        }
      };

      return (
        <div key={session.session_key} className={`card ${getCardBgClass()} shadow-lg w-full max-w-md relative group`} tabIndex={0}>
          {/* Action buttons (top right) */}
          <div className="absolute top-2 right-2 z-10 flex space-x-1 opacity-0 pointer-events-none transition-opacity duration-200 group-hover:opacity-100 group-hover:pointer-events-auto group-focus:opacity-100 group-focus:pointer-events-auto">
            <button
              className="btn btn-xs btn-circle btn-error"
              onClick={() => openTerminateModal(session)}
              title="Terminate Session"
            >
              <i className="fa-solid fa-times" />
            </button>
          </div>

          <div className="card-body p-3">
            {/* Main Flex Container: Poster | Details */}
            <div className="flex items-start space-x-3">
              {/* Poster Column */}
              <div className="avatar flex-shrink-0">
                <div className="w-30 h-45 rounded">
                  {session.thumb_url ? (
                    <img
                      src={session.thumb_url}
                      alt={`${session.media_title} Poster`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                        if (e.currentTarget.nextElementSibling) {
                          (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                        }
                      }}
                    />
                  ) : null}
                  {/* Fallback when image fails to load or no image */}
                  <div
                    className="w-full h-full bg-base-300 flex flex-col items-center justify-center text-xs text-base-content/50"
                    style={{ display: session.thumb_url ? 'none' : 'flex' }}
                  >
                    <i className="fa-solid fa-image fa-2x mb-1" />
                    <div>No Poster</div>
                  </div>
                </div>
              </div>

              {/* Details Column */}
              <div className="flex-grow min-w-0">
                <div className="text-xs space-y-0.5 mt-1">
                  {/* User */}
                  <p className="text-base-content/80 flex items-center" title={session.user}>
                    {session.user_avatar_url ? (
                      <div className="avatar avatar-xs mr-1.5">
                        <div className="w-4 h-4 rounded-full">
                          <img
                            src={session.user_avatar_url}
                            alt={`${session.user} avatar`}
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              if (e.currentTarget.nextElementSibling) {
                                (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                              }
                            }}
                          />
                          {/* Fallback avatar */}
                          <div
                            className={`${getServiceBgClass()} text-white w-4 h-4 rounded-full flex items-center justify-center text-[0.5rem] font-bold`}
                            style={{ display: 'none' }}
                          >
                            {session.user?.[0]?.toUpperCase() || 'U'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="avatar avatar-xs mr-1.5">
                        <div className={`${getServiceBgClass()} text-white w-4 h-4 rounded-full flex items-center justify-center text-[0.5rem] font-bold`}>
                          {session.user?.[0]?.toUpperCase() || 'U'}
                        </div>
                      </div>
                    )}
                    <span className="link link-hover text-info" title="User">
                      {session.user}
                    </span>
                  </p>

                  {/* Player */}
                  <p className="text-base-content/70 flex items-center" title={`${session.player_title} (${session.player_platform} via ${session.product})`}>
                    <i className="fa-solid fa-play fa-fw mr-1.5 text-info w-4 text-center" />
                    <span className="font-medium mr-1 text-info">Player:</span>
                    {session.player_title}{' '}
                    <span className="text-base-content/50 ml-1">
                      ({session.product !== session.player_title ? session.product : session.player_platform})
                    </span>
                  </p>

                  {/* Media/Library */}
                  <p className="text-base-content/70 flex items-center">
                    <i className="fa-solid fa-tv fa-fw mr-1.5 text-info w-4 text-center" />
                    <span className="font-medium mr-1 text-info">Media/Library:</span>
                    {session.media_type} on {session.library_name}
                  </p>

                  {/* Quality */}
                  <p className="text-base-content/70 flex items-center" title={`Quality: ${session.quality_detail}`}>
                    <i className="fa-solid fa-sliders fa-fw w-4 mr-1.5 text-info text-center" />
                    <span className="font-medium mr-1 text-info">Quality:</span>
                    <span>{session.quality_detail}</span>
                  </p>

                  {/* Stream */}
                  <p className="text-base-content/70 flex items-center" title={`Stream: ${session.stream_detail}`}>
                    <i className="fa-solid fa-wifi fa-fw w-4 mr-1.5 text-info text-center" />
                    <span className="font-medium mr-1 text-info">Stream:</span>
                    <span className={`font-medium ${session.stream_detail?.includes('Transcode') ? 'text-orange-400' : 'text-green-400'}`}>
                      {session.stream_detail}
                    </span>
                    {session.stream_detail?.includes('Transcode') && session.transcode_reason && (
                      <i className="fa-solid fa-info-circle ml-1 text-orange-400/80" title={`Reason: ${session.transcode_reason}`} />
                    )}
                  </p>

                  {/* Container */}
                  {session.container_detail && (
                    <p className="text-base-content/70 flex items-center" title={`Container: ${session.container_detail}`}>
                      <i className="fa-solid fa-box-archive fa-fw w-4 mr-1.5 text-info text-center" />
                      <span className="font-medium mr-1 text-info">Container:</span>
                      <span>{session.container_detail}</span>
                    </p>
                  )}

                  {/* Video */}
                  {session.video_detail && (
                    <p className="text-base-content/70 flex items-center" title={`Video: ${session.video_detail}`}>
                      <i className="fa-solid fa-film fa-fw w-4 mr-1.5 text-info text-center" />
                      <span className="font-medium mr-1 text-info">Video:</span>
                      <span>{session.video_detail}</span>
                    </p>
                  )}

                  {/* Audio */}
                  {session.audio_detail && (
                    <p className="text-base-content/70 flex items-center" title={`Audio: ${session.audio_detail}`}>
                      <i className="fa-solid fa-volume-high fa-fw w-4 mr-1.5 text-info text-center" />
                      <span className="font-medium mr-1 text-info">Audio:</span>
                      <span>{session.audio_detail}</span>
                    </p>
                  )}

                  {/* Subtitle */}
                  {session.subtitle_detail && (
                    <p className="text-base-content/70 flex items-center" title={`Subtitle: ${session.subtitle_detail}`}>
                      <i className="fa-solid fa-closed-captioning fa-fw w-4 mr-1.5 text-info text-center" />
                      <span className="font-medium mr-1 text-info">Subtitle:</span>
                      <span>{session.subtitle_detail}</span>
                    </p>
                  )}

                  {/* Location */}
                  <p className="text-base-content/70 flex items-center" title={`Location: ${session.location_detail}`}>
                    <i className="fa-solid fa-location-dot fa-fw w-4 mr-1.5 text-info text-center" />
                    <span className="font-medium mr-1 text-info">Location:</span>
                    <span>{session.location_detail}</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Progress Bar and State */}
            <div className="mt-2">
              <div className="flex justify-between items-center mb-0.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-medium uppercase ${
                      session.state?.toLowerCase() === 'playing' || session.state?.toLowerCase() === 'listening'
                        ? 'text-success'
                        : session.state?.toLowerCase() === 'paused'
                        ? 'text-warning'
                        : session.state?.toLowerCase() === 'buffering'
                        ? 'text-info'
                        : 'text-base-content/70'
                    }`}
                  >
                    {session.state || 'Unknown'}
                  </span>

                  {/* Server Badge */}
                  <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset gap-1 ${
                    session.service_type === 'plex' ? 'bg-plex-50 dark:bg-plex-400/10 text-plex-700 dark:text-plex-400 ring-plex-600/20 dark:ring-plex-500/20' :
                    session.service_type === 'jellyfin' ? 'bg-jellyfin-50 dark:bg-jellyfin-400/10 text-jellyfin-700 dark:text-jellyfin-400 ring-jellyfin-600/20 dark:ring-jellyfin-500/20' :
                    session.service_type === 'emby' ? 'bg-emby-50 dark:bg-emby-400/10 text-emby-700 dark:text-emby-400 ring-emby-600/20 dark:ring-emby-500/20' :
                    session.service_type === 'kavita' ? 'bg-kavita-50 dark:bg-kavita-400/10 text-kavita-700 dark:text-kavita-400 ring-kavita-600/20 dark:ring-kavita-500/20' :
                    session.service_type === 'audiobookshelf' ? 'bg-audiobookshelf-50 dark:bg-audiobookshelf-400/10 text-audiobookshelf-700 dark:text-audiobookshelf-400 ring-audiobookshelf-600/20 dark:ring-audiobookshelf-500/20' :
                    session.service_type === 'komga' ? 'bg-komga-50 dark:bg-komga-400/10 text-komga-700 dark:text-komga-400 ring-komga-600/20 dark:ring-komga-500/20' :
                    session.service_type === 'romm' ? 'bg-romm-50 dark:bg-romm-400/10 text-romm-700 dark:text-romm-400 ring-romm-600/20 dark:ring-romm-500/20' :
                    'bg-gray-50 dark:bg-gray-400/10 text-gray-700 dark:text-gray-400 ring-gray-600/20 dark:ring-gray-500/20'
                  }`}>
                    {session.service_type === 'plex' && (
                      <svg className="w-3 h-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" strokeLinejoin="round" strokeWidth="12">
                        <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/>
                      </svg>
                    )}
                    {session.service_type !== 'plex' && <i className="fa-solid fa-server w-3 h-3" />}
                    {session.server_name}
                  </span>
                </div>
                <span className="text-xs text-base-content/70">
                  {session.current_time} / {session.duration} ({session.progress?.toFixed(1) || 0}%)
                </span>
              </div>
              <progress
                className={`progress progress-xs w-full ${
                  session.state?.toLowerCase() === 'playing' || session.state?.toLowerCase() === 'listening'
                    ? 'progress-success'
                    : session.state?.toLowerCase() === 'paused'
                    ? 'progress-warning'
                    : session.state?.toLowerCase() === 'buffering'
                    ? 'progress-info'
                    : 'progress-primary'
                }`}
                value={session.progress || 0}
                max="100"
              />
              <h2 className="card-title text-sm font-semibold" title={session.media_title}>
                {session.media_title || 'Unknown Title'}
                {session.year && <span className="text-xs font-normal text-base-content/70">({session.year})</span>}
              </h2>
              {session.media_type === 'Episode' && session.grandparent_title && (
                <p className="text-xs text-primary" title={`${session.grandparent_title}${session.parent_title ? ` - ${session.parent_title}` : ''}`}>
                  {session.grandparent_title}{session.parent_title ? ` - ${session.parent_title}` : ''}
                </p>
              )}
              {session.media_type === 'Track' && (session.parent_title || session.grandparent_title) && (
                <p className="text-xs text-primary" title={`${session.grandparent_title || ''}${session.grandparent_title && session.parent_title ? ' - ' : ''}${session.parent_title || ''}`}>
                  {session.grandparent_title || ''}{session.grandparent_title && session.parent_title ? ' - ' : ''}{session.parent_title || ''}
                </p>
              )}
              {session.service_type === 'audiobookshelf' && session.parent_title && (
                <p className="text-xs text-primary" title={session.parent_title}>
                  <i className="fa-solid fa-user-pen mr-1" />
                  {session.parent_title}
                </p>
              )}
            </div>
          </div>
        </div>
      );
    };

    if (viewMode === 'merged') {
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessionsData.sessions.map(renderSessionCard)}
        </div>
      );
    }

    if (viewMode === 'categorized' && sessionsData.by_server) {
      return (
        <div className="space-y-6">
          {Object.entries(sessionsData.by_server).map(([serverName, sessions]) => (
            <div key={serverName}>
              <h3 className="text-lg font-semibold text-base-content mb-3 flex items-center gap-2">
                <i className="fa-solid fa-server text-primary" />
                {serverName}
                <Badge variant="secondary" className="ml-2">{sessions.length}</Badge>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {sessions.map(renderSessionCard)}
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (viewMode === 'service' && sessionsData.by_service) {
      return (
        <div className="space-y-6">
          {Object.entries(sessionsData.by_service).map(([serviceType, sessions]) => (
            <div key={serviceType}>
              <h3 className="text-lg font-semibold text-base-content mb-3 flex items-center gap-2">
                <i className="fa-solid fa-cogs text-primary" />
                {serviceType.toUpperCase()}
                <Badge variant="secondary" className="ml-2">{sessions.length}</Badge>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {sessions.map(renderSessionCard)}
              </div>
            </div>
          ))}
        </div>
      );
    }

    return null;
  };

  const handleFilterChange = () => {
    setPage(1);
  };

  const headerActions = (
    <div className="flex items-center gap-2">
      {isConnected && hasLiveWebsocketSessions && (
        <div className="flex items-center gap-2 rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-green-500" />
          <span className="text-xs font-medium text-green-700 dark:text-green-400">Live</span>
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" type="button" title="More options">
            <IconDots className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            className="w-56 rounded-lg"
            align="end"
            side="bottom"
            sideOffset={8}
            collisionPadding={8}
          >
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <i className="fa-solid fa-cog fa-fw mr-2" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleManualRefresh} disabled={loading}>
              {loading ? (
                <span className="loading loading-spinner loading-xs mr-2" />
              ) : (
                <i className="fa-solid fa-sync fa-fw mr-2" />
              )}
              Refresh
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>View mode</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setViewMode('merged')}
              className={viewMode === 'merged' ? 'bg-primary/10' : ''}
            >
              <i className="fa-solid fa-layer-group fa-fw mr-2" />
              <span className="flex-1">Merged</span>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">Default</Badge>
                {viewMode === 'merged' && <i className="fa-solid fa-check fa-fw text-primary" />}
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('categorized')}
              className={viewMode === 'categorized' ? 'bg-primary/10' : ''}
            >
              <i className="fa-solid fa-server fa-fw mr-2" />
              <span className="flex-1">Categorized by Server</span>
              {viewMode === 'categorized' && <i className="fa-solid fa-check fa-fw ml-2 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('service')}
              className={viewMode === 'service' ? 'bg-primary/10' : ''}
            >
              <i className="fa-solid fa-cogs fa-fw mr-2" />
              <span className="flex-1">Categorized by Service</span>
              {viewMode === 'service' && <i className="fa-solid fa-check fa-fw ml-2 text-primary" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Streams"
        description="Monitor real-time playback across all connected media servers."
        actions={headerActions}
      />

      {/* Active Streams Section - NEW */}
      <div className="space-y-4">
        {/* Active Sessions Display */}
        <div className="bg-base-100 border border-base-300 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <i className="fa-solid fa-tower-broadcast text-primary" />
            <h2 className="text-lg font-semibold text-base-content">Active Streams</h2>
            {sessionsData && (
              <Badge variant="secondary">{sessionsData.total_count}</Badge>
            )}
          </div>
        </div>

        {bootstrapping || (loading && !sessionsData) ? (
          <div className="text-center py-12">
            <span className="loading loading-lg loading-spinner text-primary" />
            <p className="text-lg text-base-content/70 mt-4">Loading active streams...</p>
          </div>
        ) : sessionsData && sessionsData.total_count > 0 ? (
            renderActiveSessions()
          ) : (
            <div className="text-center py-12 text-base-content/60">
              <i className="fa-solid fa-circle-pause text-4xl mb-4 opacity-30" />
              <p className="text-lg">No active streams</p>
              <p className="text-sm mt-2">Streams will appear here when users start playing media</p>
            </div>
          )}
        </div>
      </div>

      {/* Historical Data Section - EXISTING */}
      <div className="divider text-base-content/60">
        <i className="fa-solid fa-history mr-2" />
        Historical Streaming Data
      </div>

      <StreamingSummaryCard />

      {summary ? (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-base-300 bg-base-100 p-4">
            <h2 className="text-sm font-semibold text-base-content/80">Daily activity</h2>
            <ul className="mt-3 space-y-1 text-xs text-base-content/80">
              {summary.daily.length === 0 ? (
                <li className="text-base-content/60">No activity in the selected range.</li>
              ) : null}
              {summary.daily.slice(-14).map((point) => (
                <li key={point.date} className="flex items-center justify-between">
                  <span>{new Date(point.date).toLocaleDateString()}</span>
                  <span className="font-medium text-base-content">{point.count}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-base-300 bg-base-100 p-4">
            <h2 className="text-sm font-semibold text-base-content/80">Streams by service</h2>
            <ul className="mt-3 space-y-2 text-sm text-base-content/80">
              {summary.by_service.length === 0 ? (
                <li className="text-base-content/60">No recent streams.</li>
              ) : null}
              {summary.by_service.map((entry) => (
                <li key={entry.service_type} className="flex items-center justify-between rounded-lg bg-base-200/40 px-3 py-2 uppercase">
                  <span className="font-medium text-base-content">{entry.service_type}</span>
                  <span className="text-base-content/70">{entry.count}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Streaming Sessions History</h1>
        <div className="flex items-center gap-3">
          <select
            className="select select-bordered select-sm"
            value={serviceType}
            onChange={(event) => {
              setServiceType(event.target.value);
              handleFilterChange();
            }}
          >
            <option value="all">All Services</option>
            <option value="plex">Plex</option>
            <option value="jellyfin">Jellyfin</option>
            <option value="emby">Emby</option>
            <option value="kavita">Kavita</option>
            <option value="audiobookshelf">Audiobookshelf</option>
            <option value="komga">Komga</option>
            <option value="romm">RomM</option>
          </select>
          <select
            className="select select-bordered select-sm"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              handleFilterChange();
            }}
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
          </select>
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="input input-bordered input-sm"
              placeholder="User UUID"
              value={userUuid}
              onChange={(event) => setUserUuid(event.target.value)}
            />
            <input
              type="date"
              className="input input-bordered input-sm"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
            <input
              type="date"
              className="input input-bordered input-sm"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                handleFilterChange();
              }}
            >
              Apply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setServiceType('all');
                setStatus('all');
                setUserUuid('');
                setStartDate('');
                setEndDate('');
                handleFilterChange();
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      </div>

      <StreamingTable
        page={page}
        serviceType={serviceType === 'all' ? undefined : serviceType}
        status={status === 'all' ? undefined : status}
        userUuid={userUuid || undefined}
        startDate={startDate || undefined}
        endDate={endDate || undefined}
        onLoadMore={() => setPage((prev) => prev + 1)}
      />

      <StreamingSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Terminate Session Modal */}
      {showTerminateModal && selectedSession && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-lg bg-base-100 border border-base-300 shadow-2xl p-0">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-base-300">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-error/20 flex items-center justify-center">
                  <i className="fa-solid fa-ban text-error text-lg" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold text-base-content">Terminate Session</h3>
                  <p className="text-sm text-base-content/60">End an active streaming session</p>
                </div>
              </div>
              <button
                className="btn btn-sm btn-circle btn-ghost hover:bg-base-200"
                onClick={() => setShowTerminateModal(false)}
              >
                <i className="fa-solid fa-times" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6">
              {/* Warning Info Card */}
              <div className="bg-base-200/50 rounded-lg p-4 mb-6 border border-base-300">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-error/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <i className="fa-solid fa-exclamation-triangle text-error text-sm" />
                  </div>
                  <div>
                    <h4 className="font-medium text-base-content mb-1">Confirm Session Termination</h4>
                    <p className="text-sm text-base-content/70 leading-relaxed">
                      Are you sure you want to terminate the session for{' '}
                      <strong>{selectedSession.user}</strong> playing{' '}
                      <strong>{selectedSession.media_title}</strong>?
                    </p>
                  </div>
                </div>
              </div>

              {/* Message Input */}
              <div className="space-y-3">
                <h4 className="font-medium text-base-content text-lg mb-3">Optional Message</h4>
                <div className="bg-base-200/30 rounded-lg p-4 border border-base-300/30 hover:border-base-300/60 transition-colors">
                  <div className="flex items-center gap-2 mb-2">
                    <i className="fa-solid fa-message text-info text-sm" />
                    <h5 className="font-medium text-base-content">Message for User</h5>
                  </div>
                  <textarea
                    className="textarea textarea-bordered w-full resize-none"
                    rows={3}
                    placeholder="e.g., Server maintenance starting soon."
                    value={terminateMessage}
                    onChange={(e) => setTerminateMessage(e.target.value)}
                  />
                  <p className="text-sm text-base-content/60 mt-2">
                    This message will be displayed to the user when their session is terminated
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-3 mt-8 pt-6 border-t border-base-300">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowTerminateModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-error gap-2"
                  onClick={handleTerminateSession}
                >
                  <i className="fa-solid fa-ban" />
                  Terminate Session
                </button>
              </div>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setShowTerminateModal(false)}>close</button>
          </form>
        </dialog>
      )}
    </div>
  );
};

export default StreamingPage;
