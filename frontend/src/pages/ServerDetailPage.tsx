import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {checkServerConnection} from '../lib/serverConnection';
import {syncSelectedServer,type ServerSyncScope} from '../lib/serverSync';
import { Link, useParams } from '@tanstack/react-router';
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

import { useAlerts } from '../contexts';
import { useLibraries } from '../hooks/useLibraries';
import { useServerDetail } from '../hooks/useServers';
import { useUsersPaginated } from '../hooks/useUsersPaginated';
import { getServiceMeta } from '@/config/pluginMetadata';
import { ServiceIcon } from '../components';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { ACTIVITY_GRAPH_SERVICES, ActivityGraphs } from './GraphsPage';
import { PlexResources } from '../components/servers/PlexResources';

type ServerTab = 'overview' | 'users' | 'libraries' | 'resources';

type ServerStatusPayload = {
  online?: boolean;
  version?: string;
  error?: string;
  error_message?: string;
};

type ServerDetail = {
  id: number;
  revision: number;
  server_nickname?: string | null;
  server_name?: string | null;
  service_type?: string | null;
  url?: string | null;
  public_url?: string | null;
  is_active?: boolean | null;
  provider_enabled?: boolean | null;
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

const formatUrlHost = (value?: string | null) => {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
};

// Overview, Users and Libraries are separate pages (/admin/servers/<id>,
// /users, /libraries) sharing the server hero; the sidebar links between them.
export const ServerDetailPage = ({ section = 'overview' }: { section?: ServerTab }) => {
  const { formatTimestamp } = useAccountDisplay();
  const formatDateTime = (value?: string | null) => formatTimestamp(value, 'datetime', 'Not available');
  const { serverId } = useParams({ strict: false }) as { serverId: string };
  const { success, error: showError } = useAlerts();

  const parsedServerId = Number(serverId);
  const numericServerId = Number.isSafeInteger(parsedServerId) && parsedServerId > 0 && String(parsedServerId) === serverId ? parsedServerId : undefined;

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

  const {user:actor,isAdministrator}=useAuth();
  const auth=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const testKey=isAdministrator&&actor&&auth.accessToken&&server?`${actor.uuid}:${auth.accessToken}:${numericServerId}:${server.revision}`:'';
  const liveTestKey=useRef(testKey);liveTestKey.current=testKey;
  const testRun=useRef<{key:string;abort:AbortController}|null>(null);
  const [testBusyKey,setTestBusyKey]=useState<string|null>(null);
  const [testNeedsReadKey,setTestNeedsReadKey]=useState<string|null>(null);
  const testingConnection=Boolean(testKey&&testBusyKey===testKey);
  useEffect(()=>{liveTestKey.current=testKey;testRun.current?.abort.abort();testRun.current=null;setTestBusyKey(null);return()=>{liveTestKey.current='';testRun.current?.abort.abort();};},[testKey]);
  const syncPageKey=isAdministrator&&actor&&auth.accessToken&&numericServerId?`${actor.uuid}:${auth.accessToken}:${numericServerId}`:'';
  const liveSyncKey=useRef(syncPageKey);liveSyncKey.current=syncPageKey;
  const syncRun=useRef<{key:string;abort:AbortController}|null>(null);
  const [syncBusy,setSyncBusy]=useState<{key:string;scope:ServerSyncScope}|null>(null);
  const [syncNeedsReadKey,setSyncNeedsReadKey]=useState<string|null>(null);
  const syncingLibraries=syncBusy?.key===syncPageKey&&syncBusy.scope==='libraries';
  const syncingUsers=syncBusy?.key===syncPageKey&&syncBusy.scope==='users';
  useEffect(()=>{liveSyncKey.current=syncPageKey;syncRun.current?.abort.abort();syncRun.current=null;setSyncBusy(null);return()=>{liveSyncKey.current='';syncRun.current?.abort.abort();};},[syncPageKey]);

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

  const refreshAll = async () => {
    const key=testKey,page=syncPageKey;
    await Promise.all([refresh(), refreshLibraries(), refreshUsers()]);
    if(liveTestKey.current===key)setTestNeedsReadKey(null);
    if(liveSyncKey.current===page)setSyncNeedsReadKey(null);
  };

  const handleTestConnection = async () => {
    if (!numericServerId || !server || !testKey || testRun.current || syncRun.current || testNeedsReadKey===testKey || syncNeedsReadKey===syncPageKey) return;
    const key=testKey, token=auth.accessToken, abort=new AbortController();
    const current=()=>liveTestKey.current===key&&token===getAccessToken();
    testRun.current={key,abort};setTestBusyKey(key);
    try {
      const receipt=await checkServerConnection(numericServerId,server.revision,current,abort.signal);
      if(!current())return;
      try { await refresh(); }
      catch { if(current()){setTestNeedsReadKey(key);showError('Connection succeeded, but saved status could not be refreshed. Refresh the page.');}return; }
      if(current())success(`Connection succeeded. Checked at ${formatDateTime(receipt.checked_at)}.`);
    } catch (err) {
      if(current()){setTestNeedsReadKey(key);showError(err instanceof Error ? err.message : 'Connection test could not be confirmed. Refresh saved status.');}
    } finally {
      if(testRun.current?.key===key){testRun.current=null;if(current())setTestBusyKey(null);}
    }
  };

  const handleSync = async (scope:ServerSyncScope) => {
    if(!numericServerId||!server?.effective_active||!testKey||!syncPageKey||testRun.current||syncRun.current||syncNeedsReadKey===syncPageKey||testNeedsReadKey===testKey)return;
    const key=syncPageKey,selection=testKey,token=auth.accessToken,abort=new AbortController();
    const samePage=()=>liveSyncKey.current===key&&token===getAccessToken();
    const current=()=>samePage()&&liveTestKey.current===selection;
    syncRun.current={key,abort};setSyncBusy({key,scope});
    try{
      const receipt=await syncSelectedServer(numericServerId,server.revision,scope,current,abort.signal);
      if(!samePage())return;
      try{await Promise.all([refresh(),scope==='libraries'?refreshLibraries():refreshUsers()]);}
      catch{if(samePage()){setSyncNeedsReadKey(key);showError('Synchronization committed, but the saved view could not refresh. Refresh and inspect before another attempt.');}return;}
      if(samePage())success(scope==='libraries'?`Library sync completed: ${receipt.libraries} libraries observed.`:`User sync completed: ${receipt.users} users observed; ${receipt.added} added, ${receipt.updated} updated, ${receipt.removed} made inactive.`);
    }catch(err){if(samePage()){setSyncNeedsReadKey(key);showError(err instanceof Error?err.message:'Synchronization could not be confirmed. Refresh saved data.');}}
    finally{if(syncRun.current?.key===key){syncRun.current=null;if(samePage())setSyncBusy(null);}}
  };
  const syncUnavailable=!testKey||!server?.effective_active||testingConnection||syncingLibraries||syncingUsers||syncNeedsReadKey===syncPageKey||testNeedsReadKey===testKey;

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

        {section === 'overview' ? (<div className="space-y-6">
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
                    <span className="text-muted-foreground">Provider Enabled:</span>
                    <span className="font-medium text-right inline-flex items-center gap-1.5">
                      <FontAwesomeIcon icon={server.provider_enabled ? faCheckCircle : faXmarkCircle} className={server.provider_enabled ? 'text-emerald-500' : 'text-destructive'} />
                      {server.provider_enabled ? 'Yes' : 'No'}
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
                    disabled={!testKey || testNeedsReadKey===testKey || syncNeedsReadKey===syncPageKey || testingConnection || syncingLibraries || syncingUsers}
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
                    onClick={()=>void handleSync('libraries')}
                    disabled={syncUnavailable}
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
                    onClick={()=>void handleSync('users')}
                    disabled={syncUnavailable}
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
                {(testNeedsReadKey===testKey||syncNeedsReadKey===syncPageKey)&&<p className="text-sm text-muted-foreground">Inspect saved state before another action.</p>}
                <Button variant="outline" className="w-full" disabled={testingConnection||syncingLibraries||syncingUsers} onClick={()=>void refreshAll().catch(()=>showError('Saved state could not be refreshed. Reload the page before another action.'))}>
                  <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
                  Refresh saved state
                </Button>
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

          {/* The Graphs page's charts, for this server's recorded plays */}
          {numericServerId !== undefined && ACTIVITY_GRAPH_SERVICES.has(serviceType.toLowerCase()) && (
            <ActivityGraphs key={numericServerId} serverId={numericServerId} />
          )}
        </div>) : null}

        {section === 'users' ? (<div className="space-y-6">
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
                                to="/admin/users/$uuid"
                                params={{ uuid: user.uuid }}
                                search={{ tab: 'profile' }}
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
        </div>) : null}

        {/* The server's own dashboard graphs (Plex only for now) */}
        {section === 'resources' ? (
          numericServerId !== undefined && serviceType.toLowerCase() === 'plex' ? (
            <PlexResources key={numericServerId} serverId={numericServerId} />
          ) : (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">Resource graphs are available for Plex servers.</CardContent>
            </Card>
          )
        ) : null}

        {section === 'libraries' ? (<div className="space-y-6">
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
                              to="/admin/servers/$serverId/libraries/$libraryId"
                              params={{ serverId: String(library.server_id ?? numericServerId), libraryId: String(library.id) }}
                              search={{ tab: 'overview' }}
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
        </div>) : null}
    </div>
  );
};

export default ServerDetailPage;
