import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAdminApi } from '../../hooks/useAdminApi';
import { DashboardCard } from './DashboardLayout';
import { IconRefresh, IconEye } from '@tabler/icons-react';

type ServerStatusResponse = {
  data: {
    summary: {
      total_servers: number;
      online: number;
      offline: number;
    };
    servers: Array<{
      id: number;
      name: string;
      online: boolean;
      service_type: string;
      version?: string;
      error_message?: string;
    }>;
  };
  meta: {
    generated_at: string;
  };
};

type ServerStatusCardProps = {
  onViewAll?: () => void;
};

export const ServerStatusCard = ({ onViewAll }: ServerStatusCardProps = {}) => {
  const { data, loading, error, mutate } = useAdminApi<ServerStatusResponse>('/server-status');

  const summary = data?.data.summary;
  const servers = data?.data.servers ?? [];

  return (
    <DashboardCard title="Server Health">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading server status…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load server status: {error}
        </div>
      ) : summary ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Total</p>
              <p className="text-3xl font-bold text-primary">{summary.total_servers}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Online</p>
              <p className="text-3xl font-bold text-green-600 dark:text-green-500">{summary.online}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Offline</p>
              <p className="text-3xl font-bold text-destructive">{summary.offline}</p>
            </div>
          </div>

          <div className="space-y-2">
            {servers.slice(0, 5).map((server) => (
              <div
                key={server.id}
                className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2"
              >
                <span className="font-medium">
                  {server.name}{' '}
                  <span className="text-xs uppercase text-muted-foreground">({server.service_type})</span>
                </span>
                <Badge variant={server.online ? 'success' : 'error'}>
                  {server.online ? 'Online' : 'Offline'}
                </Badge>
              </div>
            ))}
            {servers.length > 5 ? (
              <p className="text-xs text-muted-foreground">
                Showing first 5 of {servers.length} servers. View the servers page for more details.
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No server data available.</p>
      )}

      <div className="flex items-center justify-between pt-4">
        <Button variant="ghost" size="sm" onClick={() => mutate()}>
          <IconRefresh className="mr-2 h-4 w-4" />
          Refresh
        </Button>
        {onViewAll ? (
          <Button variant="ghost" size="sm" onClick={onViewAll}>
            <IconEye className="mr-2 h-4 w-4" />
            View All
          </Button>
        ) : null}
      </div>
    </DashboardCard>
  );
};
