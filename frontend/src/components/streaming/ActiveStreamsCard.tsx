import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { StreamingSessionCard } from './StreamingSessionCard';
import { StreamingSourceInfoDialog } from './StreamingSourceInfoDialog';
import { useAdminApi } from '@/hooks/useAdminApi';
import type { ActiveSession, ActiveSessionsResponse, PluginMetaResponse, ViewMode } from '@/types/streaming';
import { getStreamingSessionStats } from './sessionStats';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCirclePause, faCogs, faServer, faTowerBroadcast } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '@/components/ui/spinner'

interface ActiveStreamsCardProps {
  sessionsData: ActiveSessionsResponse | null;
  viewMode: ViewMode;
  loading: boolean;
  bootstrapping: boolean;
  wsTruthActive: boolean;
  isConnected: boolean;
  lastUpdateAt: Date | null;
  lastWsUpdateAt: Date | null;
  lastHttpUpdateAt: Date | null;
  sessionMonitoringInterval: number | null;
  onTerminateSession: (session: ActiveSession) => void;
}

export const ActiveStreamsCard = ({
  sessionsData,
  viewMode,
  loading,
  bootstrapping,
  wsTruthActive,
  lastUpdateAt,
  lastHttpUpdateAt,
  sessionMonitoringInterval,
  onTerminateSession
}: ActiveStreamsCardProps) => {
  const [showSourceInfo, setShowSourceInfo] = useState(false);
  const { data: pluginMetaData } = useAdminApi<PluginMetaResponse>('/plugins/metadata', true);
  const pluginFeaturesByService = pluginMetaData?.data ?? null;

  const renderSessionCard = (session: ActiveSession) => (
    <StreamingSessionCard
      key={session.session_key}
      session={session}
      onTerminate={onTerminateSession}
      pluginFeaturesByService={pluginFeaturesByService}
    />
  );

  const renderActiveSessions = () => {
    if (!sessionsData) return null;

    if (viewMode === 'merged') {
      return (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {sessionsData.sessions.map(renderSessionCard)}
        </div>
      );
    }

    if (viewMode === 'categorized' && sessionsData.by_server) {
      return (
        <div className="space-y-6">
          {Object.entries(sessionsData.by_server).map(([serverName, sessions]) => (
            <div key={serverName}>
              <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">
                <FontAwesomeIcon icon={faServer} className="text-primary" />
                {serverName}
                <Badge variant="secondary" className="ml-2">{sessions.length}</Badge>
              </h3>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
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
              <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">
                <FontAwesomeIcon icon={faCogs} className="text-primary" />
                {serviceType.toUpperCase()}
                <Badge variant="secondary" className="ml-2">{sessions.length}</Badge>
              </h3>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
                {sessions.map(renderSessionCard)}
              </div>
            </div>
          ))}
        </div>
      );
    }

    return null;
  };

  const httpIntervalSeconds =
    typeof sessionMonitoringInterval === 'number' && sessionMonitoringInterval > 0
      ? sessionMonitoringInterval
      : null;
  const httpCountdown = (() => {
    if (!httpIntervalSeconds || !lastHttpUpdateAt) return null;
    const elapsed = Math.max(0, Math.floor((Date.now() - lastHttpUpdateAt.getTime()) / 1000));
    const remaining = Math.max(0, httpIntervalSeconds - elapsed);
    return `${remaining}s`;
  })();

  return (
    <Card className="pt-0 gap-0 overflow-hidden border border-border/60 shadow-md">
      <StreamingSourceInfoDialog open={showSourceInfo} onOpenChange={setShowSourceInfo} />
      <CardHeader className="pt-6 border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-inner">
              <FontAwesomeIcon icon={faTowerBroadcast} className="text-lg" />
            </div>
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-2xl text-foreground">
                Active Streams
                {sessionsData && <Badge variant="secondary">{sessionsData.total_count}</Badge>}
              </CardTitle>
              <CardDescription className="text-sm text-muted-foreground space-y-1">
                <p>Live playback across connected media servers.</p>
                {sessionsData && sessionsData.total_count > 0 && (() => {
                  const stats = getStreamingSessionStats(sessionsData.sessions);
                  const totalBandwidth = stats.totalBandwidthMbps.toFixed(1);
                  const lanBandwidth = stats.lanBandwidthMbps.toFixed(1);
                  const wanBandwidth = stats.wanBandwidthMbps.toFixed(1);

                  return (
                    <p className="font-mono text-xs text-primary/80">
                      Activity: Sessions: {stats.totalSessions} stream ({stats.directPlayCount} direct play, {stats.transcodeCount} transcode) | Bandwidth: {totalBandwidth} Mbps (LAN: {lanBandwidth} Mbps, WAN: {wanBandwidth} Mbps)
                    </p>
                  )
                })()}
              </CardDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {httpCountdown && (
              <Badge
                asChild
                variant="outline"
                className="text-xs border-sky-500/40 text-sky-600 cursor-pointer hover:bg-sky-500/10"
              >
                <button
                  type="button"
                  onClick={() => setShowSourceInfo(true)}
                  aria-label="Explain WS and HTTP stream badges"
                >
                  HTTP next {httpCountdown}
                </button>
              </Badge>
            )}
            {lastUpdateAt && (
              <Badge variant="secondary" className="text-xs">
                Updated {lastUpdateAt.toLocaleTimeString()}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-5">
        {/* Only show loading if we truly don't have data yet and websocket hasn't provided any */}
        {(bootstrapping && !wsTruthActive && !sessionsData) || (loading && !sessionsData) ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/30 py-12 text-muted-foreground">
            <Spinner className="size-6 text-primary" />
            <p className="mt-4 text-lg">Loading active streams...</p>
            <p className="text-sm">Connecting to your media servers...</p>
          </div>
        ) : sessionsData && sessionsData.total_count > 0 ? (
          renderActiveSessions()
        ) : (
          <Empty className="border border-dashed border-border/60 bg-muted/30 py-10 sm:py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FontAwesomeIcon icon={faCirclePause} className="text-xl opacity-70" />
              </EmptyMedia>
              <EmptyTitle>No active streams</EmptyTitle>
              <EmptyDescription className="max-w-xs text-pretty">
                Streams will appear here when users start playing media.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
};
