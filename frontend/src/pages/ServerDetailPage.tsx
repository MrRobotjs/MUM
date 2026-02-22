import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft,
  faCircleInfo,
  faServer,
  faTriangleExclamation,
  faRotate,
  faPlug,
  faUsers,
  faCheckCircle,
  faXmarkCircle,
  faLink,
  faClock,
  faDatabase,
} from '@fortawesome/free-solid-svg-icons';

import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';
import { useLibraries } from '../hooks/useLibraries';
import { useServerDetail } from '../hooks/useServers';
import { useUsersPaginated } from '../hooks/useUsersPaginated';
import { getServiceMeta } from '@/config/pluginMetadata';
import { ServiceIcon } from '../components';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

type ServerTab = 'overview' | 'users' | 'libraries';

type ServerStatusPayload = {
  online?: boolean;
  version?: string;
  error?: string;
  error_message?: string;
};

type ServerDetail = {
  id: number;
  server_nickname?: string | null;
  server_name?: string | null;
  service_type?: string | null;
  url?: string | null;
  public_url?: string | null;
  is_active?: boolean | null;
  plugin_enabled?: boolean | null;
  effective_active?: boolean | null;
  last_status?: boolean | null;
  last_status_check?: string | null;
  last_version?: string | null;
  last_sync_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  websocket_refresh_interval?: number | null;
  overseerr_enabled?: boolean | null;
  overseerr_url?: string | null;
  status?: ServerStatusPayload;
};

type ServerUser = {
  uuid: string;
  username?: string;
  display_name?: string;
  email?: string;
  user_type: string;
  is_active: boolean;
  server_nickname?: string;
  last_login_at?: string;
  last_streamed_at?: string | null;
  linked_local_user?: {
    uuid: string;
    username?: string | null;
    display_name?: string | null;
  } | null;
  libraries?: string[];
  has_all_libraries?: boolean;
  access_expires_at?: string | null;
};

type ActionResult = {
  success?: boolean;
  message?: string;
};

