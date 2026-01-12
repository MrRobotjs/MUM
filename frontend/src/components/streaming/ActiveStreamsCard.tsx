import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StreamingSessionCard } from './StreamingSessionCard';
import { StreamingSourceInfoDialog } from './StreamingSourceInfoDialog';
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

                  // Bandwidth summation:
                  // - Legacy Flask UI used `bitrate_calc` (kbps) -> Mbps, and `location_type_calc` (LAN/WAN).
                  // - `bandwidth_detail` is often a descriptive string (e.g. "Streaming via LAN") and may not contain Mbps.
                  const getSessionBandwidthMbps = (session: ActiveSession) => {
                    const bitrateKbps = session.bitrate_calc;
                    if (typeof bitrateKbps === 'number' && Number.isFinite(bitrateKbps) && bitrateKbps > 0) {
                      return bitrateKbps / 1000;
                    }
                    const match = session.bandwidth_detail?.match(/(\d+(\.\d+)?)\s*Mbps/i);
                    return match ? parseFloat(match[1]) : 0;
                  };

                  const isLanSession = (session: ActiveSession) => {
                    const locationType = String(session.location_type_calc ?? '').trim().toLowerCase();
                    if (locationType === 'lan') return true;
                    if (locationType === 'wan') return false;
                    if (locationType.includes('lan')) return true;
                    if (locationType.includes('wan')) return false;
                    if (typeof session.is_public_ip === 'boolean') return !session.is_public_ip;
                    const detail = String(session.location_detail ?? '').toLowerCase();
                    if (detail.includes('remote')) return false;
                    if (detail.includes('wan')) return false;
                    if (detail.includes('lan')) return true;
                    return true;
                  };

                  const totalBandwidthValue = sessions.reduce((acc, s) => acc + getSessionBandwidthMbps(s), 0);
                  const lanBandwidthValue = sessions.reduce(
                    (acc, s) => (isLanSession(s) ? acc + getSessionBandwidthMbps(s) : acc),
                    0
                  );
                  const wanBandwidthValue = sessions.reduce(
                    (acc, s) => (!isLanSession(s) ? acc + getSessionBandwidthMbps(s) : acc),
                    0
                  );

                  const totalBandwidth = totalBandwidthValue.toFixed(1);
                  const lanBandwidth = lanBandwidthValue.toFixed(1);
                  const wanBandwidth = wanBandwidthValue.toFixed(1);

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
