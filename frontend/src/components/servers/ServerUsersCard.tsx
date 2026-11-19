import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { Link } from '@tanstack/react-router';
import type { PaginationState, SortingState } from '@tanstack/react-table';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faUsers, faRotate, faFileImport, faMagnifyingGlass, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '../../contexts/AuthContext';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { fetchServerAccounts, serverAccountPageSizes, serverAccountSort, type ServerAccount, type ServerAccountColumn, type ServerAccountPageSize } from '../../lib/serverAccounts';
import { importsHistory, playHistorySummary, readPlayHistory, startPlayHistoryImport, type PlayHistoryStatus } from '../../lib/playHistory';
import { watchTime } from '../../lib/identityPlayTotals';
import type { TimelineRecords } from '../../lib/identityTimeline';
import { TabHeading } from '../users/AccountSettings';
import { AvatarName } from '../users/AccountAvatar';
import { LastPlayed } from './LastPlayed';
import { applyUpdater, createAppColumnHelper, useAppTable, useRememberedColumns } from '../table/DataTable';

// A server's Users page: its accounts with their
// activity on this server only, for the chosen records, with search, sorting,
// paging, a column menu, user sync and history import. TanStack Table holds
// the sorting, paging and column state; the server searches, sorts and pages.

type Column = ServerAccountColumn;
const columnLabels: Record<Column, string> = { user: 'User', username: 'Username', email: 'Email', lastStreamed: 'Last Streamed', lastPlayed: 'Last Played',
  lastIp: 'Last Known IP', lastPlatform: 'Last Platform', lastPlayer: 'Last Player', plays: 'Plays', watch: 'Watch Time', libraries: 'Libraries', expires: 'Access Expires' };
const allColumns = Object.keys(columnLabels) as Column[];
// Columns only MUM's own recordings fill.
const mumOnly: readonly Column[] = ['lastIp', 'lastPlatform', 'lastPlayer', 'watch'];
// Each column's first click sorts the way people usually want it: names A–Z,
// times and counts newest or highest first, expiry soonest first.
const descFirst: readonly Column[] = ['lastStreamed', 'plays', 'watch', 'libraries'];
const pageSizeKey = 'mum.server-users.page-size';
const readPageSize = (): ServerAccountPageSize => {
  try {
    const value = Number(localStorage.getItem(pageSizeKey));
    return serverAccountPageSizes.find(size => size === value) ?? 25;
  } catch { return 25; }
};

const recordsLabels: Record<TimelineRecords, string> = { all: 'All plays', mum: 'Recorded by MUM', server: 'From server history' };

const columnHelper = createAppColumnHelper<ServerAccount>();
const noAccounts: ServerAccount[] = [];