const formatDateTime = (value?: string | null) => {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatUrlHost = (value?: string | null) => {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
};

export const ServerDetailPage = () => {
  const { serverId } = useParams({ from: '/admin/servers/$serverId' });
  const search = useSearch({ strict: false }) as { tab?: ServerTab };
  const activeTab: ServerTab = search.tab ?? 'overview';
  const navigate = useNavigate({ from: '/admin/servers/$serverId' });
  const { success, error: showError } = useAlerts();

  const parsedServerId = Number(serverId);
  const numericServerId = Number.isFinite(parsedServerId) ? parsedServerId : undefined;

  const { server, loading, error, refresh } = useServerDetail(numericServerId) as {
    server: ServerDetail | null;
    loading: boolean;
    error: unknown;
    refresh: () => Promise<unknown>;
  };
  const {
    libraries,
    loading: librariesLoading,
    error: librariesError,
    refresh: refreshLibraries,
  } = useLibraries({ serverId: numericServerId, includeServer: true });
  const {
    users,
    pagination: usersPagination,
    loading: usersLoading,
    error: usersError,
    mutate: refreshUsers,
  } = useUsersPaginated({
    serverId: numericServerId ? String(numericServerId) : undefined,
    userType: 'service',
    page: 1,
    pageSize: 100,
  }) as {
    users: ServerUser[];
    pagination?: { total_items?: number; page?: number; total_pages?: number };
    loading: boolean;
    error: unknown;
    mutate: () => Promise<unknown>;
  };

  const [testingConnection, setTestingConnection] = useState(false);
  const [syncingLibraries, setSyncingLibraries] = useState(false);
  const [syncingUsers, setSyncingUsers] = useState(false);

  const serviceType = server?.service_type || 'unknown';
  const serviceMeta = getServiceMeta(serviceType);
  const statusOnline = server?.status?.online ?? server?.last_status ?? null;
  const statusVersion = server?.status?.version ?? server?.last_version ?? null;
  const statusError = server?.status?.error_message ?? server?.status?.error ?? null;
  const serverHost = formatUrlHost(server?.url);
  const publicHost = formatUrlHost(server?.public_url);
  const totalItems = useMemo(
    () => libraries.reduce((sum, lib) => sum + (lib.item_count ?? 0), 0),
    [libraries]
  );
  const userCount = usersPagination?.total_items ?? users.length;

  const setTab = (tab: ServerTab) => {
    navigate({
      search: (prev: { tab?: ServerTab }) => ({ ...prev, tab }),
      replace: true,
    });
  };

  const refreshAll = async () => {
    await Promise.all([refresh(), refreshLibraries(), refreshUsers()]);
  };

  const handleTestConnection = async () => {
    if (!numericServerId || testingConnection) return;
    setTestingConnection(true);
    try {
      const response = await requestJson<ActionResult>(`/api/v2/servers/${numericServerId}/test`, {
        method: 'POST',
      });
      success(response.message || 'Connection test completed');
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSyncLibraries = async () => {
    if (!numericServerId || syncingLibraries) return;
    setSyncingLibraries(true);
    try {
      const response = await requestJson<ActionResult>(`/api/v2/servers/${numericServerId}/sync-libraries`, {
        method: 'POST',
      });
      success(response.message || 'Library sync started');
      await refreshAll();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to sync libraries');
    } finally {
      setSyncingLibraries(false);
    }
  };

  const handleSyncUsers = async () => {
    if (!numericServerId || syncingUsers) return;
    setSyncingUsers(true);
    try {
      const response = await requestJson<ActionResult>(`/api/v2/servers/${numericServerId}/sync-users`, {
        method: 'POST',
      });
      success(response.message || 'User sync started');
      await refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to sync users');
    } finally {
      setSyncingUsers(false);
    }
  };

  if (!serverId || !numericServerId) {
    return (
      <div className="container mx-auto space-y-6">
        <Card className="border-destructive">
          <CardContent className="p-6 flex items-center gap-3">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive" />
            <span className="text-destructive">Invalid server ID.</span>
          </CardContent>
        </Card>
        <Link to="/admin/servers">
          <Button>
            <FontAwesomeIcon icon={faArrowLeft} className="mr-2 h-4 w-4" />
            Back to Servers
          </Button>
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="container mx-auto space-y-6">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !server) {
    const message = error instanceof Error ? error.message : 'Server not found';
    return (
      <div className="container mx-auto space-y-6">
        <div className="space-y-4">
          <h1 className="text-3xl font-bold">Server Not Found</h1>
          <p className="text-muted-foreground">The requested server could not be loaded</p>
        </div>
        <Card className="border-destructive">
          <CardContent className="p-6 flex items-center gap-3">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive" />
            <span className="text-destructive">{message}</span>
          </CardContent>
        </Card>
        <Link to="/admin/servers">
          <Button>
            <FontAwesomeIcon icon={faArrowLeft} className="mr-2 h-4 w-4" />
            Back to Servers
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-6">
      <Card className={`bg-gradient-to-r ${serviceMeta.detailGradient || serviceMeta.gradient}`}>
        <CardContent className="p-8">
          <div className="flex flex-col items-center space-y-4">
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-background/90 text-5xl shadow-inner ring-1 ring-black/5 dark:bg-background/70">
              <ServiceIcon serviceType={serviceType} />
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-center break-words">
              {server.server_nickname || `Server ${server.id}`}
            </h1>
            <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
              <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border gap-1">
                <FontAwesomeIcon icon={faServer} className="w-3 h-3" />
                {serviceMeta.label}
              </span>
              <Badge
                variant={statusOnline ? 'default' : 'secondary'}
                className={!statusOnline ? 'bg-destructive/10 text-destructive border-destructive/30' : ''}
              >
                {statusOnline === null ? 'Unknown' : statusOnline ? 'Online' : 'Offline'}
              </Badge>
              {serverHost ? (
                <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1">
                  <FontAwesomeIcon icon={faLink} className="w-3 h-3" />
                  {serverHost}
                </span>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={(value) => setTab(value as ServerTab)}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">
            <FontAwesomeIcon icon={faCircleInfo} className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="users">
            <FontAwesomeIcon icon={faUsers} className="mr-2 h-4 w-4" />
            Users
          </TabsTrigger>
          <TabsTrigger value="libraries">
            <FontAwesomeIcon icon={faDatabase} className="mr-2 h-4 w-4" />
            Libraries
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardContent className="p-6 space-y-4">
                <h3 className="text-lg font-semibold flex items-center">
                  <FontAwesomeIcon icon={faCircleInfo} className="mr-2 h-5 w-5 text-blue-500" />
                  Server Details
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Nickname:</span>
                    <span className="font-medium text-right">{server.server_nickname || '—'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Server Name:</span>
                    <span className="font-medium text-right">{server.server_name || server.server_nickname || '—'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Service:</span>
                    <span className="font-medium text-right">{serviceMeta.label}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">URL:</span>
                    <span className="font-medium text-right break-all">{server.url || '—'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Public URL:</span>
                    <span className="font-medium text-right break-all">{server.public_url || 'Not configured'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Created:</span>
                    <span className="font-medium text-right">{formatDateTime(server.created_at)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Updated:</span>
                    <span className="font-medium text-right">{formatDateTime(server.updated_at)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Last Sync:</span>
                    <span className="font-medium text-right">{formatDateTime(server.last_sync_at)}</span>
                  </div>
                  {typeof server.websocket_refresh_interval === 'number' ? (
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">WS Refresh Interval:</span>
                      <span className="font-medium text-right">{server.websocket_refresh_interval}s</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Overseerr:</span>
                    <span className="font-medium text-right">
                      {server.overseerr_enabled ? `Enabled${publicHost && server.overseerr_url ? ` (${formatUrlHost(server.overseerr_url)})` : ''}` : 'Disabled'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6 space-y-4">
                <h3 className="text-lg font-semibold flex items-center">
                  <FontAwesomeIcon icon={faPlug} className="mr-2 h-5 w-5 text-emerald-500" />
                  Status & Actions
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Plugin Enabled:</span>
                    <span className="font-medium text-right inline-flex items-center gap-1.5">
                      <FontAwesomeIcon icon={server.plugin_enabled ? faCheckCircle : faXmarkCircle} className={server.plugin_enabled ? 'text-emerald-500' : 'text-destructive'} />
                      {server.plugin_enabled ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Server Active:</span>
                    <span className="font-medium text-right inline-flex items-center gap-1.5">
                      <FontAwesomeIcon icon={server.is_active ? faCheckCircle : faXmarkCircle} className={server.is_active ? 'text-emerald-500' : 'text-destructive'} />
                      {server.is_active ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Effective Active:</span>
                    <span className="font-medium text-right inline-flex items-center gap-1.5">
                      <FontAwesomeIcon icon={server.effective_active ? faCheckCircle : faXmarkCircle} className={server.effective_active ? 'text-emerald-500' : 'text-destructive'} />
                      {server.effective_active ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Connection:</span>
                    <span className="font-medium text-right">
                      {statusOnline === null ? 'Unknown' : statusOnline ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Version:</span>
                    <span className="font-medium text-right">{statusVersion || 'Not available'}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Last Status Check:</span>
                    <span className="font-medium text-right">{formatDateTime(server.last_status_check)}</span>
                  </div>
                  {statusError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                      {statusError}
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-2 pt-2 sm:grid-cols-3">
                  <Button
                    variant="outline"
                    onClick={handleTestConnection}
                    disabled={testingConnection || syncingLibraries || syncingUsers}
                  >
                    {testingConnection ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Testing
                      </>
                    ) : (
                      <>
                        <FontAwesomeIcon icon={faPlug} className="mr-2 h-4 w-4" />
                        Test
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleSyncLibraries}
                    disabled={syncingLibraries || syncingUsers}
                  >
                    {syncingLibraries ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Syncing
                      </>
                    ) : (
                      <>
                        <FontAwesomeIcon icon={faDatabase} className="mr-2 h-4 w-4" />
                        Sync Libraries
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleSyncUsers}
                    disabled={syncingUsers || syncingLibraries}
                  >
                    {syncingUsers ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Syncing
                      </>
                    ) : (
                      <>
                        <FontAwesomeIcon icon={faUsers} className="mr-2 h-4 w-4" />
                        Sync Users
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Users</p>
                <p className="mt-1 text-2xl font-semibold">{userCount.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Libraries</p>
                <p className="mt-1 text-2xl font-semibold">
                  {libraries.length.toLocaleString()}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({totalItems.toLocaleString()} items)
                  </span>
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faClock} className="h-4 w-4" />
            Use the sync actions above to refresh server health, users, and libraries.
          </div>
        </TabsContent>

        <TabsContent value="users" className="space-y-6">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold flex items-center">
                    <FontAwesomeIcon icon={faUsers} className="mr-2 h-5 w-5 text-indigo-500" />
                    Users
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Service users linked to this server ({userCount.toLocaleString()})
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void refreshUsers()}>
                  <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
              </div>

              {usersError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  Failed to load users for this server.
                </div>
              ) : usersLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="h-4 w-4" />
                  Loading users...
                </div>
              ) : users.length > 0 ? (
                <div className="overflow-hidden rounded-xl border shadow-sm">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Libraries</TableHead>
                        <TableHead>Last Activity</TableHead>
                        <TableHead>Access Expires</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {users.map((user) => (
                        <TableRow key={user.uuid}>
                          <TableCell>
                            <div className="space-y-1">
                              <Link
                                to={`/admin/users/${user.uuid}?tab=profile`}
                                className="font-semibold text-primary hover:underline"
                              >
                                {user.display_name || user.username || 'Unnamed User'}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {user.username || 'No username'}
                                {user.linked_local_user
                                  ? ` • Linked to ${user.linked_local_user.display_name || user.linked_local_user.username || 'Local User'}`
                                  : ''}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={user.is_active ? 'default' : 'secondary'}>
                              {user.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {user.has_all_libraries
                              ? 'All libraries'
                              : `${user.libraries?.length ?? 0} selected`}
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">
                              {user.last_streamed_at
                                ? `Streamed ${formatDateTime(user.last_streamed_at)}`
                                : user.last_login_at
                                  ? `Login ${formatDateTime(user.last_login_at)}`
                                  : 'No recent activity'}
                            </div>
                          </TableCell>
                          <TableCell>{formatDateTime(user.access_expires_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                  No service users found for this server.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="libraries" className="space-y-6">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold flex items-center">
                    <FontAwesomeIcon icon={faDatabase} className="mr-2 h-5 w-5 text-violet-500" />
                    Libraries
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {libraries.length} librar{libraries.length === 1 ? 'y' : 'ies'} • {totalItems.toLocaleString()} items
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void refreshLibraries()}>
                  <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
              </div>

              {librariesError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  Failed to load libraries for this server.
                </div>
              ) : librariesLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="h-4 w-4" />
                  Loading libraries...
                </div>
              ) : libraries.length > 0 ? (
                <div className="overflow-hidden rounded-xl border shadow-sm">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Library</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Items</TableHead>
                        <TableHead>Last Scanned</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {libraries.map((library) => (
                        <TableRow key={library.id}>
                          <TableCell>
                            <Link
                              to={`/admin/libraries/${library.id}?tab=overview`}
                              className="font-semibold text-primary hover:underline"
                            >
                              {library.name}
                            </Link>
                          </TableCell>
                          <TableCell className="capitalize">
                            {library.library_type?.replace(/_/g, ' ') || 'Unknown'}
                          </TableCell>
                          <TableCell>{(library.item_count ?? 0).toLocaleString()}</TableCell>
                          <TableCell>{formatDateTime(library.last_scanned)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                  No libraries are currently associated with this server.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ServerDetailPage;
