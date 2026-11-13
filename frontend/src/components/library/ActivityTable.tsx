import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClockRotateLeft, faFilm } from '@fortawesome/free-solid-svg-icons';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Pagination } from '../common/Pagination';

type ActivityTableProps = {
  days: number;
  onDaysChange: (days: number) => void;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  rows: any[];
  /** Shown when the window has no plays, e.g. "... for this library ...". */
  emptyMessage: string;
};

/** The recent-plays table of a library's or a show's Activity tab: time
 * window, plays with poster, viewer, start, duration and player, and paging. */
export const ActivityTable = ({ days, onDaysChange, page, totalPages, onPageChange, loading, rows, emptyMessage }: ActivityTableProps) => {
  const { formatTimestamp } = useAccountDisplay();
  return (
    <>
      {/* Time Range Selector */}
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold flex items-center">
          <FontAwesomeIcon icon={faClockRotateLeft} className="mr-2 h-5 w-5" />
          Recent Activity
        </h3>
        <Select value={days.toString()} onValueChange={(val) => onDaysChange(Number(val))}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 Days</SelectItem>
            <SelectItem value="30">Last 30 Days</SelectItem>
            <SelectItem value="90">Last 90 Days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-xl border shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Content</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Player / Platform</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 10 }).map((_, idx) => (
                <TableRow key={idx}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Skeleton className="w-12 h-16 flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Skeleton className="w-8 h-8 rounded-full" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : rows.length > 0 ? (
              rows.map((stream: any) => {
                const formatDuration = (seconds: number) => {
                  const hours = Math.floor(seconds / 3600);
                  const minutes = Math.floor((seconds % 3600) / 60);
                  if (hours > 0) {
                    return `${hours}h ${minutes}m`;
                  }
                  return `${minutes}m`;
                };

                const formatDate = (dateStr: string) => formatTimestamp(dateStr, 'date');
                const formatTime = (dateStr: string) => formatTimestamp(dateStr, 'time');

                return (
                  <TableRow key={stream.id} className="hover:bg-accent/50">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {/* Poster Thumbnail */}
                        <div className="w-12 h-16 flex-shrink-0">
                          {stream.thumb_path ? (
                            <img
                              src={stream.thumb_path}
                              alt={stream.media_title || 'Unknown'}
                              className="w-full h-full object-cover rounded border border-border shadow-sm"
                              loading="lazy"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                                if (e.currentTarget.nextElementSibling) {
                                  (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                                }
                              }}
                            />
                          ) : null}
                          <div className={`w-full h-full bg-muted/50 rounded border border-border flex items-center justify-center ${stream.thumb_path ? 'hidden' : 'flex'}`}>
                            <FontAwesomeIcon icon={faFilm} className="h-6 w-6 text-muted-foreground opacity-40" />
                          </div>
                        </div>

                        {/* Content Info */}
                        <div className="flex flex-col min-w-0 flex-1">
                          <div className="font-medium truncate">{stream.media_title || 'Unknown'}</div>
                          {(stream.grandparent_title || stream.parent_title) && (
                            <div className="text-sm text-muted-foreground truncate">
                              {stream.grandparent_title}
                              {stream.grandparent_title && stream.parent_title && ' • '}
                              {stream.parent_title}
                            </div>
                          )}
                          {stream.media_type && (
                            <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-400/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20 dark:ring-blue-500/20 gap-1 w-fit mt-1">
                              {stream.media_type}
                            </span>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {/* User Avatar */}
                        <div className="w-8 h-8 flex-shrink-0">
                          {stream.user_avatar_url ? (
                            <img
                              src={stream.user_avatar_url}
                              alt={`${stream.user_display_name} avatar`}
                              className="w-full h-full object-cover rounded-full border border-border"
                              loading="lazy"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                                if (e.currentTarget.nextElementSibling) {
                                  (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                                }
                              }}
                            />
                          ) : null}
                          <div className={`w-full h-full rounded-full border border-border flex items-center justify-center text-white text-xs font-medium bg-primary ${stream.user_avatar_url ? 'hidden' : 'flex'}`}>
                            {stream.user_display_name?.[0]?.toUpperCase() || 'U'}
                          </div>
                        </div>

                        {/* User Name */}
                        <div className="flex flex-col">
                          <div className="font-medium truncate">{stream.user_display_name}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{stream.started_at ? formatDate(stream.started_at) : '—'}</span>
                        <span className="text-sm text-muted-foreground">{stream.started_at ? formatTime(stream.started_at) : ''}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">
                        {stream.duration_seconds ? formatDuration(stream.duration_seconds) : '—'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        {stream.platform && (
                          <span className="font-medium">{stream.platform}</span>
                        )}
                        {stream.player && (
                          <span className="text-sm text-muted-foreground">{stream.player}</span>
                        )}
                        {!stream.platform && !stream.player && (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center">
                  <div className="flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center mb-4">
                      <FontAwesomeIcon icon={faClockRotateLeft} className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-medium mb-2">No Recent Activity</h3>
                    <p className="text-sm text-muted-foreground">
                      {emptyMessage}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="border-t">
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              onPageChange={onPageChange}
              loading={loading}
            />
          </div>
        )}
      </div>
    </>
  );
};
