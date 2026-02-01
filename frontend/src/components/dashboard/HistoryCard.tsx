import { Button } from '@/components/ui/button';
import { useAdminApi } from '../../hooks/useAdminApi';
import { DashboardCard } from './DashboardLayout';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotate } from '@fortawesome/free-solid-svg-icons';

type HistoryEntry = {
  id: number;
  timestamp: string | null;
  event_type: string | null;
  message: string;
};

type HistoryResponse = {
  data: HistoryEntry[];
};

export const HistoryCard = () => {
  const { data, loading, error, mutate } = useAdminApi<HistoryResponse>(
    '/history/recent?page=1&page_size=5'
  );

  return (
    <DashboardCard title="Recent Activity">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading history…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load history: {error}
        </div>
      ) : (
        <ul className="space-y-3 text-sm">
          {(data?.data ?? []).map((entry) => (
            <li key={entry.id} className="border-l-2 border-primary/50 pl-3">
              <p className="text-xs uppercase text-primary">
                {entry.event_type ?? 'EVENT'}
              </p>
              <p className="text-foreground">{entry.message}</p>
              {entry.timestamp ? (
                <p className="text-xs text-muted-foreground">
                  {new Date(entry.timestamp).toLocaleString()}
                </p>
              ) : null}
            </li>
          ))}
          {(data?.data?.length ?? 0) === 0 ? (
            <li className="text-xs text-muted-foreground">No recent events.</li>
          ) : null}
        </ul>
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
