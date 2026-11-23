import { appPaths, appLinks } from '../../router/appLinks';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { Link } from '@tanstack/react-router';
import { sortFn_basic, sortFn_text, type SortingState } from '@tanstack/react-table';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBook, faFilm, faFolder, faImage, faLayerGroup, faMagnifyingGlass, faMusic, faRotate, faTv, faVideo, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '../../contexts/AuthContext';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { fetchServerLibraries, type ServerLibrary } from '../../lib/serverLibraries';
import { watchTime } from '../../lib/identityPlayTotals';
import type { TimelineRecords } from '../../lib/identityTimeline';
import { TabHeading } from '../users/AccountSettings';
import { applyUpdater, createAppColumnHelper, useAppTable, useRememberedColumns } from '../table/DataTable';
import { LastPlayed } from './LastPlayed';

// A server's Libraries page: each library with its activity on this server
// only, for the chosen records. A server has few libraries, so
// the whole list is read at once and sorted in the browser.

type Column = 'library' | 'type' | 'items' | 'parents' | 'children' | 'lastStreamed' | 'lastPlayed' | 'plays' | 'watch';
const columnLabels: Record<Column, string> = { library: 'Library', type: 'Type', items: 'Items', parents: 'Seasons / Albums', children: 'Episodes / Tracks', lastStreamed: 'Last Streamed', lastPlayed: 'Last Played',
  plays: 'Plays', watch: 'Watch Time' };
const allColumns = Object.keys(columnLabels) as Column[];
const recordsLabels: Record<TimelineRecords, string> = { all: 'All plays', mum: 'Recorded by MUM', server: 'From server history' };
// Sorted by its value; a missing value comes last both ways, as on the Users page.
const columnSort: Record<Column, { value: (library: ServerLibrary) => string | number | undefined; text?: boolean; descFirst?: boolean }> = {
  library: { value: l => l.name.toLowerCase(), text: true },
  type: { value: l => l.library_type?.toLowerCase() ?? undefined, text: true },
  items: { value: l => l.item_count ?? undefined, descFirst: true },
  parents: { value: l => l.parent_count ?? undefined, descFirst: true },
  children: { value: l => l.child_count ?? undefined, descFirst: true },
  lastStreamed: { value: l => l.last_streamed_at ?? undefined, descFirst: true },
  lastPlayed: { value: l => l.last_played ? (l.last_played.title || '').toLowerCase() : undefined, text: true },
  plays: { value: l => l.plays, descFirst: true },
  watch: { value: l => l.watch_seconds ?? undefined, descFirst: true },
};
const columnHelper = createAppColumnHelper<ServerLibrary>();
const noLibraries: ServerLibrary[] = [];
const typeLabel = (type: string | null) => type ? type.replace(/_/g, ' ') : 'Unknown';
// The library's type as an icon: films, TV, music, books, photos or videos.
export function libraryTypeIcon(type: string | null): IconDefinition {
  const t = (type ?? '').toLowerCase();
  if (t.includes('movie')) return faFilm;
  if (t.includes('show') || t.includes('tv') || t.includes('series')) return faTv;
  if (t.includes('artist') || t.includes('music')) return faMusic;
  if (t.includes('book')) return faBook;
  if (t.includes('photo')) return faImage;
  if (t.includes('video')) return faVideo;
  return faFolder;
}

