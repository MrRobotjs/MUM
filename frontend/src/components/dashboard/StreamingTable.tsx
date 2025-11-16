import { useState } from 'react';
import useSWR from 'swr';
import { useAlerts } from '../../contexts/AlertContext';
import { FormField } from '../index';
import { requestJson } from '../../util/apiClient';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
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
  media_title?: string;
  media_type?: string;
  server_id?: number;
  server_name?: string;
  started_at?: string;
  stopped_at?: string;
  duration_seconds?: number;
  platform?: string;
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
  userUuid?: string;
  startDate?: string;
  endDate?: string;
  onLoadMore?: () => void;
};

export const StreamingTable = ({
  page = 1,
  serviceType,
  status,
  userUuid,
  startDate,
  endDate,
  onLoadMore
}: StreamingTableProps) => {
  const { success, error: showError } = useAlerts();
  const [terminateTarget, setTerminateTarget] = useState<StreamRow | null>(null);
  const [terminateMessage, setTerminateMessage] = useState('');
  const [terminating, setTerminating] = useState(false);
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (serviceType) params.set('service_type', serviceType);
  if (status) params.set('status', status);
  if (userUuid) params.set('user_uuid', userUuid);
  if (startDate) params.set('start', startDate);
  if (endDate) params.set('end', endDate);
  const { data, isLoading: loading, error, mutate } = useSWR<StreamsResponse>(
    `/admin/api/v2/streams?${params.toString()}`,
    (url: string) => requestJson<StreamsResponse>(url),
    { revalidateOnFocus: false }
  );

  const requestTerminate = (stream: StreamRow) => {
    if (stream.stopped_at) return;
    setTerminateTarget(stream);
    setTerminateMessage('');
  };

  const confirmTerminate = async () => {
    if (!terminateTarget) return;
    setTerminating(true);
    try {
      await requestJson(`/admin/api/v2/streams/${terminateTarget.id}/terminate`, {
        method: 'POST',
        body: JSON.stringify({ message: terminateMessage || undefined })
      });
      success('Termination command sent');
      await mutate();
      setTerminateTarget(null);
    } catch (err) {
      showError('Failed to terminate stream: ' + String(err));
    } finally {
      setTerminating(false);
    }
  };

  const closeTerminateModal = () => {
    if (terminating) return;
    setTerminateTarget(null);
    setTerminateMessage('');
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="loading loading-spinner loading-sm" /> Loading streams…
      </div>
    );
  }

  if (error) {
    return <div className="text-sm text-error">Failed to load streams: {error}</div>;
  }

  const rows = data?.data ?? [];
  const pagination = data?.meta.pagination;
  const hasMore = pagination ? pagination.page < pagination.total_pages : false;

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
            <TableHead className="text-right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((stream) => (
            <TableRow key={stream.id}>
              <TableCell className="font-medium">{stream.media_title ?? 'Unknown'}</TableCell>
              <TableCell>{stream.user_uuid ?? 'Unknown user'}</TableCell>
              <TableCell>{stream.server_name ?? 'Unknown server'}</TableCell>
              <TableCell>{stream.started_at ? new Date(stream.started_at).toLocaleString() : '—'}</TableCell>
              <TableCell>{stream.platform ?? '—'}</TableCell>
              <TableCell>
                {stream.duration_seconds ? Math.round(stream.duration_seconds / 60) + ' min' : '—'}
              </TableCell>
              <TableCell className="text-right">
                {!stream.stopped_at ? (
                  <Button variant="ghost" size="sm" onClick={() => requestTerminate(stream)}>
                    Terminate
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                No stream history found.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
        <TableCaption className="sr-only">Streaming session history</TableCaption>
      </Table>

      <div className="border-t bg-muted/50 px-4 py-3 text-right">
        {onLoadMore && hasMore ? (
          <Button variant="ghost" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">End of results</span>
        )}
      </div>
      <ResponsiveDialog
        open={Boolean(terminateTarget)}
        onOpenChange={(value) => {
          if (!value) closeTerminateModal();
        }}
        title="Terminate Stream"
        description="Send a termination command to the media server."
        footer={[
          <Button
            key="cancel"
            variant="outline"
            onClick={closeTerminateModal}
            disabled={terminating}
          >
            Cancel
          </Button>,
          <Button
            key="submit"
            onClick={confirmTerminate}
            disabled={terminating}
            variant="destructive"
          >
            {terminating ? 'Sending…' : 'Terminate Session'}
          </Button>,
        ]}
        contentClassName="max-w-lg"
      >
        {terminateTarget ? (
          <div className="space-y-4">
            <div className="text-sm text-base-content/70">
              Terminate <span className="font-medium text-base-content">{terminateTarget.media_title ?? 'Unknown title'}</span>{' '}
              for user <span className="font-medium text-base-content">{terminateTarget.user_uuid ?? 'Unknown user'}</span>?
            </div>
            <FormField id="terminateMessage" label="Optional message">
              <Textarea
                id="terminateMessage"
                placeholder="e.g., Server maintenance starting soon."
                rows={3}
                value={terminateMessage}
                onChange={(event) => setTerminateMessage(event.target.value)}
                disabled={terminating}
              />
            </FormField>
          </div>
        ) : null}
      </ResponsiveDialog>
    </div>
  );
};

export default StreamingTable;
