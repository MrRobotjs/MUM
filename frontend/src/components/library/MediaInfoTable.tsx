import { appLinks } from '../../router/appLinks';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { Link } from '@tanstack/react-router';
import type { SortingState } from '@tanstack/react-table';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Pagination } from '../common/Pagination';
import { TabHeading } from '../users/AccountSettings';
import { applyUpdater, createAppColumnHelper, useAppTable, useRememberedColumns } from '../table/DataTable';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { audioChannelsLabel, mediaBitrateLabel, mediaSizeLabel } from '../../lib/mediaInfo';
import { fetchLibraryMediaInfo, type LibraryMediaInfoRow, type MediaInfoSort } from '../../lib/libraryMediaInfo';

// A library's Media Info tab: one row per file with its container, bitrate,
// codecs, resolution, frame rate, audio channels and size from the last library
// sync, and its plays. The server sorts, searches and pages.

const columnHelper = createAppColumnHelper<LibraryMediaInfoRow>();
const pageSizes = [25, 50, 100] as const;
const none = <span className="text-muted-foreground">—</span>;
const labels: Record<MediaInfoSort, string> = {
  added: 'Added', title: 'Title', container: 'Container', bitrate: 'Bitrate', video_codec: 'Video Codec', video_resolution: 'Video Resolution',
  video_frame_rate: 'Video Frame Rate', audio_codec: 'Audio Codec', audio_channels: 'Audio Channels', size: 'File Size', last_played: 'Last Played', plays: 'Total Plays',
};
// Numbers and dates start with the largest or newest; text starts at A.
const descFirst: readonly MediaInfoSort[] = ['added', 'bitrate', 'video_resolution', 'video_frame_rate', 'audio_channels', 'size', 'last_played', 'plays'];
const episodeCode = (row: LibraryMediaInfoRow) => row.season_number !== null && row.episode_number !== null
  ? `S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}` : '';

export function MediaInfoTable({ libraryId, libraryName, serverSlug }: { libraryId: number; libraryName: string; serverSlug: string }) {
  const { formatTimestamp, formatRelative } = useAccountDisplay();
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'title', desc: false }]);
  const [columnVisibility, onColumnVisibilityChange] = useRememberedColumns('mum.library-media-info.columns', undefined, ['title']);

  // Search after typing stops, from the first page.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(typed.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const sort = (sorting[0]?.id ?? 'title') as MediaInfoSort;
  const desc = sorting[0]?.desc ?? false;
  // Cached per signed-in session, so one person's rows never show after another signs in.
  const key = isAdministrator && user?.uuid && session.accessToken ? ['library-media-info', user.uuid, session.accessToken, libraryId, page, pageSize, sort, desc, search] as const : null;
  const { data, error, isLoading } = useSWR(key,
    ([, , , id, p, size, s, d, q]) => fetchLibraryMediaInfo(id, { page: p, pageSize: size, sort: s, desc: d, search: q }), { keepPreviousData: true });

  const columns = useMemo(() => {
    const link = (row: LibraryMediaInfoRow) => row.item_type === 'episode' && row.parent_id !== null
      ? appLinks.episode(serverSlug, libraryId, row.parent_id, row.id)
      : row.parent_id !== null ? appLinks.media(serverSlug, libraryId, row.parent_id) : appLinks.media(serverSlug, libraryId, row.id);
    const cell = (id: MediaInfoSort, row: LibraryMediaInfoRow) => {
      const m = row.media_info;
      switch (id) {
        case 'added': return row.added_at ? <span title={formatTimestamp(row.added_at)}>{formatTimestamp(row.added_at, 'date')}</span> : none;
        case 'title': return <>
          <Link {...link(row)} className="account-library-link">{row.title}</Link>
          {row.parent_title && <div className="text-xs text-muted-foreground">{[row.parent_title, episodeCode(row)].filter(Boolean).join(' · ')}</div>}
        </>;
        case 'container': return m?.container ?? none;
        case 'bitrate': return m?.bitrate_kbps ? mediaBitrateLabel(m.bitrate_kbps) : none;
        case 'video_codec': return m?.video_codec ?? none;
        case 'video_resolution': return m?.video_resolution ?? none;
        case 'video_frame_rate': return m?.video_frame_rate ?? none;
        case 'audio_codec': return m?.audio_codec ?? none;
        case 'audio_channels': return m?.audio_channels ? audioChannelsLabel(m.audio_channels) : none;
        case 'size': return m?.size_bytes ? mediaSizeLabel(m.size_bytes) : none;
        case 'last_played': return row.last_played_at ? <span title={formatTimestamp(row.last_played_at)}>{formatRelative(row.last_played_at)}</span> : none;
        case 'plays': return row.plays.toLocaleString();
      }
    };
    return (Object.keys(labels) as MediaInfoSort[]).map(id => columnHelper.accessor(row => row.id, {
      id, header: labels[id], cell: info => cell(id, info.row.original), enableHiding: id !== 'title', sortDescFirst: descFirst.includes(id),
      meta: { label: labels[id], cellClassName: id === 'title' ? 'account-history-title' : 'whitespace-nowrap' },
    }));
  }, [serverSlug, libraryId, formatTimestamp, formatRelative]);

  const rows = (data?.items as LibraryMediaInfoRow[] | undefined) ?? [];
  const table = useAppTable({
    columns, data: rows, getRowId: row => String(row.id),
    manualSorting: true, enableMultiSort: false, enableSortingRemoval: false,
    state: { sorting, columnVisibility },
    onSortingChange: updater => { setSorting(current => applyUpdater(updater, current)); setPage(1); },
    onColumnVisibilityChange,
  });
  const total = data?.total_items ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faCircleInfo} title="Media Info"
            description={data ? `${total.toLocaleString()} ${total === 1 ? 'file' : 'files'} in ${libraryName}, as of the last library sync` : `Files in ${libraryName}`} />
          <table.AppTable><table.ColumnsMenu /></table.AppTable>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-md">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Search titles, containers, codecs…" aria-label="Search media info" className="pl-9" maxLength={200} />
          </div>
          <Select value={String(pageSize)} onValueChange={value => { setPageSize(Number(value)); setPage(1); }}>
            <SelectTrigger className="w-32" aria-label="Rows per page"><SelectValue /></SelectTrigger>
            <SelectContent>{pageSizes.map(size => <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">Couldn’t load the media info for this library.</div>
          : isLoading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Loading media info…</div>
          : rows.length > 0 ? <div className="overflow-x-auto rounded-xl border shadow-sm">
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
                  {row.getVisibleCells().map(cell => <TableCell key={cell.id} className={cell.column.columnDef.meta?.cellClassName}><table.FlexRender cell={cell} /></TableCell>)}
                </TableRow>)}
              </TableBody>
            </Table>
          </div>
          : <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            {search ? 'No files match this search.' : 'No files yet. Sync this library’s catalogue on the Media tab.'}
          </div>}
        {(data?.total_pages ?? 1) > 1 && <Pagination currentPage={page} totalPages={data?.total_pages ?? 1} onPageChange={setPage} loading={isLoading} />}
      </CardContent>
    </Card>
  );
}
