import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation } from '@tanstack/react-router';
// Images use cookie-based auth; no token param needed
import { StreamingSummaryCard, StreamingSettingsModal } from '../components/dashboard';
import {
  ActiveStreamsCard,
  StreamingSessionsMap,
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
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear, faLayerGroup, faServer, faGears, faHistory, faEllipsis, faRotate } from '@fortawesome/free-solid-svg-icons';
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
  const media = session.media ?? {};

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

  const rawPayload =
    typeof session.raw === 'string'
      ? session.raw
      : session.raw && typeof session.raw === 'object'
        ? JSON.stringify(session.raw)
        : undefined;

  return {
    session_key: session.session_id,
    user: user.name || 'Unknown User',
    user_avatar_url: user.avatar || undefined,
    mum_user_id: undefined,
    mum_user_uuid: user.uuid ? String(user.uuid) : undefined,
    media_title: item.title || 'Unknown Title',
    grandparent_title: item.grandparent_title ?? undefined,
    parent_title: item.parent_title ?? undefined,
    edition: item.edition ?? undefined,
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
    latitude:
      typeof network.latitude === 'number' && Number.isFinite(network.latitude)
        ? network.latitude
        : undefined,
    longitude:
      typeof network.longitude === 'number' && Number.isFinite(network.longitude)
        ? network.longitude
        : undefined,
    is_public_ip: network.is_public_ip ?? undefined,
    bandwidth_detail: network.bandwidth ?? undefined,
    raw_data_json: rawPayload,
    bitrate_calc: typeof quality.bitrate === 'number' ? quality.bitrate : undefined,
    location_type_calc: network.location ?? undefined,
    is_transcode_calc:
      typeof quality.is_transcode === 'boolean' ? quality.is_transcode : undefined,
    transcode_speed: transcodeSpeed,
    transcode_throttled: transcodeThrottled,
    media_path: media.path ?? undefined,
    media_duration:
      typeof media.duration_ms === 'number' ? media.duration_ms : undefined,
    media_bitrate:
      typeof media.bitrate_kbps === 'number' ? media.bitrate_kbps : undefined,
    media_width: typeof media.width === 'number' ? media.width : undefined,
    media_height: typeof media.height === 'number' ? media.height : undefined,
    media_aspect_ratio:
      typeof media.aspect_ratio === 'string' ? media.aspect_ratio : undefined,
    media_audio_channels:
      typeof media.audio_channels === 'number' ? media.audio_channels : undefined,
    media_audio_codec:
      typeof media.audio_codec === 'string' ? media.audio_codec : undefined,
    media_video_codec:
      typeof media.video_codec === 'string' ? media.video_codec : undefined,
    media_video_resolution:
      typeof media.video_resolution === 'string' || typeof media.video_resolution === 'number'
        ? String(media.video_resolution)
        : undefined,
    media_container:
      typeof media.container === 'string' ? media.container : undefined,
    media_video_frame_rate:
      typeof media.video_frame_rate === 'string' || typeof media.video_frame_rate === 'number'
        ? String(media.video_frame_rate)
        : undefined,
    media_video_profile:
      typeof media.video_profile === 'string' ? media.video_profile : undefined,
    media_has_voice_activity:
      typeof media.has_voice_activity === 'boolean' ||
      typeof media.has_voice_activity === 'number' ||
      typeof media.has_voice_activity === 'string'
        ? media.has_voice_activity
        : undefined,
    media_author: typeof media.author === 'string' ? media.author : undefined,
    media_publisher:
      typeof media.publisher === 'string' ? media.publisher : undefined,
    media_isbn: typeof media.isbn === 'string' ? media.isbn : undefined,
    media_genres: typeof media.genres === 'string' ? media.genres : undefined,
    media_chapter_title:
      typeof media.chapter_title === 'string' ? media.chapter_title : undefined,
    media_chapter_index:
      typeof media.chapter_index === 'number' ? media.chapter_index : undefined,
    media_chapter_count:
      typeof media.chapter_count === 'number' ? media.chapter_count : undefined,
    media_player: typeof media.player === 'string' ? media.player : undefined,
    media_abridged:
      typeof media.abridged === 'boolean' ? media.abridged : undefined,
    media_explicit:
      typeof media.explicit === 'boolean' ? media.explicit : undefined,
    media_language:
      typeof media.language === 'string' ? media.language : undefined,
    media_series: typeof media.series === 'string' ? media.series : undefined,
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

const groupSessionsBy = (
  sessions: ActiveSession[],
  key: 'server_name' | 'service_type'
) => {
  const grouped: Record<string, ActiveSession[]> = {};
  sessions.forEach((session) => {
    const groupKey = String(session[key] ?? 'Unknown');
    if (!grouped[groupKey]) {
      grouped[groupKey] = [];
    }
    grouped[groupKey].push(session);
  });
  return grouped;
};

const mergeSessions = (primary: ActiveSession[], secondary: ActiveSession[]) => {
  const merged = new Map<string, ActiveSession>();
  const add = (session: ActiveSession) => {
    const key = `${session.service_type ?? 'unknown'}:${session.server_name ?? 'unknown'}:${session.session_key}`;
    if (!merged.has(key)) {
      merged.set(key, session);
    }
  };
  primary.forEach(add);
  secondary.forEach(add);
  return Array.from(merged.values());
};

const buildSessionKey = (session: ActiveSession) =>
  `${session.service_type ?? 'unknown'}:${session.server_name ?? 'unknown'}:${session.session_key}`;

export const StreamingPage = () => {
  const [page, setPage] = useState(1);
  const [serviceType, setServiceType] = useState('all');
  const [status, setStatus] = useState('all');
  const [userName, setUserName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const { summary } = useStreamingSummary();
  const location = useLocation();
  const { servers: mediaServers, refresh: refreshServers } = useServers({ activeOnly: true });
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

  const allowedServerSnapshot = useMemo(() => {
    const serverNames = new Set<string>();
    const serviceTypes = new Set<string>();
    mediaServers.forEach((server) => {
      if (server.service_type) {
        serviceTypes.add(server.service_type.toLowerCase());
      }
      if (server.server_nickname) {
        serverNames.add(server.server_nickname.toLowerCase());
      }
      if (server.server_name) {
        serverNames.add(server.server_name.toLowerCase());
      }
    });
    return { serverNames, serviceTypes };
  }, [mediaServers]);

  const allowedServersKey = useMemo(() => {
    const typeKey = Array.from(allowedServerSnapshot.serviceTypes).sort().join('|');
    const nameKey = Array.from(allowedServerSnapshot.serverNames).sort().join('|');
    return `${typeKey}::${nameKey}`;
  }, [allowedServerSnapshot]);

  const filterSessionsForServers = useCallback(
    (sessions: ActiveSession[]) => {
      if (!allowedServerSnapshot.serviceTypes.size) {
        return [];
      }
      return sessions.filter((session) => {
        const serviceType = session.service_type?.toLowerCase() ?? '';
        if (!allowedServerSnapshot.serviceTypes.has(serviceType)) {
          return false;
        }
        if (!allowedServerSnapshot.serverNames.size) {
          return true;
        }
        const serverName = session.server_name?.toLowerCase() ?? '';
        return allowedServerSnapshot.serverNames.has(serverName);
      });
    },
    [allowedServerSnapshot]
  );

  useEffect(() => {
    if (location.pathname.startsWith('/admin/streaming')) {
      refreshServers();
    }
  }, [location.pathname, refreshServers]);

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
  const [manualRefreshLoading, setManualRefreshLoading] = useState(false);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);

  const { success, error: showError, warning: showWarning } = useAlerts();
  const liveServicesRef = useRef<string[]>([]);
  const httpOnlySessionsRef = useRef<ActiveSession[]>([]);
  const lastUpdateRef = useRef<Date | null>(null);
  const [wsTruthActive, setWsTruthActive] = useState(false);
  const websocketServiceTypes = useMemo(() => new Set(['plex', 'emby', 'jellyfin']), []);
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

  const applyAudiobookshelfPlaybackState = useCallback(
    (sessions: ActiveSession[], _options?: { mode?: 'manual' | 'auto' }) => sessions,
    []
  );

  const fetchActiveSessions = useCallback(
    async (options?: {
      silent?: boolean;
      force?: boolean;
      reason?: 'manual' | 'initial';
      httpOnly?: boolean;
    }) => {
      const silent = options?.silent ?? false;
      const force = options?.force ?? false;
      const httpOnly = options?.httpOnly ?? false;

      // Skip HTTP fetch if websocket is active and providing recent updates (< 5s)
      if (!force && wsTruthActive && lastUpdateRef.current) {
        const timeSinceLastUpdate = Date.now() - lastUpdateRef.current.getTime()
        if (timeSinceLastUpdate < 5000) {
          // Websocket is providing fresh data - no HTTP fetch needed (like Tautulli)
          return;
        }
      }

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
        const requestPath = httpOnly
          ? '/api/v2/streaming/active?http_only=1'
          : '/api/v2/streaming/active';
        const response = await requestJson<ActiveSessionsResponse>(requestPath);
        const sampleMode = options?.reason === 'manual' ? 'manual' : 'auto';
        const httpSessions = applyAudiobookshelfPlaybackState(
          applySessionSource(response.sessions ?? [], 'http'),
          { mode: sampleMode }
        );
        const nonWebsocketSessions = httpSessions.filter(
          (session) => !websocketServiceTypes.has(session.service_type?.toLowerCase() ?? '')
        );
        httpOnlySessionsRef.current = nonWebsocketSessions;
        const filteredHttpSessions = httpOnly ? nonWebsocketSessions : httpSessions;

        if (httpOnly) {
          setActiveSessions((prev) => {
            const preservedSessions = prev?.sessions?.filter((session) =>
              websocketServiceTypes.has(session.service_type?.toLowerCase() ?? '')
            ) ?? [];
            const mergedSessions = mergeSessions(preservedSessions, filteredHttpSessions);
            return {
              sessions: mergedSessions,
              total_count: mergedSessions.length,
              by_server: groupSessionsBy(mergedSessions, 'server_name'),
              by_service: groupSessionsBy(mergedSessions, 'service_type'),
              meta: response.meta,
            };
          });
        } else {
        setActiveSessions({
          ...response,
          sessions: httpSessions,
          by_server: applyGroupedSource(response.by_server, 'http'),
          by_service: applyGroupedSource(response.by_service, 'http'),
          });
        }
        const fetchCompletedAt = new Date();
        // no-op debug removed
        const liveServicesCurrent = new Set(['plex', ...liveServicesRef.current]);
        if (!httpOnly) {
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
          lastUpdateRef.current = fetchCompletedAt;
        }
      } catch (error) {
        console.error('Failed to fetch active sessions:', error);
      } finally {
        if (!silent) {
          setLoading(false);
        }
        setBootstrapping(false);
      }
    },
    [
      wsTruthActive,
      applyGroupedSource,
      applySessionSource,
      applyAudiobookshelfPlaybackState,
      websocketServiceTypes,
    ]
  );

  // Use WebSocket for real-time updates (like Tautulli - no polling, only websocket push)
  const { isConnected, liveServices, lastSessionData } = useStreamingWebSocket({
    autoConnect: false,
    onUpdate: (data) => {
      const updateSource = data.update_source;
      const updateLiveServices = data.update_live_services ?? [];
      const hasLiveServices = updateLiveServices.length > 0;
      const isWsUpdate = hasLiveServices || (typeof updateSource === 'string' && updateSource.includes('websocket'));
      const updateChannel = data.update_channel;
      const updateSourceNormalized =
        typeof updateSource === 'string' && updateSource.trim()
          ? updateSource.toLowerCase()
          : typeof updateChannel === 'string' && updateChannel.includes('.')
            ? updateChannel.split('.')[0].toLowerCase()
            : '';
      const summarySource =
        typeof data.summary?.update_source === 'string'
          ? data.summary.update_source.toLowerCase()
          : '';
      const isManualRefresh = summarySource === 'manual_refresh';
      const isManualHttpSnapshot = updateSourceNormalized === 'http';
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
          const nonWebsocketSessions = sourceResult.sessions.filter(
            (session) => !websocketServiceTypes.has(session.service_type?.toLowerCase() ?? '')
          );
          httpOnlySessionsRef.current = nonWebsocketSessions;
          const mergedSessions = mergeSessions(sourceResult.sessions, httpOnlySessionsRef.current);
          const mergedSessionsWithState = applyAudiobookshelfPlaybackState(mergedSessions);
          const now = data.timestamp ? new Date(data.timestamp) : new Date();

        // Update session offsets immediately from websocket data
        const offsets = buildOffsetsFromSessions(sourceResult.sessions);

        // ✅ IMMEDIATE UPDATE - no throttling (like Tautulli)
          setSessionOffsets(offsets);
          setLastUpdateAt(now);
          if (isWsUpdate) {
            setLastWsUpdateAt(now);
          } else if (!isManualHttpSnapshot && !isManualRefresh && (updateSource || updateLiveServices.length > 0)) {
            setLastHttpUpdateAt(now);
          }
          lastUpdateRef.current = now;
          setWsTruthActive(true);

        // Update active sessions state immediately (like Tautulli - instant websocket updates)
        // This handles both adding new sessions AND removing stopped sessions (empty array clears UI)
        // Use sessions.length as source of truth when sessions array is provided (it's the actual current state)
        setActiveSessions({
          sessions: mergedSessionsWithState,
          total_count: mergedSessionsWithState.length,
          by_server: groupSessionsBy(mergedSessionsWithState, 'server_name'),
          by_service: groupSessionsBy(mergedSessionsWithState, 'service_type'),
          meta: { request_id: '', timestamp: data.timestamp },
        });
        } else if (data.active_count !== undefined) {
          const now = data.timestamp ? new Date(data.timestamp) : new Date();
          // Even without session data, update count immediately
          // If active_count is 0 and we have no sessions array, clear sessions
          if (data.active_count === 0) {
            const preservedSessions = httpOnlySessionsRef.current;
            setActiveSessions({
              sessions: preservedSessions,
              total_count: preservedSessions.length,
              by_server: groupSessionsBy(preservedSessions, 'server_name'),
              by_service: groupSessionsBy(preservedSessions, 'service_type'),
            })
            setSessionOffsets({})
            setLastUpdateAt(now);
            if (isWsUpdate) {
              setLastWsUpdateAt(now);
            } else if (!isManualHttpSnapshot && !isManualRefresh && (updateSource || updateLiveServices.length > 0)) {
              setLastHttpUpdateAt(now);
            }
          } else {
            setActiveSessions((prev) => {
              const previousSessions = prev?.sessions ?? [];
            const mergedSessions = mergeSessions(previousSessions, httpOnlySessionsRef.current);
            return {
              ...(prev ?? {}),
              sessions: mergedSessions,
                total_count: mergedSessions.length,
                by_server: groupSessionsBy(mergedSessions, 'server_name'),
                by_service: groupSessionsBy(mergedSessions, 'service_type'),
              };
            })
            setLastUpdateAt(now);
            if (isWsUpdate) {
              setLastWsUpdateAt(now);
            } else if (!isManualHttpSnapshot && !isManualRefresh && (updateSource || updateLiveServices.length > 0)) {
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
            const nonWebsocketSessions = sourceResult.sessions.filter(
              (session) => !websocketServiceTypes.has(session.service_type?.toLowerCase() ?? '')
            );
            const updateSource = lastSessionData.update_source;
            const updateLiveServices = lastSessionData.update_live_services ?? [];
            const hasLiveServices = updateLiveServices.length > 0;
            const isWsUpdate = hasLiveServices || (typeof updateSource === 'string' && updateSource.includes('websocket'));
            const updateChannel = lastSessionData.update_channel;
            const updateSourceNormalized =
              typeof updateSource === 'string' && updateSource.trim()
                ? updateSource.toLowerCase()
                : typeof updateChannel === 'string' && updateChannel.includes('.')
                  ? updateChannel.split('.')[0].toLowerCase()
                  : '';
            const summarySource =
              typeof lastSessionData.summary?.update_source === 'string'
                ? lastSessionData.summary.update_source.toLowerCase()
                : '';
            const isManualRefresh = summarySource === 'manual_refresh';
            const isManualHttpSnapshot = updateSourceNormalized === 'http';
            httpOnlySessionsRef.current = nonWebsocketSessions;
            const mergedSessions = mergeSessions(sourceResult.sessions, httpOnlySessionsRef.current);
            const mergedSessionsWithState = applyAudiobookshelfPlaybackState(mergedSessions);
            const now = lastSessionData.timestamp ? new Date(lastSessionData.timestamp) : new Date();

        // Update session offsets
        const offsets = buildOffsetsFromSessions(sourceResult.sessions);

          setSessionOffsets(offsets);
            setLastUpdateAt(now);
            if (isWsUpdate) {
              setLastWsUpdateAt(now);
            } else if (!isManualHttpSnapshot && !isManualRefresh && (updateSource || updateLiveServices.length > 0)) {
              setLastHttpUpdateAt(now);
            }
        lastUpdateRef.current = now;
        setWsTruthActive(true);
        setBootstrapping(false);

        // Update active sessions state from websocket data
        // Use sessions.length as source of truth when sessions array is provided
        setActiveSessions({
          sessions: mergedSessionsWithState,
          total_count: mergedSessionsWithState.length,
          by_server: groupSessionsBy(mergedSessionsWithState, 'server_name'),
          by_service: groupSessionsBy(mergedSessionsWithState, 'service_type'),
          meta: { request_id: '', timestamp: lastSessionData.timestamp },
        });
      }
    }
  }, [lastSessionData, activeSessions, applySourceFromLiveServices, applyAudiobookshelfPlaybackState]);

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

  useEffect(() => {
    httpOnlySessionsRef.current = filterSessionsForServers(httpOnlySessionsRef.current);

    if (!activeSessions) {
      return;
    }

    const filteredSessions = filterSessionsForServers(activeSessions.sessions);
    const sameLength = filteredSessions.length === activeSessions.sessions.length;
    if (sameLength) {
      const currentKeys = new Set(activeSessions.sessions.map(buildSessionKey));
      const filteredKeys = new Set(filteredSessions.map(buildSessionKey));
      if (
        currentKeys.size === filteredKeys.size &&
        Array.from(currentKeys).every((key) => filteredKeys.has(key))
      ) {
        return;
      }
    }

    setActiveSessions({
      ...activeSessions,
      sessions: filteredSessions,
      total_count: filteredSessions.length,
      by_server: groupSessionsBy(filteredSessions, 'server_name'),
      by_service: groupSessionsBy(filteredSessions, 'service_type'),
    });

    setSessionOffsets((prev) => {
      const next: Record<string, number> = {};
      filteredSessions.forEach((session) => {
        const key = session.session_key;
        if (key in prev) {
          next[key] = prev[key];
        }
      });
      return next;
    });

    if (filteredSessions.length === 0) {
      setSelectedSession(null);
      setShowTerminateModal(false);
      setTerminateMessage('');
    }
  }, [activeSessions, allowedServersKey, filterSessionsForServers]);

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

  const baseSessionsData = interpolatedSessions ?? activeSessions;

  useEffect(() => {
    if (!baseSessionsData?.sessions) {
      return;
    }
    const nextKeys = baseSessionsData.sessions.map(buildSessionKey);
    setSessionOrder((prev) => {
      const prevSet = new Set(prev);
      const nextSet = new Set(nextKeys);
      const filteredPrev = prev.filter((key) => nextSet.has(key));
      const additions = nextKeys.filter((key) => !prevSet.has(key));
      const merged = [...filteredPrev, ...additions];
      if (merged.length === prev.length && merged.every((key, index) => key === prev[index])) {
        return prev;
      }
      return merged;
    });
  }, [baseSessionsData]);

  const sessionsData = useMemo(() => {
    if (!baseSessionsData) {
      return baseSessionsData;
    }
    const byKey = new Map<string, ActiveSession>();
    baseSessionsData.sessions.forEach((session) => {
      byKey.set(buildSessionKey(session), session);
    });
    const orderedSessions: ActiveSession[] = [];
    const seen = new Set<string>();
    sessionOrder.forEach((key) => {
      const session = byKey.get(key);
      if (session) {
        orderedSessions.push(session);
        seen.add(key);
      }
    });
    baseSessionsData.sessions.forEach((session) => {
      const key = buildSessionKey(session);
      if (!seen.has(key)) {
        orderedSessions.push(session);
        seen.add(key);
      }
    });
    return {
      ...baseSessionsData,
      sessions: orderedSessions,
      total_count: orderedSessions.length,
      by_server: groupSessionsBy(orderedSessions, 'server_name'),
      by_service: groupSessionsBy(orderedSessions, 'service_type'),
    };
  }, [baseSessionsData, sessionOrder]);



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
      const serviceType = selectedSession.service_type?.toLowerCase() ?? '';
      await requestJson('/api/v2/streaming/terminate', {
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
      if (serviceType === 'audiobookshelf') {
        // ABS is HTTP-only; force a refresh even if websockets are active.
        fetchActiveSessions({ force: true, httpOnly: true, reason: 'manual' });
      } else {
        fetchActiveSessions();
      }
    } catch (error) {
      showError('Failed to terminate session: ' + String(error));
    }
  };

  const handleManualRefresh = async () => {
    if (manualRefreshLoading) return;
    if (!isConnected) {
      showWarning('Realtime streaming updates are disconnected. Refresh is unavailable.');
      return;
    }
    setManualRefreshLoading(true);
    try {
      await requestJson('/api/v2/streaming/refresh', { method: 'POST' });
    } catch (error) {
      showError('Failed to refresh sessions: ' + String(error));
    } finally {
      setManualRefreshLoading(false);
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
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={handleManualRefresh}
        disabled={manualRefreshLoading || !isConnected}
        title={isConnected ? 'Refresh HTTP-only services' : 'Realtime streaming updates are disconnected'}
      >
        <FontAwesomeIcon icon={faRotate} className={`h-4 w-4 ${manualRefreshLoading ? 'animate-spin' : ''}`} />
        <span className="ml-2">Refresh HTTP</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" type="button" title="More options">
            <FontAwesomeIcon icon={faEllipsis} className="h-4 w-4" />
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
              <FontAwesomeIcon icon={faGear} fixedWidth className="mr-2" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>View mode</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setViewMode('merged')}
              className={viewMode === 'merged' ? 'bg-accent text-accent-foreground' : ''}
            >
              <FontAwesomeIcon icon={faLayerGroup} fixedWidth className="mr-2" />
              <span className="flex-1">Merged</span>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs bg-primary">Default</Badge>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('categorized')}
              className={viewMode === 'categorized' ? 'bg-accent text-accent-foreground' : ''}
            >
              <FontAwesomeIcon icon={faServer} fixedWidth className="mr-2" />
              <span className="flex-1">Categorized by Server</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('service')}
              className={viewMode === 'service' ? 'bg-accent text-accent-foreground' : ''}
            >
              <FontAwesomeIcon icon={faGears} fixedWidth className="mr-2" />
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
          sessionMonitoringInterval={streamingSettings?.session_monitoring_interval ?? null}
          onTerminateSession={openTerminateModal}
        />
      </div>

      <div className="space-y-4">
        <StreamingSessionsMap sessions={sessionsData?.sessions ?? []} />
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
