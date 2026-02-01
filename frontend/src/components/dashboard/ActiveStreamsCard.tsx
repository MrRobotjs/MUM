import { Button } from '@/components/ui/button';
import { useAdminApi } from '../../hooks/useAdminApi';
import { DashboardCard } from './DashboardLayout';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotate } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '@/components/ui/spinner'

type ActiveStreamsResponse = {
  data: {
    count: number;
    sessions: Array<{
      id?: string;
      title?: string;
      user?: {
        name?: string;
      };
      server?: {
        name?: string;
        service_type?: string;
      };
      progress_percent?: number;
      state?: string;
    }>;
  };
};

export const ActiveStreamsCard = () => {
  const { data, loading, error, mutate } = useAdminApi<ActiveStreamsResponse>('/streams/active');

  return (
    <DashboardCard title="Active Streams">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4 text-primary" />
          Checking active sessions…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load active streams: {error}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-4xl font-bold text-primary">{data?.data.count ?? 0}</p>
          <div className="space-y-2">
            {(data?.data.sessions ?? []).map((session, index) => (
              <div key={session.id ?? index} className="rounded-lg border bg-muted/50 px-3 py-2 text-sm">
                <p className="font-medium">{session.title ?? 'Unknown media'}</p>
                <p className="text-xs text-muted-foreground">
                  {session.user?.name ?? 'Unknown user'} • {session.server?.name ?? 'Unknown server'}
                </p>
                {typeof session.progress_percent === 'number' ? (
                  <div className="mt-1 h-1 rounded bg-muted">
                    <div
                      className="h-1 rounded bg-primary"
                      style={{ width: `${Math.min(100, Math.max(0, session.progress_percent))}%` }}
                    />
                  </div>
                ) : null}
              </div>
            ))}
            {(data?.data.sessions?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">No current sessions.</p>
            ) : null}
          </div>
        </div>
      )}

      <div className="flex justify-end pt-4">
        <Button variant="ghost" size="sm" onClick={() => mutate()}>
          <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>
    </DashboardCard>
  );
};
