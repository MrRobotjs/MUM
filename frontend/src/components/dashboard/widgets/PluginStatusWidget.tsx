import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAdminApi } from '@/hooks/useAdminApi';
import { cn } from '@/lib/utils';
import { BentoTile, BentoTileBody, BentoTileFooter, BentoTileHeader } from '../bento';

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

const serviceAccent: Record<string, string> = {
  plex: 'border-l-plex-500',
  jellyfin: 'border-l-jellyfin-500',
  emby: 'border-l-emby-500',
  kavita: 'border-l-kavita-500',
  komga: 'border-l-komga-500',
  audiobookshelf: 'border-l-audiobookshelf-500',
  romm: 'border-l-romm-500',
};

type PluginStatusWidgetProps = {
  onViewAll?: () => void;
};

export const PluginStatusWidget = ({ onViewAll }: PluginStatusWidgetProps) => {
  const { data, loading, error, mutate } = useAdminApi<ServerStatusResponse>('/server-status');

  const summary = data?.data.summary;
  const servers = data?.data.servers ?? [];

  const lastUpdatedLabel = useMemo(() => {
    const raw = data?.meta?.generated_at;
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [data?.meta?.generated_at]);

  return (
    <BentoTile span={{ col: 5, mdCol: 6 }} label="Plugin and server status">
      <BentoTileHeader
        title="Connected services"
        description="Health of Plex, Jellyfin, Emby and other plugins."
        action={
          onViewAll ? (
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onViewAll}>
              All servers
            </Button>
          ) : null
        }
      />

      <BentoTileBody className="gap-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Checking services…
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : summary ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Total', value: summary.total_servers },
                { label: 'Online', value: summary.online, tone: 'text-emerald-400' },
                { label: 'Offline', value: summary.offline, tone: 'text-red-400' },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-md border border-border bg-background px-3 py-2 text-center"
                >
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {item.label}
                  </p>
                  <p className={cn('text-xl font-semibold tabular-nums', item.tone)}>{item.value}</p>
                </div>
              ))}
            </div>

            <ul className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
              {servers.length === 0 ? (
                <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  No servers configured yet.
                </li>
              ) : (
                servers.map((server) => {
                  const accent =
                    serviceAccent[server.service_type.toLowerCase()] ?? 'border-l-muted-foreground';

                  return (
                    <li
                      key={server.id}
                      className={cn(
                        'rounded-md border border-border border-l-[3px] bg-background px-3 py-2.5',
                        accent,
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{server.name}</p>
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">
                            {server.service_type}
                            {server.version ? ` · v${server.version}` : ''}
                          </p>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                            server.online
                              ? 'border-emerald-500/40 text-emerald-400'
                              : 'border-red-500/40 text-red-400',
                          )}
                        >
                          {server.online ? 'Online' : 'Offline'}
                        </span>
                      </div>
                      {server.error_message ? (
                        <p className="mt-1.5 line-clamp-2 text-xs text-red-400">{server.error_message}</p>
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No server data available.</p>
        )}
      </BentoTileBody>

      <BentoTileFooter>
        <p className="text-xs text-muted-foreground">
          {lastUpdatedLabel ? `Checked at ${lastUpdatedLabel}` : 'Not refreshed yet'}
        </p>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => mutate()}>
          Refresh
        </Button>
      </BentoTileFooter>
    </BentoTile>
  );
};
