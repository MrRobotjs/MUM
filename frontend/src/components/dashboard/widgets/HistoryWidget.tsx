import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotate } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRecentStreams } from '@/hooks/useRecentStreams';
import { formatMediaTypeLabel, formatTimeAgo } from '@/lib/timeFormat';
import {
  BentoTile,
  BentoTileBody,
  BentoTileFooter,
  BentoTileHeader,
} from '../bento';

const HistoryRowSkeleton = ({ rows = 6 }: { rows?: number }) => (
  <div className="space-y-2">
    {Array.from({ length: rows }).map((_, index) => (
      <div
        key={index}
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border py-3 last:border-b-0"
      >
        <div className="space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 w-40 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-3 w-12 animate-pulse rounded bg-muted" />
      </div>
    ))}
  </div>
);

export const HistoryWidget = () => {
  const { streams, pagination, loading, error, refresh } = useRecentStreams({ pageSize: 8 });

  return (
    <BentoTile span={{ col: 6, mdCol: 6 }} label="Recent stream log">
      <BentoTileHeader
        title="Stream log"
        description="Latest playback events across all connected services."
        action={
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => refresh()}
              disabled={loading}
            >
              <FontAwesomeIcon icon={faRotate} className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
            <Button asChild variant="outline" size="sm" className="h-8 text-xs">
              <Link to="/admin/streaming">All streams</Link>
            </Button>
          </div>
        }
      />

      <BentoTileBody className="p-0">
        {error ? (
          <div className="px-5 py-4">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Failed to load stream history: {error}
            </div>
          </div>
        ) : loading && streams.length === 0 ? (
          <div className="px-5 py-2">
            <HistoryRowSkeleton />
          </div>
        ) : streams.length === 0 ? (
          <div className="px-5 py-8">
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              No playback history recorded yet.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {streams.map((stream) => {
              const referenceTime = stream.stopped_at ?? stream.started_at;
              const typeLabel = formatMediaTypeLabel(stream.media_type);
              const serverLabel = stream.server_name ?? 'Unknown server';
              const platformLabel = stream.platform ?? 'Unknown platform';
              const isActive = !stream.stopped_at;

              return (
                <li
                  key={stream.id}
                  className="grid grid-cols-1 gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="font-medium text-foreground">
                        {stream.user_display_name ?? 'Unknown user'}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <span className="truncate font-medium text-foreground">
                        {stream.media_title ?? 'Untitled media'}
                      </span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {typeLabel}
                      </span>
                      {isActive ? (
                        <span className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                          Live
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {serverLabel} · {platformLabel}
                    </p>
                  </div>

                  <p className="shrink-0 text-xs tabular-nums text-muted-foreground sm:text-right">
                    {isActive ? 'Now' : formatTimeAgo(referenceTime)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </BentoTileBody>

      {pagination ? (
        <BentoTileFooter>
          <p className="text-xs text-muted-foreground">
            Showing {streams.length} of {pagination.total_items} stream events
          </p>
        </BentoTileFooter>
      ) : null}
    </BentoTile>
  );
};
