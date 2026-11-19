import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { getServiceMeta } from '@/config/pluginMetadata';
import { PageHeader } from '../components/common/PageHeader';
import { ServiceSettingIcon } from '../components/users/AccountSettings';
import { serverPagesFor } from '../components/layout/NavServers';
import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useLibraries } from '../hooks/useLibraries';
import { useServers } from '../hooks/useServers';
import { useUserTotal } from '../hooks/useUserTotal';
import { fetchServerHealth, useDashboardData, type ServerHealth, type ServerHealthStatus, type ServerHealthSummary } from '../lib/dashboard';
import { subscribeToChannel } from '../lib/realtimeSocket';
import { serverLibraryTotals } from '../lib/serversIndex';
import '../components/dashboard/ServerHealth.css';

// The Media Servers page (/admin/servers), opened from the sidebar's "Media
// Servers" heading: one card per server with its live status, a few figures
// and links to its own pages.

type HealthResponse = { data: { summary: ServerHealthSummary; servers: ServerHealth[] }; meta: { generated_at: string } };
const statusLabels: Record<ServerHealthStatus, string> = { online: 'Online', offline: 'Offline', disabled: 'Disabled', unchecked: 'Not checked' };
const chipOrder: ServerHealthStatus[] = ['online', 'offline', 'disabled', 'unchecked'];

function ServerCard({ health, lastSync, libraries, items }: { health: ServerHealth; lastSync: string | null; libraries: number; items: number }) {
  const { formatRelative } = useAccountDisplay();
  const users = useUserTotal({ serverId: health.id });
  const meta = getServiceMeta(health.service_type);
  const checked = health.checked_at ? `checked ${formatRelative(health.checked_at).replace(/^Just now$/, 'just now')}` : 'not checked yet';
  return <div className="dashboard-health-tile dashboard-overview-tile">
    <ServiceSettingIcon serviceType={health.service_type} />
    <div className="dashboard-health-body">
      <div className="dashboard-health-name">
        <Link to="/admin/servers/$serverId" params={{ serverId: String(health.id) }} className="account-library-link">{health.name}</Link>
        <span className="dashboard-health-status" data-status={health.status}>{statusLabels[health.status]}</span>
      </div>
      <span className="text-sm text-muted-foreground">{meta.label}{health.version ? ` ${health.version}` : ''} · {checked}</span>
      <span className="dashboard-health-note">
        {users === null ? '—' : users.toLocaleString()} user{users === 1 ? '' : 's'} · {libraries.toLocaleString()} librar{libraries === 1 ? 'y' : 'ies'} · {items.toLocaleString()} items
        · {lastSync ? `synced ${formatRelative(lastSync).replace(/^Just now$/, 'just now')}` : 'never synced'}
      </span>
      <div className="flex flex-wrap gap-1 pt-2">
        {serverPagesFor(health.service_type).map(page => <Button key={page.title} variant="ghost" size="sm" asChild>
          <Link to={page.to} params={{ serverId: String(health.id) }}><FontAwesomeIcon icon={page.icon} />{page.title}</Link>
        </Button>)}
      </div>
    </div>
  </div>;
}

export const ServersPage = () => {
  // The dashboard's health read: MUM checks servers in the background and
  // announces changes, so the statuses stay live.
  const { data, loading, error, mutate } = useDashboardData<HealthResponse>('dashboard:server-health', () => fetchServerHealth(), 30_000);
  const { servers } = useServers();
  const { libraries } = useLibraries({ includeServer: false });
  useEffect(() => subscribeToChannel('system.server_health', envelope => {
    if (envelope.type === 'ServerHealth') void mutate();
  }), [mutate]);
  // Re-render every 15 seconds so the relative times move on.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(n => n + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const totals = useMemo(() => serverLibraryTotals(libraries), [libraries]);
  const lastSync = useMemo(() => new Map(servers.map(s => [s.id, s.last_sync_at ?? null])), [servers]);
  const rows = [...(data?.data.servers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const summary = data?.data.summary;

  return (
    <div className="space-y-6">
      <PageHeader title="Media Servers" description="Every server MUM manages, with its status and pages."
        actions={<Button size="sm" asChild><Link to="/admin/settings/media-servers"><FontAwesomeIcon icon={faPlus} />Add server</Link></Button>} />
      {summary && summary.total_servers > 0 && <div className="dashboard-health-chips" aria-label="Server status summary">
        {chipOrder.filter(status => summary[status] > 0).map(status => (
          <span key={status} className="dashboard-health-status" data-status={status}>{`${summary[status]} ${statusLabels[status].toLowerCase()}`}</span>
        ))}
      </div>}
      {error ? <Card><CardContent className="p-6 text-sm text-destructive">Couldn’t load the servers. Try again shortly.</CardContent></Card>
        : loading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Loading servers…</div>
        : rows.length === 0 ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No media servers yet. Add one to start managing its users and libraries.</CardContent></Card>
        : <div className="dashboard-servers-grid">
          {rows.map(health => <ServerCard key={health.id} health={health} lastSync={lastSync.get(health.id) ?? null}
            libraries={totals.get(health.id)?.libraries ?? 0} items={totals.get(health.id)?.items ?? 0} />)}
        </div>}
    </div>
  );
};

export default ServersPage;
