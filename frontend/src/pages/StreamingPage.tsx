import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
// Images use cookie-based auth; no token param needed
import { StreamingSummaryCard, StreamingSettingsModal } from '../components/dashboard';
import {
  ActiveStreamsCard,
  StreamingHistoricalData,
  StreamingHistoryFilters,
  TerminateSessionModal
} from '../components/streaming';
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
import { IconDots } from '@tabler/icons-react';
import type { UnifiedSession } from '../types/realtime';
import type { ActiveSession, ActiveSessionsResponse, ViewMode } from '../types/streaming';

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

const mapUnifiedSessionToActiveSession = (session: UnifiedSession): ActiveSession => {
  const playback = session.playback ?? {};
  const item = session.item ?? { title: 'Unknown Title', type: 'unknown' };
  const quality = session.quality ?? {};
  const network = session.network ?? {};
  const server = session.server ?? { service: 'unknown', name: '' };
  const client = session.client ?? {};
  const user = session.user ?? { name: 'Unknown User' };

  const durationSeconds =
    playback.duration_seconds ?? parseDurationToSeconds(playback.duration_text ?? undefined);
  const positionSeconds =
    playback.position_seconds ?? parseDurationToSeconds(playback.position_text ?? undefined);

  const derivedProgress =
    durationSeconds && durationSeconds > 0
      ? Math.min(100, Math.max(0, ((positionSeconds ?? 0) / durationSeconds) * 100))
      : 0;
  const progress =
    typeof playback.progress === 'number' && Number.isFinite(playback.progress)
      ? playback.progress
      : derivedProgress;

  // Parse transcode details from stream_detail string if available
  // Expected format: "Transcode (Throttled, Speed: 3.5)" or "Transcode (Speed: 2.1)"
  let transcodeSpeed: number | undefined;
  let transcodeThrottled: boolean | undefined;

  const streamDetailStr = quality.stream || '';
  if (streamDetailStr.includes('Transcode')) {
    const speedMatch = streamDetailStr.match(/Speed:\s*([\d.]+)/i);
    if (speedMatch && speedMatch[1]) {
      transcodeSpeed = parseFloat(speedMatch[1]);
    }

    if (streamDetailStr.toLowerCase().includes('throttled')) {
      transcodeThrottled = true;
    } else {
      transcodeThrottled = false;
    }
  }

  const currentTimeText =
    playback.position_text ??
    (typeof positionSeconds === 'number' ? formatSecondsToTimestamp(positionSeconds) : undefined);
  const durationText =
    playback.duration_text ??
    (typeof durationSeconds === 'number' ? formatSecondsToTimestamp(durationSeconds) : undefined);

  const locationDetail = network.location
    ? `${network.location}${network.ip ? `: ${network.ip}` : ''}`
    : network.ip ?? '';

  return {
    session_key: session.session_id,
    user: user.name || 'Unknown User',
    user_avatar_url: user.avatar || undefined,
    mum_user_id: undefined,
    mum_user_uuid: user.uuid ? String(user.uuid) : undefined,
    media_title: item.title || 'Unknown Title',
    grandparent_title: item.grandparent_title ?? undefined,
    parent_title: item.parent_title ?? undefined,
    media_type: item.type || 'unknown',
    library_name: item.library || 'Unknown Library',
    year: item.year ? String(item.year) : undefined,
    thumb_url: item.thumb || undefined,
    service_type: server.service || 'unknown',
    server_name: server.name || '',
    player_title: client.name || undefined,
    player_platform: client.platform || undefined,
    product: client.product || undefined,
    state: session.state || 'unknown',
    progress,
    current_time: currentTimeText ?? '0:00',
    duration: durationText ?? '0:00',
    quality_detail: quality.detail || '',
    stream_detail: quality.stream || '',
    container_detail: quality.container || '',
    video_detail: quality.video || '',
    audio_detail: quality.audio || '',
    subtitle_detail: quality.subtitle || '',
    transcode_reason: quality.transcode_reason || '',
    location_detail: locationDetail,
    location_ip: network.ip ?? undefined,
    is_public_ip: network.is_public_ip ?? undefined,
    bandwidth_detail: network.bandwidth ?? undefined,
    raw_data_json: typeof session.raw === 'string' ? session.raw : undefined,
    bitrate_calc: typeof quality.bitrate === 'number' ? quality.bitrate : undefined,
    location_type_calc: network.location ?? undefined,
    is_transcode_calc:
      typeof quality.is_transcode === 'boolean' ? quality.is_transcode : undefined,
    transcode_speed: transcodeSpeed,
    transcode_throttled: transcodeThrottled,
  };
};

