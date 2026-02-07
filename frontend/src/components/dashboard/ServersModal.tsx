import { useAdminApi } from '../../hooks/useAdminApi';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner'

type ServerItem = {
  id: number;
  server_nickname: string;
  service_type: string;
  url: string;
  is_active: boolean;
  last_status: boolean | null;
  status?: {
    online?: boolean;
    version?: string;
    error_message?: string;
  };
};

type ServersResponse = {
  data: ServerItem[];
};

type ServersModalProps = {
  open: boolean;
  onClose: () => void;
};

export const ServersModal = ({ open, onClose }: ServersModalProps) => {
  const { data, loading, error } = useAdminApi<ServersResponse>('/servers?include_status=true&active_only=true');

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title="All Servers Status"
      description="Current connectivity and version details for configured servers."
      contentClassName="max-w-3xl"
      footer={[
        <button
          key="close"
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted"
          onClick={onClose}
        >
          Close
        </button>,
      ]}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Checking server status.
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Failed to load server status: {(error as Error).message}
        </div>
      ) : (
        <ul className="space-y-2">
          {data?.data.map((server) => {
            const online = server.status?.online;
            return (
              <li
                key={server.id}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  online ? 'border-green-500/30 bg-green-500/5' : 'border-destructive/30 bg-destructive/5'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-foreground">{server.server_nickname}</div>
                    <div className="text-xs uppercase text-muted-foreground">{server.service_type}</div>
                  </div>
                  <Badge variant={online ? 'secondary' : 'destructive'} className="text-xs">
                    {online ? 'Online' : 'Offline'}
                  </Badge>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {server.status?.version ? <div>Version: {server.status.version}</div> : null}
                  {server.status?.error_message ? (
                    <div className="text-destructive">Error: {server.status.error_message}</div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ResponsiveDialog>
  );
};

export default ServersModal;
