import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faUsers, faRotate, faFileImport, faTableColumns, faSort, faSortUp, faSortDown, faMagnifyingGlass, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '../../contexts/AuthContext';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { fetchServerAccounts, serverAccountPageSizes, type ServerAccount, type ServerAccountPageSize, type ServerAccountPlay, type ServerAccountSort } from '../../lib/serverAccounts';
import { importsHistory, playHistorySummary, readPlayHistory, startPlayHistoryImport, type PlayHistoryStatus } from '../../lib/playHistory';
import { watchTime } from '../../lib/identityPlayTotals';
import type { TimelineRecords } from '../../lib/identityTimeline';
import { TabHeading } from '../users/AccountSettings';
import { AvatarName } from '../users/AccountAvatar';

// A server's Users page (SERVER_USERS_DESIGN.md): its accounts with their
// activity on this server only, for the chosen records, with search, sorting,
// paging, a column menu, user sync and history import.

type Column = 'user' | 'username' | 'email' | 'lastStreamed' | 'lastPlayed' | 'lastIp' | 'lastPlatform' | 'lastPlayer' | 'plays' | 'watch' | 'libraries' | 'expires';
const columnLabels: Record<Column, string> = { user: 'User', username: 'Username', email: 'Email', lastStreamed: 'Last Streamed', lastPlayed: 'Last Played',
  lastIp: 'Last Known IP', lastPlatform: 'Last Platform', lastPlayer: 'Last Player', plays: 'Plays', watch: 'Watch Time', libraries: 'Libraries', expires: 'Access Expires' };
const allColumns = Object.keys(columnLabels) as Column[];
// Columns only MUM's own recordings fill.
const mumOnly: readonly Column[] = ['lastIp', 'lastPlatform', 'lastPlayer', 'watch'];
// Each column's first click sorts the way people usually want it: names A–Z,
// times and counts newest or highest first, expiry soonest first.
const sortable: Record<Column, [ServerAccountSort, ServerAccountSort]> = {
  user: ['username_asc', 'username_desc'], username: ['username_asc', 'username_desc'], email: ['email_asc', 'email_desc'],
  lastStreamed: ['last_streamed_desc', 'last_streamed_asc'], lastPlayed: ['last_played_asc', 'last_played_desc'], lastIp: ['last_ip_asc', 'last_ip_desc'],
  lastPlatform: ['last_platform_asc', 'last_platform_desc'], lastPlayer: ['last_player_asc', 'last_player_desc'], plays: ['plays_desc', 'plays_asc'],
  watch: ['watch_desc', 'watch_asc'], libraries: ['libraries_desc', 'libraries_asc'], expires: ['expires_asc', 'expires_desc'] };
const columnKey = 'mum.server-users.columns';
const readHidden = (): Column[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(columnKey) ?? '[]');
    return Array.isArray(value) ? value.filter((c): c is Column => typeof c === 'string' && allColumns.includes(c as Column) && c !== 'user') : [];
  } catch { return []; }
};
const saveHidden = (value: Column[]) => { try { localStorage.setItem(columnKey, JSON.stringify(value)); } catch { /* not remembered */ } };
const pageSizeKey = 'mum.server-users.page-size';
const readPageSize = (): ServerAccountPageSize => {
  try {
    const value = Number(localStorage.getItem(pageSizeKey));
    return serverAccountPageSizes.find(size => size === value) ?? 25;
  } catch { return 25; }
};

const recordsLabels: Record<TimelineRecords, string> = { all: 'All plays', mum: 'Recorded by MUM', server: 'From server history' };

