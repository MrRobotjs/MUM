import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import clsx from 'clsx';
import { useLibraries, type Library } from '../hooks/useLibraries';
import { useServers, type Server } from '../hooks/useServers';
import { FormField, PageHeader } from '../components';
import { useAlerts } from '../contexts';
import { requestJson } from '../util/apiClient';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Button } from '../components/ui/button';
import { ResponsiveDialog } from '../components/ui/responsive-dialog';

type LibraryGroup = {
  serviceType: string;
  label: string;
  gradient: string;
  badgeClass: string;
  icon: JSX.Element;
  servers: Array<{
    server: Server;
    libraries: Library[];
  }>;
};

const plexIcon = (
  <svg className="w-5 h-5 stroke-transparent text-warning" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
    <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z" />
  </svg>
);

const SERVICE_META: Record<string, { label: string; gradient: string; badgeClass: string; icon: JSX.Element }> = {
  plex: {
    label: 'Plex',
    gradient: 'from-card to-plex/10',
    badgeClass: 'bg-plex-50 text-plex-700 ring-plex-500/30',
    icon: plexIcon
  },
  jellyfin: {
    label: 'Jellyfin',
    gradient: 'from-card to-jellyfin/10',
    badgeClass: 'bg-jellyfin-50 text-jellyfin-700 ring-jellyfin-500/30',
    icon: <i className="fa-solid fa-cube text-jellyfin" />
  },
  emby: {
    label: 'Emby',
    gradient: 'from-card to-emby/10',
    badgeClass: 'bg-emby-50 text-emby-700 ring-emby-500/30',
    icon: <i className="fa-solid fa-play-circle text-emby" />
  },
  kavita: {
    label: 'Kavita',
    gradient: 'from-card to-kavita/10',
    badgeClass: 'bg-kavita-50 text-kavita-700 ring-kavita-500/30',
    icon: <i className="fa-solid fa-book text-kavita" />
  },
  audiobookshelf: {
    label: 'AudioBookshelf',
    gradient: 'from-card to-audiobookshelf/10',
    badgeClass: 'bg-audiobookshelf-50 text-audiobookshelf-700 ring-audiobookshelf-500/30',
    icon: <i className="fa-solid fa-headphones text-audiobookshelf" />
  },
  komga: {
    label: 'Komga',
    gradient: 'from-card to-komga/10',
    badgeClass: 'bg-komga-50 text-komga-700 ring-komga-500/30',
    icon: <i className="fa-solid fa-book-open text-komga" />
  },
  romm: {
    label: 'RomM',
    gradient: 'from-card to-romm/10',
    badgeClass: 'bg-romm-50 text-romm-700 ring-romm-500/30',
    icon: <i className="fa-solid fa-gamepad text-romm" />
  }
};

const getServiceMeta = (serviceType?: string) => {
  if (!serviceType) {
    return {
      label: 'Unknown',
      gradient: 'from-card to-muted',
      badgeClass: 'bg-muted text-foreground ring-border',
      icon: <i className="fa-solid fa-server" />
    };
  }

  return SERVICE_META[serviceType.toLowerCase()] || {
    label: serviceType,
    gradient: 'from-card to-muted',
    badgeClass: 'bg-muted text-foreground ring-border',
    icon: <i className="fa-solid fa-server" />
  };
};

const formatDateTime = (value?: string | null) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return value;
  }
};

const formatCount = (value?: number | null) => {
  if (value === null || value === undefined) return 'N/A';
  return value.toLocaleString();
};

