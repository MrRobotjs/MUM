import clsx from 'clsx';
import { useStreamingSummary } from '../../hooks/useStreamingSummary';
import { useStreamingWebSocket } from '../../hooks/useStreamingWebSocket';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Link } from '@tanstack/react-router';

const countCardClasses = ['bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300', 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300', 'bg-muted text-foreground'];

const formatDuration = (seconds: number) => {
  if (!seconds) return '0m';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

export const StreamingSummaryCard = () => {
  const { summary, loading, error } = useStreamingSummary();

  // Use WebSocket for real-time active session count updates
  const { activeCount, isConnected, liveServices } = useStreamingWebSocket({
    autoConnect: true,
  });

  const counts = summary?.counts;
  const duration = summary?.duration;
  const daily = summary?.daily ?? [];
  const perService = summary?.by_service ?? [];
  const liveServiceSet = new Set(liveServices.map((service) => service.toLowerCase()));
  const showLiveBadge =
    isConnected &&
    perService.some((entry) =>
      entry.service_type ? liveServiceSet.has(entry.service_type.toLowerCase()) : false
    );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-xl flex items-center gap-2">
              Streaming Overview
              {showLiveBadge && (
                <span className="inline-flex h-2 w-2 rounded-full bg-green-500 animate-pulse" title="Live updates connected" />
              )}
            </CardTitle>
            <CardDescription>Recent stream activity across all connected services.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/streaming">View details</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading streaming metrics…</p>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load streaming summary.
          </div>
        ) : null}

        {summary ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {[
                  { label: 'Active', value: activeCount, live: true },
                  { label: 'Completed', value: counts?.completed ?? 0, live: false },
                  { label: 'Total', value: counts?.total ?? 0, live: false }
                ].map((metric, index) => (
                  <div
                    key={metric.label}
                    className={clsx('rounded-xl px-4 py-3', countCardClasses[index] ?? 'bg-muted text-foreground')}
                  >
                    <p className="text-xs uppercase">{metric.label}</p>
                    <p className="text-2xl font-semibold">{metric.value}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border bg-muted/50 p-4">
                <h3 className="text-sm font-semibold text-foreground/80">Watch time</h3>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Total</dt>
                    <dd className="font-medium text-foreground">{formatDuration(duration?.total_seconds ?? 0)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Average per stream</dt>
                    <dd className="font-medium text-foreground">{formatDuration(duration?.average_seconds ?? 0)}</dd>
                  </div>
                </dl>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border bg-muted/50 p-4">
                <h3 className="text-sm font-semibold text-foreground/80">By service</h3>
                <ul className="mt-3 space-y-2 text-sm">
                  {perService.length === 0 ? <li className="text-muted-foreground">No recent streams.</li> : null}
                  {perService.map((entry) => (
                    <li key={entry.service_type} className="flex items-center justify-between rounded-lg border bg-background/50 px-3 py-2">
                      <span className="font-medium uppercase text-foreground">{entry.service_type}</span>
                      <span className="text-foreground/80">{entry.count}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border bg-muted/50 p-4">
                <h3 className="text-sm font-semibold text-foreground/80">Daily streams</h3>
                <ul className="mt-3 space-y-1 text-xs">
                  {daily.length === 0 ? <li className="text-muted-foreground">No activity in the selected range.</li> : null}
                  {daily.slice(-7).map((point) => (
                    <li key={point.date} className="flex items-center justify-between">
                      <span>{new Date(point.date).toLocaleDateString()}</span>
                      <span className="font-medium text-foreground">{point.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default StreamingSummaryCard;
