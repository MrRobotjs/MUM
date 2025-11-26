import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { useLibraries, type Library } from '../hooks/useLibraries';
import { useServers, type Server } from '../hooks/useServers';
import { PageHeader } from '../components';
import { useAlerts } from '../contexts';
import { requestJson } from '../util/apiClient';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Button } from '../components/ui/button';
import { ResponsiveDialog } from '../components/ui/responsive-dialog';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';

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
  <svg className="w-5 h-5 stroke-transparent text-amber-600 dark:text-amber-400" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
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
  if (!value) return '-';
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

  const summaryStats = useMemo(() => {
    const totalLibraries = libraries.length;
    const totalItems = libraries.reduce((acc, lib) => acc + (lib.item_count ?? 0), 0);
    const activeServers = servers.length;
    const onlineServers = servers.filter((server) => server.last_status === true).length;
    const lastSyncedAt = servers.reduce<string | null>((latest, server) => {
      if (!server.last_sync_at) return latest;
      if (!latest) return server.last_sync_at;
      return new Date(server.last_sync_at) > new Date(latest) ? server.last_sync_at : latest;
    }, null);

    return {
      totalLibraries,
      totalItems,
      activeServers,
      onlineServers,
      lastSyncedAt
    };
  }, [libraries, servers]);

  const lastSyncDisplay = summaryStats.lastSyncedAt ? formatDateTime(summaryStats.lastSyncedAt) : 'Not available';

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

  const filtersApplied = Boolean(serverId || libraryType || search);

  const handleClearFilters = () => {
    setServerId(undefined);
    setLibraryType('');
    setSearch('');
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
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" /> Syncing...
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
        <div className="flex items-center gap-2 rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-4 text-sm text-yellow-400">
          <i className="fa-solid fa-circle-info" />
          <span>
            {error
              ? `Failed to load libraries: ${(error as Error).message}`
              : 'Loading server information...'}
          </span>
        </div>
      )}


      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border border-border/60 bg-gradient-to-br from-background via-background/40 to-muted/40 shadow-sm">
          <CardContent className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Libraries</p>
            <div className="text-3xl font-semibold">{summaryStats.totalLibraries.toLocaleString()}</div>
            <p className="text-sm text-muted-foreground">
              {uniqueTypes.length} library type{uniqueTypes.length === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
        <Card className="border border-border/60 bg-gradient-to-br from-background via-background/40 to-primary/5 shadow-sm">
          <CardContent className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items Indexed</p>
            <div className="text-3xl font-semibold">{summaryStats.totalItems.toLocaleString()}</div>
            <p className="text-sm text-muted-foreground">Across all libraries</p>
          </CardContent>
        </Card>
        <Card className="border border-border/60 bg-gradient-to-br from-background via-background/40 to-emerald-500/5 shadow-sm">
          <CardContent className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Servers</p>
            <div className="text-3xl font-semibold">{summaryStats.activeServers.toLocaleString()}</div>
            <Badge
              variant="outline"
              className={cn(
                'w-fit border-emerald-400/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                summaryStats.onlineServers === 0 && 'border-amber-400/60 bg-amber-500/10 text-amber-600'
              )}
            >
              <span className="flex items-center gap-1">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full bg-emerald-500',
                    summaryStats.onlineServers === 0 && 'bg-amber-500'
                  )}
                />
                {summaryStats.onlineServers} online
              </span>
            </Badge>
          </CardContent>
        </Card>
        <Card className="border border-border/60 bg-gradient-to-br from-background via-background/40 to-secondary/20 shadow-sm">
          <CardContent className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Most Recent Sync</p>
            <div className="text-xl font-semibold leading-tight">{lastSyncDisplay}</div>
            <p className="text-sm text-muted-foreground">
              Keep your data current by syncing libraries regularly.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border shadow-sm">
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Filters</p>
              <p className="text-xs text-muted-foreground">Narrow down libraries by server, type, or keyword.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={handleClearFilters} disabled={!filtersApplied}>
              <span className="flex items-center gap-2">
                <i className="fa-solid fa-sliders" /> Reset
              </span>
            </Button>
          </div>
          <Separator />
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="server-filter">Server</Label>
              <Select
                value={serverId?.toString() || 'all'}
                onValueChange={(value) => setServerId(value === 'all' ? undefined : Number(value))}
              >
                <SelectTrigger id="server-filter">
                  <SelectValue placeholder="All servers" />
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
              <Select
                value={libraryType || 'all'}
                onValueChange={(value) => setLibraryType(value === 'all' ? '' : value)}
              >
                <SelectTrigger id="type-filter">
                  <SelectValue placeholder="All types" />
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
              <div className="relative">
                <i className="fa-solid fa-magnifying-glass pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground" />
                <Input
                  id="search"
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search library name"
                  className="pl-9"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>


      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> Loading libraries...
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="text-center text-sm text-muted-foreground py-8">
            No libraries found. Sync your media servers to load library information.
          </CardContent>
        </Card>
      ) : (

        groups.map((group) => {
          const totalGroupLibraries = group.servers.reduce((acc, item) => acc + item.libraries.length, 0);
          return (
            <Card
              key={group.serviceType}
              className="overflow-hidden border bg-card/80 shadow-lg backdrop-blur p-0 gap-0"
            >
              <div className={cn('flex flex-wrap items-center justify-between gap-4 border-b px-6 py-4 bg-gradient-to-r', group.gradient)}>
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-background/90 shadow-inner ring-1 ring-black/5 dark:bg-background/60">
                    {group.icon}
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">Service</p>
                    <h2 className="text-xl font-semibold">{group.label}</h2>
                    <Badge className={cn('w-fit text-[11px] font-medium ring-1 ring-inset', group.badgeClass)}>
                      {totalGroupLibraries} libraries
                    </Badge>
                  </div>
                </div>
              </div>
              <CardContent className="space-y-6 bg-muted/20 p-6">
                {group.servers.map(({ server, libraries: serverLibraries }) => {
                  const serverItemCount = serverLibraries.reduce((acc, library) => acc + (library.item_count ?? 0), 0);
                  const lastLibraryScan = serverLibraries.reduce<string | null>((latest, library) => {
                    if (!library.last_scanned) return latest;
                    if (!latest) return library.last_scanned;
                    return new Date(library.last_scanned) > new Date(latest) ? library.last_scanned : latest;
                  }, null);
                  const isServerOnline = server.last_status === true;
                  return (
                    <div
                      key={server.id !== -1 ? server.id : `lib-${serverLibraries[0]?.id ?? 'unknown'}`}
                      className="rounded-2xl border bg-card/90 text-card-foreground shadow-sm ring-1 ring-border/40"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-lg font-semibold">{server.server_nickname}</h3>
                            {server.id !== -1 && (
                              <Badge variant="secondary" className="capitalize">
                                {server.service_type || 'Unknown'}
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{server.server_name || server.server_nickname}</span>
                            <span className="hidden sm:inline">&middot;</span>
                            <span>
                              {server.last_sync_at
                                ? `Last sync ${formatDateTime(server.last_sync_at)}`
                                : 'Waiting for first sync'}
                            </span>
                          </div>
                        </div>
                        {server.id !== -1 && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="outline"
                              className={cn(
                                'border-emerald-400/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                                !isServerOnline && 'border-destructive/40 bg-destructive/10 text-destructive'
                              )}
                            >
                              <span className="flex items-center gap-1">
                                <span
                                  className={cn(
                                    'h-1.5 w-1.5 rounded-full bg-emerald-500',
                                    !isServerOnline && 'bg-destructive'
                                  )}
                                />
                                {isServerOnline ? 'Online' : 'Offline'}
                              </span>
                            </Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSyncServer(server.id)}
                              disabled={syncingServerId === server.id}
                            >
                              {syncingServerId === server.id ? (
                                <span className="flex items-center gap-2">
                                  <div className="h-3 w-3 animate-spin rounded-full border-b-2 border-current" /> Syncing
                                </span>
                              ) : (
                                <span className="flex items-center gap-2">
                                  <i className="fa-solid fa-sync" /> Sync
                                </span>
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                      <Separator />
                      <div className="grid gap-3 px-4 py-4 sm:grid-cols-3">
                        <div className="rounded-lg border bg-muted/40 p-3">
                          <p className="text-xs uppercase text-muted-foreground">Libraries</p>
                          <p className="text-lg font-semibold">{serverLibraries.length}</p>
                        </div>
                        <div className="rounded-lg border bg-muted/40 p-3">
                          <p className="text-xs uppercase text-muted-foreground">Items</p>
                          <p className="text-lg font-semibold">{formatCount(serverItemCount)}</p>
                        </div>
                        <div className="rounded-lg border bg-muted/40 p-3">
                          <p className="text-xs uppercase text-muted-foreground">Latest Scan</p>
                          <p className="text-sm font-medium">
                            {lastLibraryScan ? formatDateTime(lastLibraryScan) : 'Not available'}
                          </p>
                        </div>
                      </div>
                      {serverLibraries.length > 0 ? (
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="min-w-[200px]">Library</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead>Items</TableHead>
                                <TableHead>Last Scanned</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {serverLibraries.map((library) => (
                                <TableRow key={library.id}>
                                  <TableCell>
                                    <div className="space-y-1">
                                      <Link
                                        to={`/admin/libraries/${library.id}?tab=overview`}
                                        className="font-semibold text-primary hover:underline"
                                      >
                                        {library.name}
                                      </Link>
                                      <p className="text-xs text-muted-foreground">
                                        ID {library.external_id}
                                      </p>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="secondary" className="capitalize">
                                      {library.library_type?.replace(/_/g, ' ') || 'Unknown'}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="font-semibold">{formatCount(library.item_count)}</TableCell>
                                  <TableCell>{formatDateTime(library.last_scanned)}</TableCell>
                                  <TableCell className="text-right">
                                    <Button size="sm" variant="ghost" onClick={() => openRawModal(library)}>
                                      <i className="fa-solid fa-code" />
                                      <span className="sr-only">View raw JSON</span>
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : (
                        <div className="p-4 text-sm text-muted-foreground">
                          No libraries available. Sync this server to fetch libraries.
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })
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
        description={
          rawLibrary ? `${rawLibrary.name} - ${rawLibrary.server?.server_nickname ?? 'Unknown server'}` : undefined
        }
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
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> Loading...
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