export const LibrariesPage = () => {
  const [serverId, setServerId] = useState<number | undefined>();
  const [libraryType, setLibraryType] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const { libraries, loading, error, refresh: refreshLibraries } = useLibraries({
    serverId,
    libraryType: libraryType || undefined,
    search: search || undefined,
    includeServer: true
  });

  const { servers, loading: serversLoading, refresh: refreshServers } = useServers({ includeStatus: true });
  const { success, error: showError } = useAlerts();

  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingServerId, setSyncingServerId] = useState<number | null>(null);
  const [rawModalOpen, setRawModalOpen] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawLibrary, setRawLibrary] = useState<Library | null>(null);
  const [rawData, setRawData] = useState<Record<string, unknown> | null>(null);

  const uniqueTypes = useMemo(() => {
    const set = new Set<string>();
    libraries.forEach((lib) => {
      if (lib.library_type) {
        set.add(lib.library_type);
      }
    });
    return Array.from(set).sort();
  }, [libraries]);

  const librariesByServerId = useMemo(() => {
    const map = new Map<number, Library[]>();
    libraries.forEach((lib) => {
      if (typeof lib.server_id === 'number') {
        if (!map.has(lib.server_id)) {
          map.set(lib.server_id, []);
        }
        map.get(lib.server_id)!.push(lib);
      }
    });
    return map;
  }, [libraries]);

  const filteredServers = useMemo(() => {
    if (serverId) {
      return servers.filter((server) => server.id === serverId);
    }
    return servers;
  }, [servers, serverId]);

  const groups = useMemo<LibraryGroup[]>(() => {
    const grouped = new Map<string, LibraryGroup>();

    filteredServers.forEach((server) => {
      const serviceType = server.service_type || 'unknown';
      const meta = getServiceMeta(serviceType);
      if (!grouped.has(serviceType)) {
        grouped.set(serviceType, {
          serviceType,
          label: meta.label,
          gradient: meta.gradient,
          badgeClass: meta.badgeClass,
          icon: meta.icon,
          servers: []
        });
      }
      grouped.get(serviceType)!.servers.push({
        server,
        libraries: librariesByServerId.get(server.id) ?? []
      });
    });

    // Add any libraries missing server reference (fallback group)
    libraries.forEach((lib) => {
      if (typeof lib.server_id !== 'number') {
        const serviceType = lib.server?.service_type || 'unknown';
        const meta = getServiceMeta(serviceType);
        if (!grouped.has(serviceType)) {
          grouped.set(serviceType, {
            serviceType,
            label: meta.label,
            gradient: meta.gradient,
            badgeClass: meta.badgeClass,
            icon: meta.icon,
            servers: []
          });
        }
        grouped.get(serviceType)!.servers.push({
          server: {
            id: -1,
            server_nickname: lib.server?.server_nickname || 'Unknown Server',
            server_name: lib.server?.server_name || null,
            service_type: serviceType,
            url: '',
            public_url: null,
            is_active: true,
            created_at: '',
            updated_at: '',
            last_status: null,
            last_status_check: null,
            last_version: null,
            last_sync_at: null,
            overseerr_enabled: false,
            overseerr_url: null
          } as Server,
          libraries: [lib]
        });
      }
    });

    return Array.from(grouped.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [filteredServers, libraries, librariesByServerId]);

  const handleSyncServer = async (serverId: number) => {
    setSyncingServerId(serverId);
    try {
      await requestJson(`/admin/api/v2/servers/${serverId}/sync-libraries`, {
        method: 'POST'
      });
      success('Library sync started');
      await Promise.all([refreshLibraries(), refreshServers()]);
    } catch (err) {
      showError(`Failed to sync libraries: ${(err as Error).message}`);
    } finally {
      setSyncingServerId(null);
    }
  };

  const handleSyncAll = async () => {
    if (servers.length === 0) {
      showError('No servers available to sync.');
      return;
    }
    setSyncingAll(true);
    try {
      for (const server of servers) {
        await requestJson(`/admin/api/v2/servers/${server.id}/sync-libraries`, {
          method: 'POST'
        });
      }
      success('Library sync started for all servers');
      await Promise.all([refreshLibraries(), refreshServers()]);
    } catch (err) {
      showError(`Failed to sync libraries: ${(err as Error).message}`);
    } finally {
      setSyncingAll(false);
    }
  };

  const openRawModal = async (library: Library) => {
    setRawModalOpen(true);
    setRawLibrary(library);
    setRawData(null);
    setRawLoading(true);
    try {
      const result = await requestJson<{ data: Record<string, unknown> }>(
        `/admin/api/v2/libraries/${library.id}?include_server=true`
      );
      setRawData(result.data);
    } catch (err) {
      showError(`Failed to load library details: ${(err as Error).message}`);
      setRawData(null);
    } finally {
      setRawLoading(false);
    }
  };

  const closeRawModal = () => {
    setRawModalOpen(false);
    setRawLibrary(null);
    setRawData(null);
  };

  const copyRawData = async () => {
    if (!rawData) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(rawData, null, 2));
      success('Raw data copied to clipboard');
    } catch (err) {
      showError('Failed to copy raw data');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Libraries"
        description="Review libraries synced from your media servers"
        actions={
          <Button
            variant="default"
            size="sm"
            onClick={handleSyncAll}
            disabled={syncingAll || servers.length === 0}
          >
            {syncingAll ? (
              <span className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" /> Syncing…
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <i className="fa-solid fa-sync-alt" /> Sync Libraries
              </span>
            )}
          </Button>
        }
      />

      {(error || serversLoading) && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4 text-sm text-yellow-400 flex items-center gap-2">
          <i className="fa-solid fa-circle-info" />
          <span>
            {error
              ? `Failed to load libraries: ${(error as Error).message}`
              : 'Loading server information…'}
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="server-filter">Server</Label>
          <Select
            value={serverId?.toString() || 'all'}
            onValueChange={(value) => setServerId(value === 'all' ? undefined : Number(value))}
          >
            <SelectTrigger id="server-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Servers</SelectItem>
              {servers.map((server) => (
                <SelectItem key={server.id} value={server.id.toString()}>
                  {server.server_nickname}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="type-filter">Library Type</Label>
          <Select value={libraryType || 'all'} onValueChange={(value) => setLibraryType(value === 'all' ? '' : value)}>
            <SelectTrigger id="type-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {uniqueTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="search">Search</Label>
          <Input
            id="search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search library name…"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> Loading libraries…
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="text-center text-sm text-muted-foreground py-8">
            No libraries found. Sync your media servers to load library information.
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <Card
            key={group.serviceType}
            className={clsx(
              'border shadow-sm',
              `bg-gradient-to-br ${group.gradient}`
            )}
          >
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background shadow-inner">
                    {group.icon}
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">{group.label}</h2>
                    <span className={clsx('inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset', group.badgeClass)}>
                      {group.servers.reduce((acc, item) => acc + item.libraries.length, 0)} libraries
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                {group.servers.map(({ server, libraries: serverLibraries }) => (
                  <div key={server.id !== -1 ? server.id : `lib-${serverLibraries[0]?.id ?? 'unknown'}`}
                    className="rounded-lg border bg-background shadow-sm">
                    <div className="border-b px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold">{server.server_nickname}</h3>
                        <div className="text-xs text-muted-foreground">
                          {server.server_name || server.server_nickname}
                          {server.last_sync_at ? ` • Last sync ${formatDateTime(server.last_sync_at)}` : ''}
                        </div>
                      </div>
                      {server.id !== -1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleSyncServer(server.id)}
                          disabled={syncingServerId === server.id}
                        >
                          {syncingServerId === server.id ? (
                            <span className="flex items-center gap-1">
                              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" /> Syncing…
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <i className="fa-solid fa-sync" /> Sync Server
                            </span>
                          )}
                        </Button>
                      )}
                    </div>

                    {serverLibraries.length > 0 ? (
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Library</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead>Items</TableHead>
                              <TableHead>Last Scanned</TableHead>
                              <TableHead>Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {serverLibraries.map((library) => {
                              return (
                                <TableRow key={library.id}>
                                  <TableCell>
                                    <Link
                                      to={`/admin/libraries/${library.id}?tab=overview`}
                                      className="text-primary font-medium hover:underline underline-offset-4"
                                    >
                                      {library.name}
                                    </Link>
                                  </TableCell>
                                  <TableCell>
                                    <span className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium capitalize">
                                      {library.library_type || 'Unknown'}
                                    </span>
                                  </TableCell>
                                  <TableCell>{formatCount(library.item_count)}</TableCell>
                                  <TableCell>{formatDateTime(library.last_scanned)}</TableCell>
                                  <TableCell>
                                    <Button size="sm" variant="ghost" onClick={() => openRawModal(library)}>
                                      <i className="fa-solid fa-code" />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <div className="p-4 text-sm text-muted-foreground">
                        No libraries available. Sync this server to fetch libraries.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))
      )}

      {libraries.length > 0 && (
        <div className="text-sm text-muted-foreground">
          Showing {libraries.length} library{libraries.length === 1 ? '' : 'ies'} across {filteredServers.length}{' '}
          server{filteredServers.length === 1 ? '' : 's'}
        </div>
      )}

      <ResponsiveDialog
        open={rawModalOpen}
        onOpenChange={(value) => {
          if (!value) closeRawModal();
        }}
        title="Library Raw Data"
        description={rawLibrary ? `${rawLibrary.name} • ${rawLibrary.server?.server_nickname ?? 'Unknown server'}` : undefined}
        footer={[
          <Button key="close" variant="outline" onClick={closeRawModal}>
            Close
          </Button>,
          <Button key="copy" onClick={copyRawData} disabled={!rawData}>
            <i className="fa-solid fa-copy" /> Copy JSON
          </Button>,
        ]}
        contentClassName="max-w-3xl"
      >
        {rawLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> Loading…
          </div>
        ) : rawData ? (
          <pre className="max-h-96 overflow-auto rounded bg-muted/50 p-4 text-xs font-mono">
            {JSON.stringify(rawData, null, 2)}
          </pre>
        ) : (
          <div className="text-sm text-muted-foreground">
            No raw data available for this library.
          </div>
        )}
      </ResponsiveDialog>
    </div>
  );
};

export default LibrariesPage;
