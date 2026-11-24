import { appPaths, appLinks } from '../../router/appLinks';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { RowSelectionState } from '@tanstack/react-table';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faBars, faBook, faCirclePlay, faClockRotateLeft, faFileImport, faFilm, faFolder, faGears, faMusic, faPlay, faPodcast, faTrashCan, faTv, faVideo,
} from '@fortawesome/free-solid-svg-icons';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getServiceMeta } from '@/config/mediaServiceMetadata';
import { ServiceIcon } from '@/components/services/ServiceIcon';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useAlerts } from '../../contexts/AlertContext';
import {
  deleteServerTimelinePlays, deleteTimelinePlays, historyServiceName, timelineMethods,
  type TimelineCategory, type TimelineItem, type TimelineMethod, type TimelinePerson, type TimelineRecords, type TimelineServer,
} from '../../lib/identityTimeline';
import { fetchPersonHistoryImport, historyImportSupport, personImportSummary, startPersonHistoryImport } from '../../lib/personHistoryImport';
import { startPlayHistoryImport } from '../../lib/playHistory';
import { observationProgress } from '../../lib/activityHistory';
import { applyUpdater, createAppColumnHelper, useAppTable, useRememberedColumns } from '../table/DataTable';
import { ConfirmAction, TabHeading } from '../users/AccountSettings';
import { stableHistoryPosterURL } from '../../lib/historyPosterURL';

// The History table shared by a person's History tab, a server's History tab
// and the History page: one server at a time, MUM's recorded plays and the
// plays imported from that server's own history, newest first, with the
// columns that server type reports, type and stream filters, a column menu,
// delete mode and history import. A person's history imports and deletes
// their plays only; a server's shows everyone's, with a User column and a
// person filter, and imports and deletes on the whole server.

// Poster cell: a signed history image when the play kept one, otherwise the
// play icon (also when the image fails to load).
export const HistoryPoster = ({ url, title, className = 'w-12 h-18' }: { url?: string; title: string; className?: string }) => {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const previous = useRef<string | undefined>(undefined);
  const stableUrl = stableHistoryPosterURL(previous.current, url);
  previous.current = stableUrl;
  return (
    <div className={cn(className, 'rounded bg-muted/30 flex items-center justify-center overflow-hidden')}>
      {stableUrl && failed !== stableUrl ? (
        <img src={stableUrl} alt={title || 'Media poster'} className="w-full h-full object-cover" onError={() => { previous.current = undefined; setFailed(stableUrl); }} />
      ) : (
        <FontAwesomeIcon icon={faPlay} className="text-muted-foreground/40 text-sm" />
      )}
    </div>
  );
};

// Whole minutes, for paused and watched time ("3 mins").
const minutes=(seconds:string)=>{const n=Math.round(Number(BigInt(seconds))/60);return `${n.toLocaleString()} ${n===1?'min':'mins'}`;};

const playMethodLabels: Record<string, string> = { direct_play: 'Direct Play', direct_stream: 'Direct Stream', transcode: 'Transcode' };

// Provider positions are in 100 ns ticks; shown as Flask did ("12m 5s").
const formatTicks = (ticks: string | null) => {
  if (ticks === null) return '0m';
  const seconds = Number(BigInt(ticks) / 10000000n);
  const mins = Math.floor(seconds / 60), secs = seconds % 60;
  if (mins > 0) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  return `${secs}s`;
};


// The History tab shows one server at a time: pickers for the server and the
// records, a toolbar and the
// columns that server type reports.
export type HistoryView = Readonly<{ server?: string; user?: string; records: TimelineRecords; types: readonly TimelineCategory[]; methods: readonly TimelineMethod[] }>;
export const initialHistoryView: HistoryView = { records: 'all', types: [], methods: [] };

export type HistoryMode = Readonly<{ kind: 'person'; target: string } | { kind: 'server'; pickServer: boolean }>;
type HistoryPage = Readonly<{
  server_id: string | null; servers: readonly TimelineServer[]; categories: readonly TimelineCategory[]; items: TimelineItem[];
  next_before: string | null; people?: readonly TimelinePerson[];
}>;
export type HistorySource = Readonly<{
  page: HistoryPage | undefined; pending: boolean; loading: boolean; error: Error | undefined; refresh: () => Promise<unknown>;
  hasPrevious: boolean; previous: () => void; next: () => void;
}>;

