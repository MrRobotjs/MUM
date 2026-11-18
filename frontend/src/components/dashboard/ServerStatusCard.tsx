import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useDashboardData, fetchServerHealth, type ServerHealth, type ServerHealthStatus, type ServerHealthSummary } from '../../lib/dashboard';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotate, faHeartPulse } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner'
import { useAlerts } from '@/contexts';
import { getServiceMeta } from '@/config/pluginMetadata';
import { ServiceSettingIcon, TabHeading } from '../users/AccountSettings';
import './ServerHealth.css';

type ServerStatusResponse = {
  data: { summary: ServerHealthSummary; servers: ServerHealth[] };
  meta: { generated_at: string };
};

const statusLabels: Record<ServerHealthStatus, string> = { online: 'Online', offline: 'Offline', disabled: 'Disabled', unchecked: 'Not checked' };
const chipOrder: ServerHealthStatus[] = ['online', 'offline', 'disabled', 'unchecked'];

const StatusPill = ({ status, children }: { status: ServerHealthStatus; children: string }) => (
  <span className="dashboard-health-status" data-status={status}>{children}</span>
);

// The dashboard's Server Health card: a summary, then one tile per server
// with its logo, version, status and last check. A tile opens the server.
export const ServerStatusCard = () => {
  const { data, loading, error, mutate } = useDashboardData<ServerStatusResponse>('dashboard:server-health', () => fetchServerHealth());
  const { success, error: showError } = useAlerts();
  const { formatTimestamp, formatRelative } = useAccountDisplay();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const summary = data?.data.summary;
  const servers = data?.data.servers ?? [];
  const generatedAt = data?.meta?.generated_at ?? null;

  useEffect(() => {
    if (generatedAt) setLastUpdatedAt(generatedAt);
  }, [generatedAt]);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    const startedAt = performance.now();
    setIsRefreshing(true);
    try {
      // An explicit refresh probes each active server before re-reading stored status.
      const refreshed = await mutate(fetchServerHealth(true), { revalidate: false });
      const refreshedAt = (refreshed as ServerStatusResponse | undefined)?.meta?.generated_at ?? generatedAt;
      if (refreshedAt) setLastUpdatedAt(refreshedAt);
      if (performance.now() - startedAt > 800) success('Server health updated');
    } catch {
      showError('Refresh failed. Try again.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const updated = lastUpdatedAt ? `updated ${formatTimestamp(lastUpdatedAt, 'time', 'Unknown')}` : 'not refreshed yet';
  const description = loading ? 'Reading server status…'
    : summary && summary.total_servers > 0 ? `${summary.online} of ${summary.total_servers} server${summary.total_servers === 1 ? '' : 's'} online · ${updated}`
    : 'No media servers yet';
  const note = (server: ServerHealth) => {
    const checked = server.checked_at ? formatRelative(server.checked_at) : null;
    switch (server.status) {
      case 'online': return checked ? `Checked ${checked}` : 'Online';
      case 'offline': return checked ? `Last check failed ${checked}` : 'Last check failed';
      case 'disabled': return 'Turned off in MUM';
      case 'unchecked': return 'Not checked yet';
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faHeartPulse} title="Server Health" description={description} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing || loading}>
            {isRefreshing ? <Spinner className="size-4" /> : <FontAwesomeIcon icon={faRotate} />}
            {isRefreshing ? 'Checking…' : 'Refresh'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4 text-primary" />
            Loading server status…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load server status: {error}
          </div>
        ) : summary && servers.length > 0 ? (
          <div className="space-y-4">
            <div className="dashboard-health-chips" aria-label="Server status summary">
              {chipOrder.filter(status => summary[status] > 0).map(status => (
                <StatusPill key={status} status={status}>{`${summary[status]} ${statusLabels[status].toLowerCase()}`}</StatusPill>
              ))}
            </div>
            <div className="dashboard-health-grid">
              {servers.map(server => (
                <Link key={server.id} to="/admin/servers/$serverId" params={{ serverId: String(server.id) }} className="dashboard-health-tile"
                  aria-label={`${server.name}: ${statusLabels[server.status]}`}>
                  <ServiceSettingIcon serviceType={server.service_type} />
                  <div className="dashboard-health-body">
                    <div className="dashboard-health-name">
                      <span>{server.name}</span>
                      <StatusPill status={server.status}>{statusLabels[server.status]}</StatusPill>
                    </div>
                    <span className="text-sm text-muted-foreground">{getServiceMeta(server.service_type).label}{server.version ? ` ${server.version}` : ''}</span>
                    <span className="dashboard-health-note">{note(server)}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Add a media server to see its health here.</p>
        )}
      </CardContent>
    </Card>
  );
};
