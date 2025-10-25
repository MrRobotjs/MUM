import { useEffect, useState } from 'react';
import { requestJson } from '../util/apiClient';

interface SyncProgress {
  current_server: number;
  total_servers: number;
  current_server_name: string | null;
}

interface SyncStatus {
  is_syncing: boolean;
  started_at: string | null;
  started_by: number | null;
  started_by_username: string | null;
  progress: SyncProgress;
}

interface SyncStatusResponse {
  data: SyncStatus;
  meta: {
    request_id: string;
  };
}

export const useSyncStatus = (pollInterval = 2000) => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    is_syncing: false,
    started_at: null,
    started_by: null,
    started_by_username: null,
    progress: {
      current_server: 0,
      total_servers: 0,
      current_server_name: null
    }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    const fetchStatus = async () => {
      try {
        const response = await requestJson<SyncStatusResponse>('/admin/api/v1/sync-status');
        setSyncStatus(response.data);
        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch sync status:', err);
        setLoading(false);
      }
    };

    // Initial fetch
    fetchStatus();

    // Poll for updates
    intervalId = setInterval(fetchStatus, pollInterval);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [pollInterval]);

  return { syncStatus, loading };
};