type HistoryColumn = 'poster' | 'title' | 'library' | 'source' | 'user' | 'platform' | 'product' | 'player' | 'decision' | 'date' | 'ip' | 'started' | 'paused' | 'stopped' | 'duration' | 'author' | 'listened' | 'progress';
const historyColumnLabels: Record<HistoryColumn, string> = { poster: 'Poster', title: 'Media Title', library: 'Library', source: 'History Source', user: 'User', platform: 'Platform', product: 'Product', player: 'Player', decision: 'Transcode Decision', date: 'Date', ip: 'IP Address',
  started: 'Started', paused: 'Paused', stopped: 'Stopped', duration: 'Duration', author: 'Author', listened: 'Listened', progress: 'Progress' };
const historyColumnHints: Partial<Record<HistoryColumn, string>> = {
  product: 'The app they played on',
  player: 'The device’s name',
  decision: 'How the server sent the stream: Direct Play, Direct Stream or Transcode',
  started: 'When playback started: from Plex’s notification when MUM received one, otherwise MUM’s first check of the server, or the time the server recorded',
  stopped: 'When playback stopped: from Plex’s notification when MUM received one, otherwise MUM’s last check of the server',
  duration: 'Time watched: from start to stop, less paused time',
  listened: 'How long the session was listened to',
};
// Columns each server type reports; the title can't be hidden. A server's
// history adds who played each play after the title.
const historyColumns = (type: string, people: boolean): HistoryColumn[] => {
  const base = typeColumns(type);
  const columns: HistoryColumn[] = [...base.slice(0, 2), 'library', 'source', ...base.slice(2)];
  return people ? [...columns.slice(0, 2), 'user', ...columns.slice(2)] : columns;
};
const typeColumns = (type: string): HistoryColumn[] => type === 'all' ? ['poster', 'title', 'platform', 'product', 'player', 'decision', 'date', 'ip', 'started', 'paused', 'stopped', 'duration', 'author', 'listened', 'progress']
  : type === 'audiobookshelf' ? ['poster', 'title', 'author', 'date', 'listened', 'progress']
  : type === 'plex' ? ['poster', 'title', 'platform', 'product', 'player', 'decision', 'date', 'ip', 'started', 'paused', 'stopped', 'duration', 'progress']
  : ['poster', 'title', 'product', 'player', 'decision', 'date', 'started', 'paused', 'stopped', 'duration', 'progress'];
// Hidden columns per server type, remembered per browser; a server's history
// remembers its own.
const historyColumnKey = 'mum.history.columns';
const serverHistoryColumnKey = 'mum.history.server.columns';
const historyHeadClass = (column: HistoryColumn) => column === 'poster' ? 'w-20 py-3 px-4 text-sm font-medium text-muted-foreground' : column === 'progress' ? 'text-center py-3 px-4 text-sm font-medium text-muted-foreground' : 'text-left py-3 px-4 text-sm font-medium text-muted-foreground';
const historyCellClass = (column: HistoryColumn) => column === 'progress' ? 'py-3 px-4 text-center' : column === 'title' ? 'account-history-title py-3 px-4' : column === 'poster' ? 'py-3 px-4' : 'py-3 px-4 text-sm whitespace-nowrap';
const historyColumnHelper = createAppColumnHelper<TimelineItem>();
const noTimelineItems: TimelineItem[] = [];

const categoryButtons: Record<TimelineCategory, { label: string; icon: IconDefinition }> = {
  movies: { label: 'Movies', icon: faFilm }, tv: { label: 'TV Shows', icon: faTv }, music: { label: 'Music', icon: faMusic },
  videos: { label: 'Videos', icon: faVideo }, books: { label: 'Books', icon: faBook }, podcasts: { label: 'Podcasts', icon: faPodcast },
};
const methodButtons: Record<TimelineMethod, { label: string; icon: IconDefinition }> = {
  direct_play: { label: 'Direct Play', icon: faCirclePlay }, direct_stream: { label: 'Direct Stream', icon: faBars }, transcode: { label: 'Transcode', icon: faGears },
};
const serviceLabel = (type: string) => getServiceMeta(type).label;

