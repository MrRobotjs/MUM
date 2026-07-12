import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useServers } from '@/hooks/useServers';
import { useStreamingWebSocket } from '@/hooks/useStreamingWebSocket';
import { BentoTile, BentoTileBody, BentoTileFooter, BentoTileHeader } from '../bento';

const formatProgress = (value?: number) => {
  if (typeof value !== 'number') return null;
  return Math.min(100, Math.max(0, value));
};

export const LiveStreamsWidget = () => {
  const { servers, loading: serversLoading } = useServers({ activeOnly: true });
  const {
    activeCount,
    isConnected,
    lastSessionData,
    lastUpdate,
  } = useStreamingWebSocket({
    autoConnect: true,
    servers,
  });

  const sessions = lastSessionData?.sessions ?? [];
  const visibleSessions = sessions.slice(0, 6);

  return (
    <BentoTile span={{ col: 7, row: 2, mdCol: 6 }} label="Active streams">
      <BentoTileHeader
        title="Active streams"
        description="Live playback sessions across connected services."
        badge={
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
              isConnected
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : 'border-border bg-muted text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                isConnected ? 'bg-emerald-400' : 'bg-muted-foreground',
              )}
            />
            {isConnected ? 'Live' : 'Offline'}
          </span>
        }
        action={
          <Button asChild variant="outline" size="sm" className="h-8 text-xs">
            <Link to="/admin/streaming">Open streaming</Link>
          </Button>
        }
      />

      <BentoTileBody className="gap-4">
        <div className="flex items-end gap-3">
          <p className="text-4xl font-semibold tabular-nums tracking-tight text-foreground">
            {activeCount}
          </p>
          <p className="pb-1 text-sm text-muted-foreground">
            {activeCount === 1 ? 'session now' : 'sessions now'}
          </p>
        </div>

        {serversLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Connecting to services…
          </div>
        ) : visibleSessions.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            No active playback right now.
          </div>
        ) : (
          <ul className="space-y-2">
            {visibleSessions.map((session, index) => {
              const progress = formatProgress(session.playback?.progress);
              const title = session.item?.title ?? 'Unknown media';

              return (
                <li
                  key={session.session_id ?? `${title}-${index}`}
                  className="rounded-md border border-border bg-background px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{title}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {session.user?.name ?? 'Unknown user'}
                        {' · '}
                        {session.server?.name ?? session.server?.service ?? 'Unknown server'}
                      </p>
                    </div>
                    {session.state ? (
                      <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {session.state}
                      </span>
                    ) : null}
                  </div>
                  {progress !== null ? (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </BentoTileBody>

      <BentoTileFooter>
        <p className="text-xs text-muted-foreground">
          {lastUpdate
            ? `Updated ${lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
            : 'Waiting for socket updates'}
        </p>
        {sessions.length > visibleSessions.length ? (
          <p className="text-xs text-muted-foreground">
            +{sessions.length - visibleSessions.length} more
          </p>
        ) : null}
      </BentoTileFooter>
    </BentoTile>
  );
};
