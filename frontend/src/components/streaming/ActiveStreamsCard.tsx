import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StreamingSessionCard } from './StreamingSessionCard';

type ActiveSession = {
  session_key: string;
  user: string;
  user_avatar_url?: string;
  mum_user_id?: number;
  media_title: string;
  grandparent_title?: string;
  parent_title?: string;
  media_type: string;
  library_name: string;
  year?: string;
  thumb_url?: string;
  service_type: string;
  server_name: string;
  player_title?: string;
  player_platform?: string;
  product?: string;
  state: string;
  progress: number;
  current_time: string;
  duration: string;
  quality_detail: string;
  stream_detail: string;
  container_detail?: string;
  video_detail?: string;
  audio_detail?: string;
  subtitle_detail?: string;
  transcode_reason?: string;
  location_detail: string;
  location_ip?: string;
  is_public_ip?: boolean;
  bandwidth_detail?: string;
  raw_data_json?: string;
  bitrate_calc?: number;
  location_type_calc?: string;
  is_transcode_calc?: boolean;
};

type ActiveSessionsResponse = {
  sessions: ActiveSession[];
  total_count: number;
  by_server?: Record<string, ActiveSession[]>;
  by_service?: Record<string, ActiveSession[]>;
};

type ViewMode = 'merged' | 'categorized' | 'service';

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
  const renderSessionCard = (session: ActiveSession) => (
    <StreamingSessionCard
      key={session.session_key}
      session={session}
      onTerminate={onTerminateSession}
    />
  );

  const renderActiveSessions = () => {
    if (!sessionsData) return null;

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

  return (
    <Card className="shadow-sm gap-0">
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
        {(bootstrapping && !wsTruthActive && !sessionsData) || (loading && !sessionsData) ? (
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
  );
};