export const HistoryTable = ({ history, mode, view, onViewChange, admin, description }: {
  history: HistorySource; mode: HistoryMode; view: HistoryView; onViewChange: (view: HistoryView) => void; admin: boolean; description: string;
}) => {
  const target = mode.kind === 'person' ? mode.target : '';
  const everyone = mode.kind === 'server';
  const { formatTimestamp } = useAccountDisplay();
  const { success, error: showError } = useAlerts();
  const { page, pending, loading, error, refresh, hasPrevious, previous, next } = history;
  const [deleteMode, setDeleteMode] = useState(false);
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importNote, setImportNote] = useState<{ server: string; text: string; running: boolean } | null>(null);
  const [fullImport, setFullImport] = useState<TimelineServer | null>(null);
  const [importing, setImporting] = useState(false);
  const allServers = everyone && page?.server_id === 'all';
  const shown = allServers ? {server_id:'all',name:'All Servers',service_type:'all',live:page?.servers.some(s=>s.live) ?? false,history:true} : page?.servers.find(s => s.server_id === page.server_id);
  const streams = Boolean(shown?.live) && view.records !== 'server';
  const shownType = shown?.service_type ?? '';
  const serverSignature = JSON.stringify((page?.servers ?? []).map(s => [s.server_id, s.service_type, s.name]));
  const serverNames = useMemo(() => JSON.parse(serverSignature) as [string, string, string][], [serverSignature]);
  const [columnVisibility, onColumnVisibilityChange] = useRememberedColumns(everyone ? serverHistoryColumnKey : historyColumnKey, shownType, ['title']);

  // The table's columns: the shown server type's, with a delete column in delete mode.
  const columns = useMemo(() => {
    const cell = (column: HistoryColumn, row: TimelineItem) => {
      const service = row.source === 'mum' ? null : historyServiceName[row.source];
      const none = <span className="text-muted-foreground" title={service ? `Not recorded by ${service}` : 'Not recorded'}>—</span>;
      switch (column) {
        case 'poster': return <HistoryPoster url={row.poster_url} title={row.title} />;
        case 'title': return <>
          <div className="font-medium">{row.title || (service ? 'Removed item' : 'Unknown Title')}</div>
          {allServers && (() => { const source = serverNames.find(s => s[0] === row.server_id); return source ? <div className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground"><ServiceIcon serviceType={source[1]} className="h-3 w-3" />{source[2]}</div> : null; })()}
          {row.parent_title && shownType !== 'audiobookshelf' && <div className="text-xs text-muted-foreground">{row.parent_title}</div>}
        </>;
        case 'library': return row.library_name ? <span><FontAwesomeIcon icon={faFolder} className="mr-1 h-3 w-3" />{row.library_name}</span> : none;
        case 'source': return service ? <span className="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold bg-muted text-muted-foreground" title={`Imported from the ${service} server's own play history`}>{service} history</span> : <span>Recorded by MUM</span>;
        case 'user': return <Link {...appLinks.user(row.person_uuid)} className="account-library-link">{row.person_name}</Link>;
        case 'platform': return row.platform ?? none;
        case 'product': return row.client ?? none;
        case 'player': return row.player ?? none;
        case 'decision': return row.play_method ? playMethodLabels[row.play_method] ?? none : none;
        case 'date': return formatTimestamp(row.played_at, 'date');
        case 'ip': return <span className="font-mono">{row.ip_address ?? none}</span>;
        case 'started': return formatTimestamp(row.played_at, 'time');
        case 'paused': return row.paused_seconds !== null ? minutes(row.paused_seconds) : none;
        case 'stopped': return row.stopped_at !== null ? formatTimestamp(row.stopped_at, 'time') : none;
        case 'duration': return row.watched_seconds !== null ? minutes(row.watched_seconds) : none;
        case 'author': return row.parent_title ?? none;
        case 'listened': return row.listened_seconds !== null ? minutes(row.listened_seconds) : none;
        case 'progress': {
          if (row.position_ticks === null) return <span className="text-xs text-muted-foreground">{row.source === 'plex' ? 'Watched' : 'Played'}</span>;
          const percent = Math.min(Math.round(observationProgress(row.position_ticks, row.duration_ticks) ?? 0), 100);
          return <div className="inline-flex items-center justify-center" title={row.duration_ticks !== null ? `${formatTicks(row.position_ticks)} of ${formatTicks(row.duration_ticks)}` : formatTicks(row.position_ticks)}>
            <div className="relative size-12">
              <svg className="size-12 transform -rotate-90">
                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" className="text-muted/30" />
                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray={`${2 * Math.PI * 20}`} strokeDashoffset={`${2 * Math.PI * 20 * (1 - percent / 100)}`} className="text-primary transition-all" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center"><span className="text-xs font-mono font-semibold">{percent}%</span></div>
            </div>
          </div>;
        }
      }
    };
    const data = historyColumns(shownType, everyone).map(column => historyColumnHelper.display({
      id: column, header: column === 'title' && shownType === 'audiobookshelf' ? 'Title' : historyColumnLabels[column], cell: info => cell(column, info.row.original),
      enableHiding: column !== 'title',
      meta: { label: column === 'title' && shownType === 'audiobookshelf' ? 'Title' : historyColumnLabels[column], headClassName: historyHeadClass(column), cellClassName: historyCellClass(column) },
    }));
    if (!deleteMode) return data;
    // Delete mode: a button per play marks it; plays still being watched can't be marked.
    return [historyColumnHelper.display({
      id: 'delete', header: () => <span className="sr-only">Delete</span>, enableHiding: false,
      meta: { headClassName: 'w-12 py-3 px-4', cellClassName: 'py-3 px-4' },
      cell: ({ row }) => <Button variant={row.getIsSelected() ? 'destructive' : 'ghost'} size="icon-sm" disabled={!row.getCanSelect()} aria-pressed={row.getIsSelected()}
        aria-label={`${row.getIsSelected() ? 'Keep' : 'Delete'} ${row.original.title || 'this play'}`} title={row.original.in_progress ? 'Still playing: it can be deleted once it ends' : undefined}
        onClick={() => row.toggleSelected()}><FontAwesomeIcon icon={faTrashCan} /></Button>,
    }), ...data];
  }, [shownType, everyone, deleteMode, formatTimestamp, allServers, serverNames]);
  const rowSelection = useMemo<RowSelectionState>(() => Object.fromEntries([...marked].map(id => [id, true])), [marked]);
  const table = useAppTable({
    columns, data: (page?.items as TimelineItem[] | undefined) ?? noTimelineItems, getRowId: row => row.id,
    enableRowSelection: row => !row.original.in_progress,
    state: { columnVisibility, rowSelection },
    onColumnVisibilityChange,
    onRowSelectionChange: updater => { const next = applyUpdater(updater, rowSelection); setMarked(new Set(Object.keys(next).filter(id => next[id]))); },
  });

  // Filters the shown server and records don't offer are dropped, judged on
  // the page that answers the current view.
  useEffect(() => {
    if (!page || pending) return;
    const types = view.types.filter(t => page.categories.includes(t));
    const methods = streams ? view.methods : [];
    if (types.length !== view.types.length || methods.length !== view.methods.length) onViewChange({ ...view, types, methods });
  }, [page, pending, streams, view, onViewChange]);

  // A running import is checked every 2 seconds until it ends.
  useEffect(() => {
    if (!importNote?.running || everyone) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      fetchPersonHistoryImport(target, importNote.server).then(status => {
        if (stopped || status.state === 'running') return;
        setImportNote({ server: importNote.server, text: personImportSummary(status), running: false });
        void refresh();
      }).catch(() => { if (!stopped) setImportNote({ server: importNote.server, text: 'Couldn’t read the import’s progress.', running: false }); });
    }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [importNote, target, everyone, refresh]);

  const toggleDeleteMode = () => {
    if (!deleteMode) { setMarked(new Set()); setDeleteMode(true); return; }
    setDeleteMode(false);
    if (marked.size > 0) setConfirmDelete(true);
  };
  useEffect(() => { setDeleteMode(false); setMarked(new Set()); setConfirmDelete(false); }, [page?.server_id]);
  const toggleMark = (id: string) => setMarked(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const finishDelete = () => { setConfirmDelete(false); setMarked(new Set()); };
  const deleteMarked = async () => {
    setDeleting(true);
    try {
      const ids = [...marked];
      const count = everyone ? await deleteServerTimelinePlays(page?.server_id ?? '', ids) : await deleteTimelinePlays(target, ids);
      success(`Deleted ${count} history item${count === 1 ? '' : 's'}.`);
      void refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'The history items couldn’t be deleted.');
    } finally {
      setDeleting(false);
      finishDelete();
    }
  };
  const startImport = async () => {
    if (!shown) return;
    // A server's history imports the whole server; Jellyfin and Emby can only
    // import the whole server, so a person's history asks first.
    if (everyone) { setFullImport(shown); return; }
    if (historyImportSupport(shown.service_type) === 'server') { setFullImport(shown); return; }
    setImporting(true);
    try {
      const result = await startPersonHistoryImport(target, shown.server_id);
      if (result === 'started') setImportNote({ server: shown.server_id, text: `Importing their history from ${shown.name}…`, running: true });
      else if (result === 'busy') setImportNote({ server: shown.server_id, text: `An import is already running on ${shown.name}. Try again when it finishes.`, running: false });
      else if (result === 'full_import_only') setFullImport(shown);
      else setImportNote({ server: shown.server_id, text: `${shown.name} can’t import history right now. Check that it’s active and has an API key.`, running: false });
    } catch (err) {
      showError(err instanceof Error ? err.message : 'The import couldn’t start.');
    } finally {
      setImporting(false);
    }
  };
  const runFullImport = async () => {
    const server = fullImport;
    if (!server) return;
    setImporting(true);
    try {
      await startPlayHistoryImport(Number(server.server_id));
      setImportNote({ server: server.server_id, text: `Importing every user’s history from ${server.name}…${everyone ? ' New plays appear here as they arrive.' : ''}`, running: !everyone });
    } catch (err) {
      showError(err instanceof Error ? err.message : 'The import couldn’t start.');
    } finally {
      setImporting(false);
      setFullImport(null);
    }
  };

  // The servers offered: a person's, or on the History page every server with history.
  const offered = everyone ? page?.servers.filter(s => s.history) ?? [] : page?.servers ?? [];
  const showServers = mode.kind === 'person' ? offered.length > 1 : mode.pickServer && offered.length > 0;
  const pickers = page && <>
    {showServers && <Select value={page.server_id ?? undefined} onValueChange={server => onViewChange({ ...initialHistoryView, server })}>
      <SelectTrigger className="w-auto" aria-label="Server"><SelectValue /></SelectTrigger>
      <SelectContent>{everyone && <SelectItem value="all">All Servers</SelectItem>}{offered.map(s => <SelectItem key={s.server_id} value={s.server_id}>
        <span className="inline-flex items-center gap-2"><ServiceIcon serviceType={s.service_type} />{s.name}</span>
      </SelectItem>)}</SelectContent>
    </Select>}
    {everyone && shown?.history && <Select value={view.user ?? 'all'} onValueChange={user => onViewChange({ ...view, user: user === 'all' ? undefined : user })}>
      <SelectTrigger className="w-auto" aria-label="User"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All users</SelectItem>
        {(page.people ?? []).map(p => <SelectItem key={p.uuid} value={p.uuid}>{p.name}</SelectItem>)}
      </SelectContent>
    </Select>}
    {shown?.live && <Select value={view.records} onValueChange={(records: TimelineRecords) => onViewChange({ ...view, records })}>
      <SelectTrigger className="w-56" aria-label="Records"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All plays</SelectItem>
        <SelectItem value="mum">Recorded by MUM</SelectItem>
        <SelectItem value="server">From server history</SelectItem>
      </SelectContent>
    </Select>}
  </>;
  const heading = <CardHeader>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <TabHeading icon={faClockRotateLeft} title="History" description={description} />
      <div className="flex flex-wrap items-center gap-2">{pickers}</div>
    </div>
  </CardHeader>;
  if (error) return <section className="space-y-4"><div className="rounded border border-red-500/40 bg-red-50 dark:bg-red-400/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">Failed to load history: {error.message} <Button variant="outline" onClick={() => void refresh().catch(() => {})}>Refresh history</Button></div></section>;
  if (loading || !page) return <section className="space-y-4"><div className="flex items-center gap-3 rounded border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"><Spinner className="size-4" />Fetching recent history…</div></section>;
  const empty = (text: string) => <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground/60"><FontAwesomeIcon icon={faClockRotateLeft} className="text-3xl" /><p className="text-sm">{text}</p></div>;
  if (!shown) return <section className="space-y-4"><Card>{heading}<CardContent>{empty(everyone ? 'No media server has play history yet.' : 'They have no media server accounts.')}</CardContent></Card></section>;
  if (!shown.history) return <section className="space-y-4"><Card>{heading}<CardContent>{empty(`${serviceLabel(shown.service_type)} doesn’t share ${everyone ? 'play' : 'users’'} history, so MUM has none to show for ${shown.name}.`)}</CardContent></Card></section>;

  const toggleFilter = <T extends string>(list: readonly T[], value: T) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];
  const canImport = admin && !allServers && historyImportSupport(shown.service_type) !== 'none';
  const filtered = view.types.length > 0 || view.methods.length > 0 || Boolean(view.user);


  return (
    <section className="space-y-4">
      <Card>
        {heading}
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="History tools">
            {admin && <Button variant={deleteMode ? 'destructive' : 'outline'} size="sm" aria-pressed={deleteMode} onClick={toggleDeleteMode}><FontAwesomeIcon icon={faTrashCan} />Delete mode</Button>}
            {page.categories.map(category => <Button key={category} variant={view.types.includes(category) ? 'default' : 'outline'} size="sm" aria-pressed={view.types.includes(category)}
              onClick={() => onViewChange({ ...view, types: toggleFilter(view.types, category) })}><FontAwesomeIcon icon={categoryButtons[category].icon} />{categoryButtons[category].label}</Button>)}
            {streams && timelineMethods.map(method => <Button key={method} variant={view.methods.includes(method) ? 'default' : 'outline'} size="sm" aria-pressed={view.methods.includes(method)}
              onClick={() => onViewChange({ ...view, methods: toggleFilter(view.methods, method) })}><FontAwesomeIcon icon={methodButtons[method].icon} />{methodButtons[method].label}</Button>)}
            {canImport && <Button variant="outline" size="sm" disabled={importing || Boolean(importNote?.running)} onClick={() => void startImport()}><FontAwesomeIcon icon={faFileImport} />Import history</Button>}
            <table.AppTable><table.ColumnsMenu /></table.AppTable>
            {pending && <Spinner className="size-4 text-muted-foreground" role="status" aria-label="Loading history" />}
          </div>
          {deleteMode && <p className="text-sm text-muted-foreground" role="status">Select rows to delete. They’re deleted when you leave delete mode{marked.size > 0 ? ` (${marked.size} selected)` : ''}.</p>}
          {importNote && importNote.server === shown.server_id && <p className="text-sm text-muted-foreground" role="status">{importNote.text}</p>}
          {page.items.length === 0 && !hasPrevious ? empty(filtered ? 'No plays match these filters.' : 'No history to display yet.') : <div className="account-history-table overflow-x-auto" aria-busy={pending}>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {table.getHeaderGroups()[0]?.headers.map(header => <th key={header.id} className={header.column.columnDef.meta?.headClassName}
                    title={historyColumnHints[header.column.id as HistoryColumn]}><table.FlexRender header={header} /></th>)}
                </tr>
              </thead>
              <tbody>
                {table.getRowModel().rows.map(row => (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    {row.getVisibleCells().map(cell => <td key={cell.id} className={cell.column.columnDef.meta?.cellClassName}><table.FlexRender cell={cell} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          {(hasPrevious || page.next_before) && <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={!hasPrevious} onClick={previous}>Newer</Button><Button variant="outline" disabled={!page.next_before} onClick={next}>Older</Button></div>}
        </CardContent>
      </Card>
      <ConfirmAction open={confirmDelete} onOpenChange={open => { if (!open) finishDelete(); }} title="Delete history" confirmLabel="Delete" destructive busy={deleting} onConfirm={() => void deleteMarked()}>
        <p>Are you sure you want to delete {marked.size} history item{marked.size === 1 ? '' : 's'}?</p>
        <p>This is permanent and cannot be undone.</p>
      </ConfirmAction>
      <ConfirmAction open={fullImport !== null} onOpenChange={open => { if (!open && !importing) setFullImport(null); }} title="Import the whole server?" confirmLabel="Run full import" busy={importing} onConfirm={() => void runFullImport()}>
        {everyone
          ? <p>Import every user’s plays from {fullImport?.name}? Plays MUM already has are skipped.</p>
          : <><p>{fullImport ? serviceLabel(fullImport.service_type) : 'This server'} can’t import a single user’s history.</p>
            <p>Run a full import of {fullImport?.name} instead? It imports every user’s plays on that server; plays MUM already has are skipped.</p></>}
      </ConfirmAction>
    </section>
  );
};
