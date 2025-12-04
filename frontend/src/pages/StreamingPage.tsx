import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
// Images use cookie-based auth; no token param needed
import { StreamingTable, StreamingSummaryCard, StreamingSettingsModal } from '../components/dashboard';
import { useServers } from '../hooks/useServers';
import { useStreamingSettings } from '../hooks/useStreamingSettings';
import { useStreamingSummary } from '../hooks/useStreamingSummary';
import { useStreamingWebSocket } from '../hooks/useStreamingWebSocket';
import { PageHeader } from '../components';
import { Button } from '@/components/ui/button';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts/AlertContext';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Textarea } from '@/components/ui/textarea';
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

  const { success, error: showError } = useAlerts();
  const liveServicesRef = useRef<string[]>([]);
  const lastUpdateRef = useRef<Date | null>(null);
  const [wsTruthActive, setWsTruthActive] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);

  // HTTP fetch only for initial bootstrap and manual refresh (like Tautulli - no polling)
  const fetchActiveSessions = useCallback(
    async (options?: { silent?: boolean; force?: boolean; reason?: 'manual' | 'initial' }) => {
      // Skip HTTP fetch if websocket is active and providing recent updates (< 5s)
      if (wsTruthActive && lastUpdateRef.current) {
        const timeSinceLastUpdate = Date.now() - lastUpdateRef.current.getTime()
        if (timeSinceLastUpdate < 5000) {
          // Websocket is providing fresh data - no HTTP fetch needed (like Tautulli)
          return;
        }
      }
      
      const silent = options?.silent ?? false;
      const force = options?.force ?? false;
      
      // Only fetch if forced (manual refresh) or initial bootstrap
      if (!force && silent && lastUpdateRef.current) {
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
        const response = await requestJson<ActiveSessionsResponse>('/admin/api/v2/streaming/active');
        setActiveSessions(response);
        const fetchCompletedAt = new Date();
        // no-op debug removed
        const liveServicesCurrent = new Set(['plex', ...liveServicesRef.current]);
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
                  // no-op debug removed
                }
              }
            }

            offsets[key] = value;
          });
          return offsets;
        });
        setLastUpdateAt(fetchCompletedAt);
        lastUpdateRef.current = fetchCompletedAt;
      } catch (error) {
        console.error('Failed to fetch active sessions:', error);
      } finally {
        if (!silent) {
          setLoading(false);
        }
        setBootstrapping(false);
      }
    },
    [wsTruthActive]
  );

  // Use WebSocket for real-time updates (like Tautulli - no polling, only websocket push)
  const { isConnected, liveServices, lastSessionData } = useStreamingWebSocket({
    autoConnect: true,
    servers: mediaServers,
    onUpdate: (data: any) => {
      console.debug('[StreamingPage] WS update', {
        active_count: data.active_count,
        sessions_len: Array.isArray(data.sessions) ? data.sessions.length : null,
        live_services: data.live_services,
        timestamp: data.timestamp,
      });
      // Update live services list
      if (Array.isArray(data.live_services)) {
        liveServicesRef.current = data.live_services.map((service) =>
          String(service).toLowerCase()
        );
      }
      
      // ✅ ACCEPT WEBSOCKET UPDATES IMMEDIATELY (like Tautulli)
      // Handle sessions array (even if empty - this clears stopped streams from UI)
      if (Array.isArray(data.sessions)) {
        // Guard against transient empty payloads with no count (avoid clearing paused sessions)
        if (data.sessions.length === 0 && data.active_count === undefined) {
          return;
        }
        const now = new Date()
        
        // Update session offsets immediately from websocket data
        const offsets: Record<string, number> = {}
        for (const s of data.sessions as Array<{ session_key: string; current_time?: string }>) {
          if (!s.session_key) continue
          offsets[s.session_key] = parseDurationToSeconds(s.current_time ?? '0:00')
        }
        
        // ✅ IMMEDIATE UPDATE - no throttling (like Tautulli)
        setSessionOffsets(offsets)
        setLastUpdateAt(now)
        lastUpdateRef.current = now
        setWsTruthActive(true)
        
        // Update active sessions state immediately (like Tautulli - instant websocket updates)
        // This handles both adding new sessions AND removing stopped sessions (empty array clears UI)
        // Use sessions.length as source of truth when sessions array is provided (it's the actual current state)
        setActiveSessions({
          sessions: data.sessions,
          total_count: data.active_count ?? data.sessions.length,
          by_server: {},
          by_service: {},
          meta: { request_id: '', timestamp: data.timestamp },
        })
      } else if (data.active_count !== undefined) {
        // Even without session data, update count immediately
        // If active_count is 0 and we have no sessions array, clear sessions
        if (data.active_count === 0) {
          setActiveSessions({
            sessions: [],
            total_count: 0,
            by_server: {},
            by_service: {},
          })
          setSessionOffsets({})
        } else {
          setActiveSessions((prev) => ({
            ...prev,
            total_count: data.active_count,
          }))
        }
      }
    }
  });

  // Initialize from websocket data if available (when navigating to page)
  useEffect(() => {
      if (lastSessionData && !activeSessions) {
        // Websocket already has data - use it immediately instead of showing loading
        if (Array.isArray(lastSessionData.sessions)) {
          const now = new Date()
          
          // Update session offsets
          const offsets: Record<string, number> = {}
          for (const s of lastSessionData.sessions as Array<{ session_key: string; current_time?: string }>) {
          if (!s.session_key) continue
          offsets[s.session_key] = parseDurationToSeconds(s.current_time ?? '0:00')
        }
        
        setSessionOffsets(offsets)
        setLastUpdateAt(now)
        lastUpdateRef.current = now
        setWsTruthActive(true)
        setBootstrapping(false)
        
        // Update active sessions state from websocket data
        // Use sessions.length as source of truth when sessions array is provided
        setActiveSessions({
          sessions: lastSessionData.sessions,
          total_count: lastSessionData.active_count ?? lastSessionData.sessions.length,
          by_server: {},
          by_service: {},
          meta: { request_id: '', timestamp: lastSessionData.timestamp },
        })
      }
    }
  }, [lastSessionData, activeSessions]);

  // Fetch initial data when websocket connects (if we don't have data yet)
  useEffect(() => {
    if (isConnected && !activeSessions && !bootstrapping) {
      // Websocket connected but no data yet - fetch initial state
      fetchActiveSessions({ silent: true, reason: 'initial', force: true });
    }
  }, [isConnected, activeSessions, bootstrapping, fetchActiveSessions]);

  useEffect(() => {
    liveServicesRef.current = liveServices;
  }, [liveServices]);

  // Consider Plex as a live service by default so interpolation works even before first WS payload
  const liveServiceSet = useMemo(
    () => new Set(['plex', ...liveServices.map((service) => service.toLowerCase())]),
    [liveServices]
  );

  // Bootstrap: if no WS data arrives after connection, do a one-time HTTP fetch
  useEffect(() => {
    const t = window.setTimeout(() => {
      // Only fetch if websocket connected but no data received yet
      if (isConnected && !lastUpdateRef.current && !wsTruthActive) {
        fetchActiveSessions({ silent: false, reason: 'initial', force: true });
      }
    }, 2000) // Reduced to 2s since websocket should connect quickly
    return () => window.clearTimeout(t)
  }, [isConnected, wsTruthActive, fetchActiveSessions])

  useEffect(() => {
    // Drive a lightweight animation tick so we can advance "playing" sessions locally
    // between source-of-truth refreshes. Using requestAnimationFrame avoids timer clamping
    // in background tabs and provides smoother updates while still only committing once/sec.
    let rafId: number | null = null
    let lastSecondEmitted = -1

    const loop = () => {
      const nowSec = Math.floor(Date.now() / 1000)
      if (nowSec !== lastSecondEmitted) {
        lastSecondEmitted = nowSec
        forceTick((prev) => prev + 1)
      }
      rafId = window.requestAnimationFrame(loop)
    }

    rafId = window.requestAnimationFrame(loop)

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [])


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



  // Debug: log ticking and interpolation context every 5 seconds
  useEffect(() => {
    if (!activeSessions) return
    if (tick % 5 !== 0) return
    const playingLive = activeSessions.sessions.filter((s) => {
      const st = s.service_type?.toLowerCase() || ''
      return (st === 'plex' || liveServiceSet.has(st)) && s.state?.toLowerCase() === 'playing'
    }).length
    const baselineSec = lastUpdateAt ? Math.round((Date.now() - lastUpdateAt.getTime()) / 1000) : 0
    // no-op debug removed
  }, [tick, activeSessions, lastUpdateAt, sessionOffsets, liveServiceSet])

  const hasLiveWebsocketSessions = Boolean(
    sessionsData?.sessions?.some((session) =>
      session.service_type ? liveServiceSet.has(session.service_type.toLowerCase()) : false
    )
  );


  const handleTerminateSession = async () => {
    if (!selectedSession) return;

    try {
      await requestJson('/admin/api/v2/streaming/terminate', {
        method: 'POST',
        body: JSON.stringify({
          session_key: selectedSession.session_key,
          service_type: selectedSession.service_type,
          server_name: selectedSession.server_name,
          message: terminateMessage
        })
      });

      success(`Session for ${selectedSession.user} has been terminated`);

      setShowTerminateModal(false);
      setSelectedSession(null);
      setTerminateMessage('');
      fetchActiveSessions();
    } catch (error) {
      showError('Failed to terminate session: ' + String(error));
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
          default: return 'bg-muted';
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
            <Button
              variant="destructive"
              size="icon"
              className="h-7 w-7 rounded-full"
              onClick={() => openTerminateModal(session)}
              title="Terminate Session"
            >
              <i className="fa-solid fa-times text-sm" />
            </Button>
          </div>

          <div className="card-body p-3">
            {/* Main Flex Container: Poster | Details */}
            <div className="flex items-start space-x-3">
              {/* Poster Column */}
              <div className="avatar flex-shrink-0">
                <div className="w-30 h-45 rounded">
                  {session.thumb_url ? (
                    <img
                      src={session.thumb_url || ''}
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
                    className="w-full h-full bg-muted flex flex-col items-center justify-center text-xs text-muted-foreground"
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
                  <p className="text-foreground/80 flex items-center" title={session.user}>
                    {session.user_avatar_url ? (
                      <div className="avatar avatar-xs mr-1.5">
                        <div className="w-4 h-4 rounded-full">
                          <img
                            src={session.user_avatar_url || ''}
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
                    <span className="link link-hover text-blue-600 dark:text-blue-400" title="User">
                      {session.user}
                    </span>
                  </p>

                  {/* Player */}
                  <p className="text-muted-foreground flex items-center" title={`${session.player_title} (${session.player_platform} via ${session.product})`}>
                    <i className="fa-solid fa-play fa-fw mr-1.5 text-blue-600 dark:text-blue-400 w-4 text-center" />
                    <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Player:</span>
                    {session.player_title}{' '}
                    <span className="text-muted-foreground ml-1">
                      ({session.product !== session.player_title ? session.product : session.player_platform})
                    </span>
                  </p>

                  {/* Media/Library */}
                  <p className="text-muted-foreground flex items-center">
                    <i className="fa-solid fa-tv fa-fw mr-1.5 text-blue-600 dark:text-blue-400 w-4 text-center" />
                    <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Media/Library:</span>
                    {session.media_type} on {session.library_name}
                  </p>

                  {/* Quality */}
                  <p className="text-muted-foreground flex items-center" title={`Quality: ${session.quality_detail}`}>
                    <i className="fa-solid fa-sliders fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                    <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Quality:</span>
                    <span>{session.quality_detail}</span>
                  </p>

                  {/* Stream */}
                  <p className="text-muted-foreground flex items-center" title={`Stream: ${session.stream_detail}`}>
                    <i className="fa-solid fa-wifi fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                    <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Stream:</span>
                    <span className={`font-medium ${session.stream_detail?.includes('Transcode') ? 'text-orange-400' : 'text-green-400'}`}>
                      {session.stream_detail}
                    </span>
                    {session.stream_detail?.includes('Transcode') && session.transcode_reason && (
                      <i className="fa-solid fa-info-circle ml-1 text-orange-400/80" title={`Reason: ${session.transcode_reason}`} />
                    )}
                  </p>

                  {/* Container */}
                  {session.container_detail && (
                    <p className="text-muted-foreground flex items-center" title={`Container: ${session.container_detail}`}>
                      <i className="fa-solid fa-box-archive fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                      <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Container:</span>
                      <span>{session.container_detail}</span>
                    </p>
                  )}

                  {/* Video */}
                  {session.video_detail && (
                    <p className="text-muted-foreground flex items-center" title={`Video: ${session.video_detail}`}>
                      <i className="fa-solid fa-film fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                      <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Video:</span>
                      <span>{session.video_detail}</span>
                    </p>
                  )}

                  {/* Audio */}
                  {session.audio_detail && (
                    <p className="text-muted-foreground flex items-center" title={`Audio: ${session.audio_detail}`}>
                      <i className="fa-solid fa-volume-high fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                      <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Audio:</span>
                      <span>{session.audio_detail}</span>
                    </p>
                  )}

                  {/* Subtitle */}
                  {session.subtitle_detail && (
                    <p className="text-muted-foreground flex items-center" title={`Subtitle: ${session.subtitle_detail}`}>
                      <i className="fa-solid fa-closed-captioning fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                      <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Subtitle:</span>
                      <span>{session.subtitle_detail}</span>
                    </p>
                  )}

                  {/* Location */}
                  <p className="text-muted-foreground flex items-center" title={`Location: ${session.location_detail}`}>
                    <i className="fa-solid fa-location-dot fa-fw w-4 mr-1.5 text-blue-600 dark:text-blue-400 text-center" />
                    <span className="font-medium mr-1 text-blue-600 dark:text-blue-400">Location:</span>
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
                        ? 'text-green-600 dark:text-green-400'
                        : session.state?.toLowerCase() === 'paused'
                        ? 'text-amber-600 dark:text-amber-400'
                        : session.state?.toLowerCase() === 'buffering'
                        ? 'text-blue-600 dark:text-blue-400'
                        : 'text-muted-foreground'
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
                <span className="text-xs text-muted-foreground">
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
                {session.year && <span className="text-xs font-normal text-muted-foreground">({session.year})</span>}
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
              <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
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
              <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
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
        <Card className="shadow-sm">
          <CardHeader className="pb-0">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <i className="fa-solid fa-tower-broadcast" />
                </div>
                <div>
                  <CardTitle className="flex items-center gap-2 text-xl text-foreground">
                    Active Streams
                    {sessionsData && <Badge variant="secondary">{sessionsData.total_count}</Badge>}
                  </CardTitle>
                  <CardDescription>Live playback across connected media servers.</CardDescription>
                </div>
              </div>
              {wsTruthActive && isConnected && lastUpdateAt && Date.now() - lastUpdateAt.getTime() < 5000 ? (
                <Badge variant="outline" className="border-green-600 text-xs text-green-600">
                  <span className="mr-1 inline-flex h-2 w-2 animate-pulse rounded-full bg-green-500" />
                  Live
                </Badge>
              ) : null}
            </div>
          </CardHeader>

          <CardContent className="pt-4">
            {/* Only show loading if we truly don't have data yet and websocket hasn't provided any */}
            {(bootstrapping && !wsTruthActive && !activeSessions) || (loading && !sessionsData) ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <span className="loading loading-lg loading-spinner text-primary" />
                <p className="mt-4 text-lg">Loading active streams...</p>
              </div>
            ) : sessionsData && sessionsData.total_count > 0 ? (
              renderActiveSessions()
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <i className="fa-solid fa-circle-pause mb-4 text-4xl opacity-30" />
                <p className="text-lg text-foreground">No active streams</p>
                <p className="mt-2 text-sm">Streams will appear here when users start playing media</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Historical Data Section - EXISTING */}
      <div className="divider text-muted-foreground">
        <i className="fa-solid fa-history mr-2" />
        Historical Streaming Data
      </div>

      <StreamingSummaryCard />

      {summary ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-semibold">Daily activity</CardTitle>
              <CardDescription>Recent stream counts by day.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs text-foreground/80">
                {summary.daily.length === 0 ? (
                  <li className="text-muted-foreground">No activity in the selected range.</li>
                ) : null}
                {summary.daily.slice(-14).map((point) => (
                  <li
                    key={point.date}
                    className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2"
                  >
                    <span>{new Date(point.date).toLocaleDateString()}</span>
                    <span className="font-medium text-foreground">{point.count}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-semibold">Streams by service</CardTitle>
              <CardDescription>Breakdown of streams per media service.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-foreground/80">
                {summary.by_service.length === 0 ? (
                  <li className="text-muted-foreground">No recent streams.</li>
                ) : null}
                {summary.by_service.map((entry) => (
                  <li
                    key={entry.service_type}
                    className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2 uppercase"
                  >
                    <span className="font-medium text-foreground">{entry.service_type}</span>
                    <span className="text-muted-foreground">{entry.count}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-xl">Streaming Sessions History</CardTitle>
              <CardDescription>Filter and review recent streaming sessions.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">Service</span>
              <Select
                value={serviceType}
                onValueChange={(value) => {
                  setServiceType(value);
                  handleFilterChange();
                }}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="All Services" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Services</SelectItem>
                  <SelectItem value="plex">Plex</SelectItem>
                  <SelectItem value="jellyfin">Jellyfin</SelectItem>
                  <SelectItem value="emby">Emby</SelectItem>
                  <SelectItem value="kavita">Kavita</SelectItem>
                  <SelectItem value="audiobookshelf">Audiobookshelf</SelectItem>
                  <SelectItem value="komga">Komga</SelectItem>
                  <SelectItem value="romm">RomM</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">Status</span>
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value);
                  handleFilterChange();
                }}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">User UUID</span>
              <Input
                type="text"
                placeholder="User UUID"
                value={userUuid}
                onChange={(event) => setUserUuid(event.target.value)}
                className="h-9"
              />
            </div>

            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">Start date</span>
              <Input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="h-9"
              />
            </div>

            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">End date</span>
              <Input
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="h-9"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
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

          <StreamingTable
            page={page}
            serviceType={serviceType === 'all' ? undefined : serviceType}
            status={status === 'all' ? undefined : status}
            userUuid={userUuid || undefined}
            startDate={startDate || undefined}
            endDate={endDate || undefined}
            onLoadMore={() => setPage((prev) => prev + 1)}
          />
        </CardContent>
      </Card>

      <StreamingSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ResponsiveDialog
        open={showTerminateModal && Boolean(selectedSession)}
        onOpenChange={(value) => {
          if (!value) setShowTerminateModal(false);
        }}
        title="Terminate Session"
        description="End an active streaming session."
        contentClassName="max-w-lg"
        footer={[
          <Button key="cancel" variant="outline" onClick={() => setShowTerminateModal(false)}>
            Cancel
          </Button>,
          <Button key="terminate" variant="destructive" onClick={handleTerminateSession} className="gap-2">
            <i className="fa-solid fa-ban" />
            Terminate Session
          </Button>,
        ]}
      >
        {selectedSession ? (
          <div className="space-y-6">
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/20">
                  <i className="fa-solid fa-exclamation-triangle text-destructive" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-base font-semibold text-foreground">Confirm Session Termination</h4>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Are you sure you want to terminate the session for <strong>{selectedSession.user}</strong> playing{' '}
                    <strong>{selectedSession.media_title}</strong>?
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <i className="fa-solid fa-message text-blue-600 dark:text-blue-400 text-sm" />
                <h5 className="text-base font-semibold text-foreground">Optional Message</h5>
              </div>
              <Textarea
                rows={3}
                placeholder="e.g., Server maintenance starting soon."
                value={terminateMessage}
                onChange={(e) => setTerminateMessage(e.target.value)}
                className="resize-none"
              />
              <p className="text-sm text-muted-foreground">
                This message will be displayed to the user when their session is terminated.
              </p>
            </div>
          </div>
        ) : null}
      </ResponsiveDialog>
    </div>
  );
};

export default StreamingPage;
