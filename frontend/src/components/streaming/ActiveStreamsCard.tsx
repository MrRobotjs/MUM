import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StreamingSessionCard } from './StreamingSessionCard';
import { useAdminApi } from '@/hooks/useAdminApi';
import type { ActiveSession, ActiveSessionsResponse, PluginMetaResponse, ViewMode } from '@/types/streaming';

interface ActiveStreamsCardProps {
  sessionsData: ActiveSessionsResponse | null;
  viewMode: ViewMode;
  loading: boolean;
  bootstrapping: boolean;
  wsTruthActive: boolean;
  isConnected: boolean;
  lastUpdateAt: Date | null;
  onTerminateSession: (session: ActiveSession) => void;
}

export const ActiveStreamsCard = ({
  sessionsData,
  viewMode,
  loading,
  bootstrapping,
  wsTruthActive,
  isConnected,
  lastUpdateAt,
  onTerminateSession
}: ActiveStreamsCardProps) => {
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
                <i className="fa-solid fa-server text-primary" />
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
                <i className="fa-solid fa-cogs text-primary" />
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

  const isLive = wsTruthActive && isConnected && lastUpdateAt && Date.now() - lastUpdateAt.getTime() < 5000;

  return (
    <Card className="pt-0 gap-0 overflow-hidden border border-border/60 bg-gradient-to-br from-background via-background to-muted/40 shadow-md">
      <CardHeader className="pt-6 border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-inner">
              <i className="fa-solid fa-tower-broadcast text-lg" />
            </div>
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-2xl text-foreground">
                Active Streams
                {sessionsData && <Badge variant="secondary">{sessionsData.total_count}</Badge>}
              </CardTitle>
              <CardDescription className="text-sm text-muted-foreground space-y-1">
                <p>Live playback across connected media servers.</p>
                {sessionsData && sessionsData.total_count > 0 && (() => {
                  const sessions = sessionsData.sessions;
                  const transcodeCount = sessions.filter(s => s.is_transcode_calc || s.transcode_reason || s.stream_detail.toLowerCase().includes('transcode')).length;
                  const directPlayCount = sessionsData.total_count - transcodeCount;

                  // Simple bandwidth summation (heuristic parsing)
                  const totalBandwidth = sessions.reduce((acc, s) => {
                    const match = s.bandwidth_detail?.match(/(\d+(\.\d+)?)\s*Mbps/i);
                    return acc + (match ? parseFloat(match[1]) : 0);
                  }, 0).toFixed(1);

                  // Assuming all bandwidth is LAN for now as we don't have explicit LAN/WAN separation in just 'bandwidth_detail' usually,
                  // unless 'location_type_calc' gives us a clue.
                  const lanBandwidth = sessions.reduce((acc, s) => {
                    const isWan = s.location_type_calc === 'wan' || s.location_detail.toLowerCase().includes('remote');
                    if (isWan) return acc;
                    const match = s.bandwidth_detail?.match(/(\d+(\.\d+)?)\s*Mbps/i);
                    return acc + (match ? parseFloat(match[1]) : 0);
                  }, 0).toFixed(1);

                  const wanBandwidth = (parseFloat(totalBandwidth) - parseFloat(lanBandwidth)).toFixed(1);

                  return (
                    <p className="font-mono text-xs text-primary/80">
                      Activity: Sessions: {sessionsData.total_count} stream ({directPlayCount} direct play, {transcodeCount} transcode) | Bandwidth: {totalBandwidth} Mbps (LAN: {lanBandwidth} Mbps, WAN: {wanBandwidth} Mbps)
                    </p>
                  )
                })()}
              </CardDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isLive ? (
              <Badge variant="outline" className="border-green-600 bg-green-500/10 text-xs text-green-600">
                <span className="mr-1 inline-flex h-2 w-2 animate-pulse rounded-full bg-green-500" />
                Live
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                <i className="fa-solid fa-circle text-[10px] text-muted-foreground" />
                Standby
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
            <span className="loading loading-lg loading-spinner text-primary" />
            <p className="mt-4 text-lg">Loading active streams...</p>
            <p className="text-sm">Connecting to your media servers...</p>
          </div>
        ) : sessionsData && sessionsData.total_count > 0 ? (
          renderActiveSessions()
        ) : (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/30 py-12 text-muted-foreground">
            <i className="fa-solid fa-circle-pause mb-4 text-4xl opacity-30" />
            <p className="text-lg text-foreground">No active streams</p>
            <p className="mt-2 text-sm">Streams will appear here when users start playing media</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