export function ServerUsersCard({ serverId, serviceType, onSync, syncing, syncDisabled }: {
  serverId: number; serviceType: string; onSync: () => void; syncing: boolean; syncDisabled: boolean;
}) {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot);
  const { formatTimestamp, formatRelative } = useAccountDisplay();
  const [records, setRecords] = useState<TimelineRecords>('all');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ServerAccountSort>('username_asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [hidden, setHidden] = useState(readHidden);
  const [importStatus, setImportStatus] = useState<PlayHistoryStatus | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Search as you type, once typing pauses.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(typed); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const key = isAdministrator && user?.uuid && session.accessToken ? ['server-accounts', user.uuid, session.accessToken, serverId, records, search, sort, page, pageSize] as const : null;
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
  const shown = allColumns.filter(c => !hidden.includes(c) && !(mumOnly.includes(c) && (!live || records === 'server')));
  const toggleColumn = (column: Column) => setHidden(current => {
    const next = current.includes(column) ? current.filter(c => c !== column) : [...current, column];
    saveHidden(next);
    return next;
  });
  const sortBy = (column: Column) => {
    const options = sortable[column];
    if (!options) return;
    setSort(sort === options[0] ? options[1] : options[0]);
    setPage(1);
  };
  const sortIcon = (column: Column) => {
    const options = sortable[column];
    if (!options) return null;
    return <FontAwesomeIcon icon={sort === options[0] ? (options[0].endsWith('asc') ? faSortUp : faSortDown) : sort === options[1] ? (options[1].endsWith('asc') ? faSortUp : faSortDown) : faSort} className="ml-1 h-3 w-3 opacity-60" />;
  };
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
  const total = data?.total_items ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faUsers} title="Users" description={data ? `${total.toLocaleString()} user${total === 1 ? '' : 's'} on ${data.server_name}` : 'Accounts on this server'} />
          <div className="flex flex-wrap items-center gap-2">
            {live && <Select value={records} onValueChange={(value: TimelineRecords) => { setRecords(value); setPage(1); }}>
              <SelectTrigger className="w-56" aria-label="Records"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(recordsLabels) as TimelineRecords[]).map(r => <SelectItem key={r} value={r}>{recordsLabels[r]}</SelectItem>)}</SelectContent>
            </Select>}
            <Button variant="outline" size="sm" onClick={onSync} disabled={syncDisabled || syncing}>
              {syncing ? <Spinner className="size-4" /> : <FontAwesomeIcon icon={faRotate} />}{syncing ? 'Syncing…' : 'Sync users'}
            </Button>
            {importsHistory(serviceType) && <Button variant="outline" size="sm" onClick={() => void startImport()} disabled={importing || importStatus?.state === 'running'}>
              {importStatus?.state === 'running' ? <Spinner className="size-4" /> : <FontAwesomeIcon icon={faFileImport} />}Import history
            </Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><FontAwesomeIcon icon={faTableColumns} />Select columns</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {allColumns.map(column => <DropdownMenuCheckboxItem key={column} checked={!hidden.includes(column)} disabled={column === 'user'}
                  onCheckedChange={() => toggleColumn(column)} onSelect={e => e.preventDefault()}>{columnLabels[column]}</DropdownMenuCheckboxItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative max-w-md">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Search username or email" className="pl-9" maxLength={200} aria-label="Search users" />
        </div>
        {importStatus && importsHistory(serviceType) && <p className="text-sm text-muted-foreground" role="status">{playHistorySummary(importStatus, serviceType)}</p>}
        {importError && <p className="text-sm text-destructive" role="status">{importError}</p>}
        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">Failed to load users for this server.</div>
          : isLoading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Loading users...</div>
          : data && data.items.length > 0 ? <>
            <div className="overflow-x-auto rounded-xl border shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow>
                    {shown.map(column => <TableHead key={column} className="whitespace-nowrap">
                      {sortable[column] ? <button type="button" className="inline-flex items-center font-medium" onClick={() => sortBy(column)}>{columnLabels[column]}{sortIcon(column)}</button> : columnLabels[column]}
                    </TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map(account => <TableRow key={account.uuid}>
                    {shown.map(column => <TableCell key={column} className={column === 'user' || column === 'lastPlayed' ? 'account-history-title' : 'whitespace-nowrap'}>{cell(column, account)}</TableCell>)}
                  </TableRow>)}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                Show
                <Select value={String(pageSize)} onValueChange={value => { const size = serverAccountPageSizes.find(s => String(s) === value) ?? 25; setPageSize(size); setPage(1); try { localStorage.setItem(pageSizeKey, String(size)); } catch { /* not remembered */ } }}>
                  <SelectTrigger className="w-20" size="sm" aria-label="Users per page"><SelectValue /></SelectTrigger>
                  <SelectContent>{serverAccountPageSizes.map(size => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent>
                </Select>
                users per page
              </div>
              {data.total_pages > 1 && <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><FontAwesomeIcon icon={faChevronLeft} />Previous</Button>
                <span className="text-sm text-muted-foreground">Page {data.page} of {data.total_pages}</span>
                <Button variant="outline" size="sm" disabled={page >= data.total_pages} onClick={() => setPage(p => p + 1)}>Next<FontAwesomeIcon icon={faChevronRight} /></Button>
              </div>}
            </div>
          </>
          : <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">{search ? 'No users match this search.' : 'No service users found for this server.'}</div>}
      </CardContent>
    </Card>
  );
}

// The last play's title shows its poster on hover, like Tautulli, and opens
// its page in the library when the item has been catalogued.
function LastPlayed({ serverId, play }: { serverId: number; play: ServerAccountPlay }) {
  const [failed, setFailed] = useState(false);
  const text = <span className="block"><span className="block">{play.title || 'Removed item'}</span>{play.parent_title && <span className="block text-xs text-muted-foreground">{play.parent_title}</span>}</span>;
  const target = play.link
    ? play.link.episode_id === null
      ? <Link to="/admin/servers/$serverId/libraries/$libraryId/$mediaId" params={{ serverId: String(serverId), libraryId: String(play.link.library_id), mediaId: String(play.link.media_id) }} className="account-last-played-link">{text}</Link>
      : <Link to="/admin/servers/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId" params={{ serverId: String(serverId), libraryId: String(play.link.library_id), mediaId: String(play.link.media_id), episodeId: String(play.link.episode_id) }} className="account-last-played-link">{text}</Link>
    : text;
  if (!play.poster_url || failed) return target;
  return <Tooltip>
    <TooltipTrigger asChild>{play.link ? target : <span tabIndex={0} className="account-last-played-link">{text}</span>}</TooltipTrigger>
    <TooltipContent side="right" className="account-poster-tip">
      <img src={play.poster_url} alt={play.title || 'Media poster'} onError={() => setFailed(true)} />
    </TooltipContent>
  </Tooltip>;
}
