import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAdminApi } from '../../hooks/useAdminApi';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotate, faEye, faServer } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
    <Card>
      <CardHeader>
        <CardTitle>Server Health</CardTitle>
      </CardHeader>
      <CardContent>
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
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm space-y-1">
                <p className="text-sm text-muted-foreground">Total</p>
                <p className="text-3xl font-bold text-primary">{summary.total_servers}</p>
              </div>
              <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm space-y-1">
                <p className="text-sm text-muted-foreground">Online</p>
                <p className="text-3xl font-bold text-green-600 dark:text-green-500">{summary.online}</p>
              </div>
              <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm space-y-1">
                <p className="text-sm text-muted-foreground">Offline</p>
                <p className="text-3xl font-bold text-destructive">{summary.offline}</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {servers.map((server) => (
                <div
                  key={server.id}
                  className="flex flex-col justify-between rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <div className="rounded-md bg-primary/10 p-2 text-primary">
                          <FontAwesomeIcon icon={faServer} className="h-4 w-4" />
                        </div>
                        <span className="font-semibold">{server.name}</span>
                      </div>
                      <Badge variant={server.online ? 'default' : 'destructive'}>
                        {server.online ? 'Online' : 'Offline'}
                      </Badge>
                    </div>

                    <div className="space-y-1 text-sm text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <span>Type:</span>
                        <span className="font-medium text-foreground">{server.service_type}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Version:</span>
                        <span className="font-medium text-foreground">{server.version ?? 'N/A'}</span>
                      </div>
                    </div>
                  </div>

                  {server.error_message && (
                    <div className="mt-3 rounded bg-destructive/10 p-2 text-xs text-destructive">
                      {server.error_message}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No server data available.</p>
        )}

        <div className="flex items-center justify-between pt-4">
          <Button variant="ghost" size="sm" onClick={() => mutate()}>
            <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          {onViewAll ? (
            <Button variant="ghost" size="sm" onClick={onViewAll}>
              <FontAwesomeIcon icon={faEye} className="mr-2 h-4 w-4" />
              View All
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
};
