import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useActiveStreamingSessions } from '@/hooks/useActiveStreamingSessions';
import { useStreamingSummary } from '@/hooks/useStreamingSummary';
import { useStreamingWebSocket } from '@/hooks/useStreamingWebSocket';
import {
  buildQualityBreakdown,
  buildServerShare,
  buildTranscodeBreakdown,
  formatDurationSeconds,
  safeBarMax,
} from '@/lib/streamingAnalytics';
import {
  BentoTile,
  BentoTileBody,
  BentoTileFooter,
  BentoTileHeader,
} from '../bento';
import { MetricBar, MetricBarSkeleton, SplitMetricBar } from '../bento/MetricBar';

const StatPill = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded-md border border-border bg-background px-3 py-2">
    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</p>
  </div>
);

const EmptyLiveHint = ({ message }: { message: string }) => (
  <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
    {message}
  </p>
);

export const StreamingOverviewWidget = () => {
  const { summary, loading: summaryLoading, error: summaryError } = useStreamingSummary();
  const { activeCount, isConnected } = useStreamingWebSocket({ autoConnect: false });
  const {
    sessions: liveSessions,
    loading: liveLoading,
    error: liveError,
  } = useActiveStreamingSessions();

  const counts = summary?.counts;
  const duration = summary?.duration;
  const serverShare = buildServerShare(summary?.by_server ?? []);
  const transcode = buildTranscodeBreakdown(liveSessions);
  const qualityBreakdown = buildQualityBreakdown(liveSessions);
  const qualityMax = safeBarMax(qualityBreakdown.map((item) => item.count));
  const serverMax = safeBarMax(serverShare.map((item) => item.count));

  const liveLoadingState = liveLoading && liveSessions.length === 0;
  const summaryLoadingState = summaryLoading && !summary;

  return (
    <BentoTile span={{ col: 6, mdCol: 6 }} label="Streaming overview">
      <BentoTileHeader
        title="Streaming overview"
        description="Historical volume plus live transcode and quality snapshot."
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
            Live
          </span>
        }
        action={
          <Button asChild variant="outline" size="sm" className="h-8 text-xs">
            <Link to="/admin/streaming">Details</Link>
          </Button>
        }
      />

      <BentoTileBody className="gap-5">
        {summaryError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Failed to load streaming summary.
          </div>
        ) : null}

        {summaryLoadingState ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-14 animate-pulse rounded-md border border-border bg-muted" />
            ))}
          </div>
        ) : summary ? (
          <>
            {(counts?.total ?? 0) === 0 ? (
              <EmptyLiveHint message="No stream history yet — metrics will populate after the first playback session." />
            ) : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatPill label="Active" value={activeCount} />
            <StatPill label="Completed" value={counts?.completed ?? 0} />
            <StatPill label="Avg session" value={formatDurationSeconds(duration?.average_seconds ?? 0)} />
            <StatPill label="Total watch" value={formatDurationSeconds(duration?.total_seconds ?? 0)} />
            </div>
          </>
        ) : null}

        <section className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Transcode vs direct play</h3>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Live snapshot</span>
          </div>

          {liveError ? (
            <p className="text-xs text-destructive">Could not load live session analytics.</p>
          ) : liveLoadingState ? (
            <MetricBarSkeleton rows={2} />
          ) : transcode.total === 0 ? (
            <EmptyLiveHint message="No active streams — transcode metrics appear when someone is watching." />
          ) : (
            <SplitMetricBar
              leftLabel="Direct play"
              leftValue={transcode.directPlay}
              leftPercent={transcode.directPercent}
              rightLabel="Transcode"
              rightValue={transcode.transcode}
              rightPercent={transcode.transcodePercent}
            />
          )}
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Stream quality</h3>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Live</span>
            </div>

            {liveLoadingState ? (
              <MetricBarSkeleton rows={4} />
            ) : qualityBreakdown.length === 0 ? (
              <EmptyLiveHint message="No active streams — quality buckets appear during playback." />
            ) : (
              <div className="space-y-3">
                {qualityBreakdown.map((item) => (
                  <MetricBar
                    key={item.label}
                    label={item.label}
                    value={item.count}
                    max={qualityMax}
                    suffix={transcode.total > 0 ? 'sessions' : undefined}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Server share</h3>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">All time</span>
            </div>

            {summaryLoadingState ? (
              <MetricBarSkeleton rows={4} />
            ) : serverShare.length === 0 ? (
              <EmptyLiveHint message="No stream history recorded yet." />
            ) : (
              <div className="space-y-3">
                {serverShare.slice(0, 6).map((server) => (
                  <MetricBar
                    key={`${server.server_name}-${server.service_type}`}
                    label={`${server.server_name} (${server.service_type})`}
                    value={server.count}
                    max={serverMax}
                    suffix={`${server.percent}%`}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </BentoTileBody>

      <BentoTileFooter>
        <p className="text-xs text-muted-foreground">
          {summary
            ? `${counts?.total ?? 0} total streams in history`
            : 'Streaming analytics unavailable'}
          {transcode.total > 0 ? ` · ${transcode.total} live session${transcode.total === 1 ? '' : 's'}` : ''}
        </p>
      </BentoTileFooter>
    </BentoTile>
  );
};
