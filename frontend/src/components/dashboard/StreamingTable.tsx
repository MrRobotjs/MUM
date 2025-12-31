import useSWR from 'swr';
import { requestJson } from '../../util/apiClient';
import { Pagination } from '../common/Pagination';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export type StreamRow = {
  id: number;
  user_uuid?: string;
  user_display_name?: string;
  user_avatar_url?: string;
  media_title?: string;
  media_type?: string;
  server_id?: number;
  server_name?: string;
  started_at?: string;
  stopped_at?: string;
  duration_seconds?: number;
  platform?: string;
  thumb_url?: string;
  poster_url?: string;
};

type StreamsResponse = {
  data: StreamRow[];
  meta: {
    pagination: {
      page: number;
      page_size: number;
      total_items: number;
      total_pages: number;
    };
  };
};

type StreamingTableProps = {
  page?: number;
  serviceType?: string;
  status?: string;
  userName?: string;
  startDate?: string;
  endDate?: string;
  onPageChange?: (page: number) => void;
};

export const StreamingTable = ({
  page = 1,
  serviceType,
  status,
  userName,
  startDate,
  endDate,
  onPageChange
}: StreamingTableProps) => {
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (serviceType) params.set('service_type', serviceType);
  if (status) params.set('status', status);
  if (userName) params.set('user_name', userName);
  if (startDate) params.set('start', startDate);
  if (endDate) params.set('end', endDate);
  const { data, isLoading: loading, error } = useSWR<StreamsResponse>(
    `/admin/api/v2/streams?${params.toString()}`,
    (url: string) => requestJson<StreamsResponse>(url),
    { revalidateOnFocus: false }
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="loading loading-spinner loading-sm" /> Loading streams…
      </div>
    );
  }

  if (error) {
    return <div className="text-sm text-red-600 dark:text-red-400">Failed to load streams: {error}</div>;
  }

  const rows = data?.data ?? [];
  const pagination = data?.meta.pagination;
  const totalPages = pagination?.total_pages ?? 1;
  const currentPage = pagination?.page ?? page;

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-foreground shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="text-xs uppercase text-muted-foreground">
            <TableHead>Title</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Server</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Platform</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((stream) => (
            <TableRow key={stream.id}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-3">
                  {stream.poster_url || stream.thumb_url ? (
                    <img
                      src={stream.poster_url || stream.thumb_url}
                      alt={stream.media_title ?? 'Media poster'}
                      className="h-12 w-8 rounded-md object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="h-12 w-8 rounded-md bg-muted/60" />
                  )}
                  <span className="leading-tight">{stream.media_title ?? 'Unknown'}</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Avatar className="h-7 w-7">
                    <AvatarImage
                      src={stream.user_avatar_url || ''}
                      alt={stream.user_display_name ?? stream.user_uuid ?? 'User avatar'}
                    />
                    <AvatarFallback>
                      {(stream.user_display_name ?? stream.user_uuid ?? 'U')[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span>{stream.user_display_name ?? stream.user_uuid ?? 'Unknown user'}</span>
                </div>
              </TableCell>
              <TableCell>{stream.server_name ?? 'Unknown server'}</TableCell>
              <TableCell>{stream.started_at ? new Date(stream.started_at).toLocaleString() : '-'}</TableCell>
              <TableCell>{stream.platform ?? '-'}</TableCell>
              <TableCell>
                {stream.duration_seconds ? Math.round(stream.duration_seconds / 60) + ' min' : '-'}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                No stream history found.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
        <TableCaption className="sr-only">Streaming session history</TableCaption>
      </Table>

      {onPageChange && totalPages > 1 ? (
        <div className="border-t bg-muted/50 px-4 py-3">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={onPageChange}
            loading={loading}
          />
        </div>
      ) : null}
    </div>
  );
};

export default StreamingTable;
