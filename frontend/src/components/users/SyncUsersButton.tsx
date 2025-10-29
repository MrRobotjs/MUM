import { useState } from 'react';
import { requestJson } from '../../util/apiClient';
import { useAlerts } from '../../contexts/AlertContext';
import { Button } from '../ui/button';

interface SyncResult {
  server_id: number;
  server_name: string;
  service_type: string;
  success: boolean;
  added: number;
  updated: number;
  removed: number;
  message: string;
}

interface SyncAllResponse {
  data: {
    results: SyncResult[];
    summary: {
      total_servers: number;
      successful: number;
      failed: number;
      total_added: number;
      total_updated: number;
      total_removed: number;
    };
  };
}

export const SyncUsersButton = () => {
  const [syncing, setSyncing] = useState(false);
  const { success, error } = useAlerts();

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await requestJson<SyncAllResponse>('/admin/api/v2/users/sync-all', {
        method: 'POST'
      });

      const { summary, results } = result.data;

      // Show summary toast
      if (summary.failed === 0) {
        success(
          `Synced ${summary.total_servers} server${summary.total_servers !== 1 ? 's' : ''}: ` +
          `${summary.total_added} added, ${summary.total_updated} updated, ${summary.total_removed} removed`
        );
      } else {
        error(
          `Sync completed with errors: ${summary.successful}/${summary.total_servers} servers successful. ` +
          `${summary.total_added} added, ${summary.total_updated} updated, ${summary.total_removed} removed`
        );
      }

      // Log detailed results
      results.forEach((result) => {
        if (!result.success) {
          console.error(`Sync failed for ${result.server_name}: ${result.message}`);
        }
      });
    } catch (err) {
      error(`Failed to sync users: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Button
      onClick={handleSync}
      disabled={syncing}
      size="sm"
      type="button"
    >
      {syncing ? (
        <>
          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current mr-2" />
          Syncing...
        </>
      ) : (
        <>
          <i className="fa-solid fa-sync mr-2" />
          Sync All Users
        </>
      )}
    </Button>
  );
};