const buildOffsetsFromSessions = (sessions: ActiveSession[]) => {
  const offsets: Record<string, number> = {};
  for (const s of sessions) {
    if (!s.session_key) continue;
    offsets[s.session_key] = parseDurationToSeconds(s.current_time ?? '0:00');
  }
  return offsets;
};

export const StreamingPage = () => {
  const [page, setPage] = useState(1);
  const [serviceType, setServiceType] = useState('all');
  const [status, setStatus] = useState('all');
  const [userName, setUserName] = useState('');
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
  const [lastWsUpdateAt, setLastWsUpdateAt] = useState<Date | null>(null);
  const [lastHttpUpdateAt, setLastHttpUpdateAt] = useState<Date | null>(null);
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
  const applySessionSource = useCallback((sessions: ActiveSession[], source: 'ws' | 'http') => (
    sessions.map((session) => ({ ...session, source }))
  ), []);

  const applyGroupedSource = useCallback(
    (groups: Record<string, ActiveSession[]> | undefined, source: 'ws' | 'http') => {
      if (!groups) return groups;
      return Object.fromEntries(
        Object.entries(groups).map(([key, sessions]) => [key, applySessionSource(sessions, source)])
      );
    },
    [applySessionSource]
  );

  const applySourceFromLiveServices = useCallback(
    (sessions: ActiveSession[], liveServices: string[]) => {
      const liveSet = new Set(liveServices.map((service) => service.toLowerCase()));
      let hasWs = false;
      let hasHttp = false;
      const withSources = sessions.map((session) => {
        const isWs = liveSet.has(session.service_type?.toLowerCase() ?? '');
        if (isWs) {
          hasWs = true;
        } else {
          hasHttp = true;
        }
        return { ...session, source: isWs ? 'ws' : 'http' };
      });
      return { sessions: withSources, hasWs, hasHttp };
    },
    []
  );

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
        const httpSessions = applySessionSource(response.sessions ?? [], 'http');
        setActiveSessions({
          ...response,
          sessions: httpSessions,
          by_server: applyGroupedSource(response.by_server, 'http'),
          by_service: applyGroupedSource(response.by_service, 'http'),
        });
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
              lastUpdateRef.current
            ) {
              const elapsed = (fetchCompletedAt.getTime() - lastUpdateRef.current.getTime()) / 1000;
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
        setLastHttpUpdateAt(fetchCompletedAt);
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
    [wsTruthActive, applyGroupedSource, applySessionSource]
  );

  // Use WebSocket for real-time updates (like Tautulli - no polling, only websocket push)
  const { isConnected, liveServices, lastSessionData } = useStreamingWebSocket({
    autoConnect: false,
    onUpdate: (data) => {
      const updateSource = data.update_source;
      const updateLiveServices = data.update_live_services ?? [];
      const hasLiveServices = updateLiveServices.length > 0;
      const isWsUpdate = hasLiveServices || (typeof updateSource === 'string' && updateSource.includes('websocket'));
      console.debug('[StreamingPage] WS update', {
        active_count: data.active_count,
        sessions_len: Array.isArray(data.sessions) ? data.sessions.length : null,
        live_services: data.live_services,
        timestamp: data.timestamp,
        update_source: updateSource,
        update_live_services: updateLiveServices,
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
          const mappedSessions = data.sessions.map(mapUnifiedSessionToActiveSession);
          const sourceResult = applySourceFromLiveServices(mappedSessions, data.live_services ?? []);
          const now = data.timestamp ? new Date(data.timestamp) : new Date();

        // Update session offsets immediately from websocket data
        const offsets = buildOffsetsFromSessions(sourceResult.sessions);

        // ✅ IMMEDIATE UPDATE - no throttling (like Tautulli)
          setSessionOffsets(offsets);
          setLastUpdateAt(now);
          if (isWsUpdate) {
            setLastWsUpdateAt(now);
          } else if (updateSource || updateLiveServices.length > 0) {
            setLastHttpUpdateAt(now);
          }
          lastUpdateRef.current = now;
          setWsTruthActive(true);

        // Update active sessions state immediately (like Tautulli - instant websocket updates)
        // This handles both adding new sessions AND removing stopped sessions (empty array clears UI)
        // Use sessions.length as source of truth when sessions array is provided (it's the actual current state)
        setActiveSessions({
          sessions: sourceResult.sessions,
          total_count: data.active_count ?? sourceResult.sessions.length,
          by_server: {},
          by_service: {},
          meta: { request_id: '', timestamp: data.timestamp },
        });
        } else if (data.active_count !== undefined) {
          const now = data.timestamp ? new Date(data.timestamp) : new Date();
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
            setLastUpdateAt(now);
            if (isWsUpdate) {
              setLastWsUpdateAt(now);
            } else if (updateSource || updateLiveServices.length > 0) {
              setLastHttpUpdateAt(now);
            }
          } else {
            setActiveSessions((prev) => ({
              ...prev,
              total_count: data.active_count,
            }))
            setLastUpdateAt(now);
            if (isWsUpdate) {
              setLastWsUpdateAt(now);
            } else if (updateSource || updateLiveServices.length > 0) {
              setLastHttpUpdateAt(now);
            }
          }
        }
      }
    });

  // Initialize from websocket data if available (when navigating to page)
  useEffect(() => {
        if (lastSessionData && !activeSessions) {
          // Websocket already has data - use it immediately instead of showing loading
          if (Array.isArray(lastSessionData.sessions)) {
            const mappedSessions = lastSessionData.sessions.map(mapUnifiedSessionToActiveSession);
            const sourceResult = applySourceFromLiveServices(mappedSessions, lastSessionData.live_services ?? []);
            const now = lastSessionData.timestamp ? new Date(lastSessionData.timestamp) : new Date();
          const updateSource = lastSessionData.update_source;
          const updateLiveServices = lastSessionData.update_live_services ?? [];
          const hasLiveServices = updateLiveServices.length > 0;
          const isWsUpdate = hasLiveServices || (typeof updateSource === 'string' && updateSource.includes('websocket'));

        // Update session offsets
        const offsets = buildOffsetsFromSessions(sourceResult.sessions);

          setSessionOffsets(offsets);
          setLastUpdateAt(now);
          if (isWsUpdate) {
            setLastWsUpdateAt(now);
          } else if (updateSource || updateLiveServices.length > 0) {
            setLastHttpUpdateAt(now);
          }
        lastUpdateRef.current = now;
        setWsTruthActive(true);
        setBootstrapping(false);

        // Update active sessions state from websocket data
        // Use sessions.length as source of truth when sessions array is provided
        setActiveSessions({
          sessions: sourceResult.sessions,
          total_count: lastSessionData.active_count ?? sourceResult.sessions.length,
          by_server: {},
          by_service: {},
          meta: { request_id: '', timestamp: lastSessionData.timestamp },
        });
      }
    }
  }, [lastSessionData, activeSessions, applySourceFromLiveServices]);

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

  const handleClearFilters = () => {
    setServiceType('all');
    setStatus('all');
    setUserName('');
    setStartDate('');
    setEndDate('');
    handleFilterChange();
  };

  const handleFilterChange = () => {
    setPage(1);
  };

  const headerActions = (
    <div className="flex items-center gap-2">

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
              className={viewMode === 'merged' ? 'bg-accent text-accent-foreground' : ''}
            >
              <i className="fa-solid fa-layer-group fa-fw mr-2" />
              <span className="flex-1">Merged</span>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs bg-primary">Default</Badge>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('categorized')}
              className={viewMode === 'categorized' ? 'bg-accent text-accent-foreground' : ''}
            >
              <i className="fa-solid fa-server fa-fw mr-2" />
              <span className="flex-1">Categorized by Server</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('service')}
              className={viewMode === 'service' ? 'bg-accent text-accent-foreground' : ''}
            >
              <i className="fa-solid fa-cogs fa-fw mr-2" />
              <span className="flex-1">Categorized by Service</span>
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
        <ActiveStreamsCard
          sessionsData={sessionsData}
          viewMode={viewMode}
          loading={loading}
          bootstrapping={bootstrapping}
          wsTruthActive={wsTruthActive}
          isConnected={isConnected}
          lastUpdateAt={lastUpdateAt}
          lastWsUpdateAt={lastWsUpdateAt}
          lastHttpUpdateAt={lastHttpUpdateAt}
          onTerminateSession={openTerminateModal}
        />
      </div>

      {/* Historical Data Section - EXISTING */}
      <div className="divider text-muted-foreground">
        <i className="fa-solid fa-history mr-2" />
        Historical Streaming Data
      </div>

      <StreamingSummaryCard />

      <StreamingHistoricalData summary={summary} />

      <StreamingHistoryFilters
        serviceType={serviceType}
        setServiceType={setServiceType}
        status={status}
        setStatus={setStatus}
        userName={userName}
        setUserName={setUserName}
        startDate={startDate}
        setStartDate={setStartDate}
        endDate={endDate}
        setEndDate={setEndDate}
        page={page}
        onFilterChange={handleFilterChange}
        onClearFilters={handleClearFilters}
        onPageChange={setPage}
      />

      <StreamingSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <TerminateSessionModal
        open={showTerminateModal}
        session={selectedSession}
        message={terminateMessage}
        onMessageChange={setTerminateMessage}
        onClose={() => setShowTerminateModal(false)}
        onConfirm={handleTerminateSession}
      />
    </div>
  );
};

export default StreamingPage;