export function ServerLibrariesCard({ serverId, serverSlug, serviceType, onSync, syncing, syncDisabled }: {
  serverId: number; serverSlug: string; serviceType: string; onSync: () => void; syncing: boolean; syncDisabled: boolean;
}) {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const { formatTimestamp, formatRelative } = useAccountDisplay();
  const [records, setRecords] = useState<TimelineRecords>('all');
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'library', desc: false }]);
  const [columnVisibility, onColumnVisibilityChange] = useRememberedColumns('mum.server-libraries.columns', undefined, ['library']);

  const key = isAdministrator && user?.uuid && session.accessToken ? ['server-libraries', user.uuid, session.accessToken, serverId, records] as const : null;
  const { data, error, isLoading, mutate } = useSWR(key, ([, , , id, r]) => fetchServerLibraries(id, r), { keepPreviousData: true });

  // A finished library sync changes the list: read it again.
  const wasSyncing = useRef(syncing);
  useEffect(() => {
    if (wasSyncing.current && !syncing) void mutate();
    wasSyncing.current = syncing;
  }, [syncing, mutate]);

  const live = data?.live ?? ['plex', 'jellyfin', 'emby'].includes(serviceType);
  // Watch time comes from MUM's recordings; it's left out when they aren't shown.
  const mumColumns = live && records !== 'server';
  const columns = useMemo(() => {
    const watch = (seconds: number | null) => seconds === null ? '—' : watchTime(String(seconds)).map(([value, unit]) => `${value} ${unit}`).join(' ');
    const cell = (column: Column, library: ServerLibrary) => {
      switch (column) {
        case 'library': return <Link {...appLinks.library(serverSlug, library.id)}
          search={{ tab: 'overview' }} className="account-library-link">{library.name}</Link>;
        case 'type': return <span className="capitalize">{typeLabel(library.library_type)}</span>;
        case 'items': return library.item_count?.toLocaleString() ?? '—';
        case 'parents': return library.parent_count?.toLocaleString() ?? '—';
        case 'children': return library.child_count?.toLocaleString() ?? '—';
        case 'lastStreamed': return library.last_streamed_at ? <span title={formatTimestamp(library.last_streamed_at)}>{formatRelative(library.last_streamed_at)}</span> : '—';
        case 'lastPlayed': return library.last_played ? <LastPlayed serverId={serverId} play={library.last_played} /> : '—';
        case 'plays': return library.plays.toLocaleString();
        case 'watch': return watch(library.watch_seconds);
      }
    };
    // The type icon leads each row; it has no label, so it isn't in Select columns.
    const icon = columnHelper.display({ id: 'icon', header: () => null, enableHiding: false, meta: { headClassName: 'w-12', cellClassName: 'w-12' },
      cell: ({ row }) => <FontAwesomeIcon icon={libraryTypeIcon(row.original.library_type)} fixedWidth className="h-5 w-5 text-muted-foreground" aria-label={typeLabel(row.original.library_type)} /> });
    return [icon, ...allColumns.filter(id => mumColumns || id !== 'watch').map(id => columnHelper.accessor(columnSort[id].value, {
      id, header: columnLabels[id], cell: info => cell(id, info.row.original), enableHiding: id !== 'library',
      sortFn: columnSort[id].text ? sortFn_text : sortFn_basic, sortUndefined: 'last', sortDescFirst: columnSort[id].descFirst ?? false,
      meta: { label: columnLabels[id], cellClassName: id === 'lastPlayed' ? 'account-history-title' : 'whitespace-nowrap' },
    }))];
  }, [serverSlug, serverId, formatTimestamp, formatRelative, mumColumns]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const items = (data?.items as ServerLibrary[] | undefined) ?? noLibraries;
    return needle ? items.filter(l => l.name.toLowerCase().includes(needle)) : items;
  }, [data, search]);
  const table = useAppTable({
    columns, data: shown, getRowId: library => String(library.id),
    enableMultiSort: false, enableSortingRemoval: false,
    state: { sorting, columnVisibility },
    onSortingChange: updater => setSorting(current => applyUpdater(updater, current)),
    onColumnVisibilityChange,
  });
  const count = data?.items.length ?? 0;
  const totalItems = data?.items.reduce((sum, library) => sum + (library.item_count ?? 0), 0) ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faLayerGroup} title="Libraries"
            description={data ? `${count.toLocaleString()} librar${count === 1 ? 'y' : 'ies'} • ${totalItems.toLocaleString()} items on ${data.server_name}` : 'Libraries on this server'} />
          <div className="flex flex-wrap items-center gap-2">
            {live && <Select value={records} onValueChange={(value: TimelineRecords) => setRecords(value)}>
              <SelectTrigger className="w-56" aria-label="Records"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(recordsLabels) as TimelineRecords[]).map(r => <SelectItem key={r} value={r}>{recordsLabels[r]}</SelectItem>)}</SelectContent>
            </Select>}
            <Button variant="outline" size="sm" onClick={onSync} disabled={syncDisabled || syncing}>
              {syncing ? <Spinner className="size-4" /> : <FontAwesomeIcon icon={faRotate} />}{syncing ? 'Syncing…' : 'Sync libraries'}
            </Button>
            <table.AppTable><table.ColumnsMenu /></table.AppTable>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative max-w-md">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search libraries" className="pl-9" maxLength={200} aria-label="Search libraries" />
        </div>
        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">Failed to load libraries for this server.</div>
          : isLoading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Loading libraries...</div>
          : shown.length > 0 ? <div className="overflow-x-auto rounded-xl border shadow-sm">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map(group => <TableRow key={group.id}>
                  {group.headers.map(h => <table.AppHeader key={h.id} header={h}>{header => {
                    const sorted = header.column.getIsSorted();
                    return <TableHead className={header.column.columnDef.meta?.headClassName ?? 'whitespace-nowrap'} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}><header.SortButton /></TableHead>;
                  }}</table.AppHeader>)}
                </TableRow>)}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map(row => <TableRow key={row.id}>
                  {row.getVisibleCells().map(cell => <TableCell key={cell.id} className={cell.column.columnDef.meta?.cellClassName}><table.FlexRender cell={cell} /></TableCell>)}
                </TableRow>)}
              </TableBody>
            </Table>
          </div>
          : <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">{search.trim() ? 'No libraries match this search.' : 'No libraries yet. Sync libraries to fetch them from this server.'}</div>}
      </CardContent>
    </Card>
  );
}