export function ServerUsersCard({ serverId, serviceType, onSync, syncing, syncDisabled }: {
  serverId: number; serviceType: string; onSync: () => void; syncing: boolean; syncDisabled: boolean;
}) {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const { formatTimestamp, formatRelative, current: display } = useAccountDisplay();
  const [records, setRecords] = useState<TimelineRecords>('all');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'user', desc: false }]);
  const [pagination, setPagination] = useState<PaginationState>(() => ({ pageIndex: 0, pageSize: readPageSize() }));
  const [columnVisibility, onColumnVisibilityChange] = useRememberedColumns('mum.server-users.columns', undefined, ['user']);
  const [importStatus, setImportStatus] = useState<PlayHistoryStatus | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const firstPage = () => setPagination(current => current.pageIndex === 0 ? current : { ...current, pageIndex: 0 });

  // Search as you type, once typing pauses.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(typed); firstPage(); }, 300);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const sort = serverAccountSort(sorting[0]);
  const pageSize = serverAccountPageSizes.find(size => size === pagination.pageSize) ?? 25;
  const key = isAdministrator && user?.uuid && session.accessToken ? ['server-accounts', user.uuid, session.accessToken, serverId, records, search, sort, pagination.pageIndex + 1, pageSize] as const : null;
  const { data, error, isLoading, mutate } = useSWR(key, ([, , , id, r, s, o, p, n]) => fetchServerAccounts(id, { records: r, search: s, sort: o, page: p, pageSize: n }), { keepPreviousData: true });

  // A finished user sync changes the list: read it again.
  const wasSyncing = useRef(syncing);
  useEffect(() => {
    if (wasSyncing.current && !syncing) void mutate();
    wasSyncing.current = syncing;
  }, [syncing, mutate]);

  // A running import is checked every 2 seconds until it ends.
  useEffect(() => {
    if (importStatus?.state !== 'running') return;
    const timer = window.setInterval(() => {
      readPlayHistory(serverId).then(status => {
        setImportStatus(status);
        if (status.state !== 'running') void mutate();
      }).catch(() => setImportError('Couldn’t read the import’s progress.'));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [importStatus?.state, serverId, mutate]);

  const live = data?.live ?? ['plex', 'jellyfin', 'emby'].includes(serviceType);
  // Columns the chosen records can't fill are left out of the table.
  const mumColumns = live && records !== 'server';
  const startImport = async () => {
    setImporting(true);
    setImportError(null);
    try {
      await startPlayHistoryImport(serverId);
      setImportStatus(await readPlayHistory(serverId));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'The import couldn’t start.');
    } finally {
      setImporting(false);
    }
  };

  const columns = useMemo(() => {
    const watch = (seconds: number | null) => seconds === null ? '—' : watchTime(String(seconds)).map(([value, unit]) => `${value} ${unit}`).join(' ');
    const cell = (column: Column, account: ServerAccount) => {
      switch (column) {
        case 'user': return <Link to="/admin/users/$uuid" params={{ uuid: account.uuid }} className="account-profile-link font-medium">
          <AvatarName key={account.uuid} url={account.avatar_url} name={account.username || 'Unnamed account'} />
        </Link>;
        case 'username': return account.username || '—';
        case 'email': return account.email ?? '—';
        case 'lastStreamed': return account.last_streamed_at ? <span title={formatTimestamp(account.last_streamed_at)}>{formatRelative(account.last_streamed_at)}</span> : '—';
        case 'lastPlayed': return account.last_played ? <LastPlayed serverId={serverId} play={account.last_played} /> : '—';
        case 'lastIp': return <span className="font-mono">{account.last_ip ?? '—'}</span>;
        case 'lastPlatform': return account.last_platform ?? '—';
        case 'lastPlayer': return account.last_player ?? '—';
        case 'plays': return account.plays.toLocaleString();
        case 'watch': return watch(account.watch_seconds);
        case 'libraries': return <span title={account.libraries.join(', ')}>{account.has_all_libraries ? 'All libraries' : `${account.libraries.length} selected`}</span>;
        case 'expires': return account.access_expires_at ? formatTimestamp(account.access_expires_at, 'date') : 'Never';
      }
    };
    // The accessor value is only sorting's bookkeeping: the server sorts.
    return allColumns.filter(id => mumColumns || !mumOnly.includes(id)).map(id => columnHelper.accessor(account => account.uuid, {
      id, header: columnLabels[id], cell: info => cell(id, info.row.original), sortDescFirst: descFirst.includes(id), enableHiding: id !== 'user',
      meta: { label: columnLabels[id], cellClassName: id === 'user' || id === 'lastPlayed' ? 'account-history-title' : 'whitespace-nowrap' },
    }));
  }, [serverId, formatTimestamp, formatRelative, mumColumns]);

  const table = useAppTable({
    columns, data: (data?.items as ServerAccount[] | undefined) ?? noAccounts, getRowId: account => account.uuid,
    manualSorting: true, manualPagination: true, enableMultiSort: false, enableSortingRemoval: false, rowCount: data?.total_items ?? 0,
    state: { sorting, pagination, columnVisibility },
    onSortingChange: updater => { setSorting(current => applyUpdater(updater, current)); firstPage(); },
    onPaginationChange: updater => setPagination(current => {
      const next = applyUpdater(updater, current);
      if (next.pageSize === current.pageSize) return next;
      try { localStorage.setItem(pageSizeKey, String(next.pageSize)); } catch { /* not remembered */ }
      return { pageIndex: 0, pageSize: next.pageSize };
    }),
    onColumnVisibilityChange,
  });
  const total = data?.total_items ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faUsers} title="Users" description={data ? `${total.toLocaleString()} user${total === 1 ? '' : 's'} on ${data.server_name}` : 'Accounts on this server'} />
          <div className="flex flex-wrap items-center gap-2">
            {live && <Select value={records} onValueChange={(value: TimelineRecords) => { setRecords(value); firstPage(); }}>
              <SelectTrigger className="w-56" aria-label="Records"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(recordsLabels) as TimelineRecords[]).map(r => <SelectItem key={r} value={r}>{recordsLabels[r]}</SelectItem>)}</SelectContent>
            </Select>}
            <Button variant="outline" size="sm" onClick={onSync} disabled={syncDisabled || syncing}>
              {syncing ? <Spinner className="size-4" /> : <FontAwesomeIcon icon={faRotate} />}{syncing ? 'Syncing…' : 'Sync users'}
            </Button>
            {importsHistory(serviceType) && <Button variant="outline" size="sm" onClick={() => void startImport()} disabled={importing || importStatus?.state === 'running'}>
              {importStatus?.state === 'running' ? <Spinner className="size-4" /> : <FontAwesomeIcon icon={faFileImport} />}Import history
            </Button>}
            <table.AppTable><table.ColumnsMenu /></table.AppTable>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative max-w-md">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Search username or email" className="pl-9" maxLength={200} aria-label="Search users" />
        </div>
        {importStatus && importsHistory(serviceType) && <p className="text-sm text-muted-foreground" role="status">{playHistorySummary(importStatus, serviceType, display?.display)}</p>}
        {importError && <p className="text-sm text-destructive" role="status">{importError}</p>}
        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">Failed to load users for this server.</div>
          : isLoading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Loading users...</div>
          : data && data.items.length > 0 ? <>
            <div className="overflow-x-auto rounded-xl border shadow-sm">
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map(group => <TableRow key={group.id}>
                    {group.headers.map(h => <table.AppHeader key={h.id} header={h}>{header => {
                      const sorted = header.column.getIsSorted();
                      return <TableHead className="whitespace-nowrap" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}><header.SortButton /></TableHead>;
                    }}</table.AppHeader>)}
                  </TableRow>)}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.map(row => <TableRow key={row.id}>
                    {row.getVisibleCells().map(cell => <TableCell key={cell.id} className={cell.column.columnDef.meta?.cellClassName}>
                      <table.FlexRender cell={cell} />
                    </TableCell>)}
                  </TableRow>)}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                Show
                <Select value={String(pageSize)} onValueChange={value => table.setPageSize(serverAccountPageSizes.find(s => String(s) === value) ?? 25)}>
                  <SelectTrigger className="w-20" size="sm" aria-label="Users per page"><SelectValue /></SelectTrigger>
                  <SelectContent>{serverAccountPageSizes.map(size => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent>
                </Select>
                users per page
              </div>
              {table.getPageCount() > 1 && <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}><FontAwesomeIcon icon={faChevronLeft} />Previous</Button>
                <span className="text-sm text-muted-foreground">Page {pagination.pageIndex + 1} of {table.getPageCount()}</span>
                <Button variant="outline" size="sm" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next<FontAwesomeIcon icon={faChevronRight} /></Button>
              </div>}
            </div>
          </>
          : <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">{search ? 'No users match this search.' : 'No service users found for this server.'}</div>}
      </CardContent>
    </Card>
  );
}
