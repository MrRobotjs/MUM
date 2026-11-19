import { Link } from '@tanstack/react-router';
import { faClockRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { Pagination } from '../common/Pagination';
import { TabHeading } from '../users/AccountSettings';
import { createAppColumnHelper, useAppTable } from '../table/DataTable';
import { Poster } from './LibraryOverview';

// One play as the activity endpoints send it.
export type ActivityRow = {
  id: number; media_title?: string | null; media_type?: string | null; grandparent_title?: string | null; parent_title?: string | null;
  user_display_name?: string | null; user_uuid?: string | null; started_at?: string | null; duration_seconds?: number | null;
  platform?: string | null; product?: string | null; player?: string | null; thumb_path?: string | null;
};
const columnHelper = createAppColumnHelper<ActivityRow>();

// Whole minutes, as the History tab shows durations ("3 mins").
const minutes = (seconds?: number | null) => {
  const n = Math.round((seconds ?? 0) / 60);
  return `${n.toLocaleString()} ${n === 1 ? 'min' : 'mins'}`;
};
const none = <span className="text-muted-foreground" title="Not recorded">—</span>;
// The History tab's header and cell classes, so both tables look the same.
const headClass = 'text-left py-3 px-4 text-sm font-medium text-muted-foreground';
const cellClass = 'py-3 px-4 text-sm whitespace-nowrap';

type ActivityTableProps = {
  days: number;
  onDaysChange: (days: number) => void;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  rows: ActivityRow[];
  /** Shown when the window has no plays, e.g. "... for this library ...". */
  emptyMessage: string;
};

/** The Activity tab of a library or a show: plays in the chosen window, laid
 * out like the profile History tab (poster, title, viewer, date and times,
 * platform, product, player), with paging. */
export const ActivityTable = ({ days, onDaysChange, page, totalPages, onPageChange, loading, rows, emptyMessage }: ActivityTableProps) => {
  const { formatTimestamp } = useAccountDisplay();
  const columns = [
    columnHelper.display({ id: 'poster', header: 'Poster', meta: { headClassName: 'w-20 py-3 px-4 text-sm font-medium text-muted-foreground', cellClassName: 'py-3 px-4' },
      cell: ({ row: { original: play } }) => <Poster url={play.thumb_path ?? null} title={play.media_title || 'Unknown'} className="w-12 h-18" /> }),
    columnHelper.display({ id: 'title', header: 'Media Title', meta: { headClassName: headClass, cellClassName: 'account-history-title py-3 px-4' },
      cell: ({ row: { original: play } }) => <>
        <div className="font-medium">{play.media_title || 'Unknown'}</div>
        {(play.grandparent_title || play.parent_title) && <div className="text-xs text-muted-foreground">{[play.grandparent_title, play.parent_title].filter(Boolean).join(' • ')}</div>}
      </> }),
    columnHelper.display({ id: 'user', header: 'User', meta: { headClassName: headClass, cellClassName: cellClass },
      cell: ({ row: { original: play } }) => play.user_uuid
        ? <Link to="/admin/users/$uuid" params={{ uuid: play.user_uuid }} className="account-profile-link"><span className="truncate">{play.user_display_name || 'Unknown'}</span></Link>
        : play.user_display_name || none }),
    columnHelper.display({ id: 'date', header: 'Date', meta: { headClassName: headClass, cellClassName: cellClass },
      cell: ({ row: { original: play } }) => play.started_at ? formatTimestamp(play.started_at, 'date') : none }),
    columnHelper.display({ id: 'started', header: 'Started', meta: { headClassName: headClass, cellClassName: cellClass },
      cell: ({ row: { original: play } }) => play.started_at ? formatTimestamp(play.started_at, 'time') : none }),
    columnHelper.display({ id: 'duration', header: 'Duration', meta: { headClassName: headClass, cellClassName: cellClass },
      cell: ({ row: { original: play } }) => play.duration_seconds ? minutes(play.duration_seconds) : none }),
    columnHelper.display({ id: 'platform', header: 'Platform', meta: { headClassName: headClass, cellClassName: cellClass }, cell: ({ row }) => row.original.platform || none }),
    columnHelper.display({ id: 'product', header: 'Product', meta: { headClassName: headClass, cellClassName: cellClass }, cell: ({ row }) => row.original.product || none }),
    columnHelper.display({ id: 'player', header: 'Player', meta: { headClassName: headClass, cellClassName: cellClass }, cell: ({ row }) => row.original.player || none }),
  ];
  const table = useAppTable({ columns, data: rows, getRowId: play => String(play.id) });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faClockRotateLeft} title="Recent activity" description="Plays MUM recorded in the chosen period, newest first." />
          <Select value={days.toString()} onValueChange={(val) => onDaysChange(Number(val))}>
            <SelectTrigger className="w-56" aria-label="Period"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 Days</SelectItem>
              <SelectItem value="30">Last 30 Days</SelectItem>
              <SelectItem value="90">Last 90 Days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, idx) => <div key={idx} className="flex items-center gap-4">
              <Skeleton className="w-12 h-16 flex-shrink-0" />
              <div className="flex-1 space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-32" /></div>
            </div>)}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground/60">
            <FontAwesomeIcon icon={faClockRotateLeft} className="text-3xl" />
            <p className="text-sm">{emptyMessage}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                {table.getHeaderGroups().map(group => <tr key={group.id} className="border-b border-border">
                  {group.headers.map(header => <th key={header.id} className={header.column.columnDef.meta?.headClassName}><table.FlexRender header={header} /></th>)}
                </tr>)}
              </thead>
              <tbody>
                {table.getRowModel().rows.map(row => <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                  {row.getVisibleCells().map(cell => <td key={cell.id} className={cell.column.columnDef.meta?.cellClassName}><table.FlexRender cell={cell} /></td>)}
                </tr>)}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={onPageChange} loading={loading} />
        )}
      </CardContent>
    </Card>
  );
};
