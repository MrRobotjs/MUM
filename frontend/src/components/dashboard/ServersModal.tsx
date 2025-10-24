import { useAdminApi } from '../../hooks/useAdminApi';

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
  const { data, loading, error } = useAdminApi<ServersResponse>('/servers?include_status=true');

  if (!open) return null;

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-3xl">
        <h3 className="font-bold text-lg">All Servers Status</h3>
        <div className="py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="loading loading-spinner loading-sm" /> Checking server status…
            </div>
          ) : error ? (
            <div className="text-sm text-error">Failed to load server status: {(error as Error).message}</div>
          ) : (
            <ul className="space-y-2">
              {data?.data.map((server) => (
                <li
                  key={server.id}
                  className={`rounded border px-3 py-2 text-sm ${server.status?.online ? 'border-success/40 bg-success/10' : 'border-error/40 bg-error/10'}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{server.server_nickname}</div>
                      <div className="text-xs text-base-content/60">{server.service_type}</div>
                    </div>
                    <span className={`badge badge-${server.status?.online ? 'success' : 'error'} badge-sm`}>
                      {server.status?.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-base-content/60">
                    {server.status?.version ? `Version: ${server.status.version}` : null}
                    {server.status?.error_message ? (
                      <div className="text-error">Error: {server.status.error_message}</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-action">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ServersModal;
