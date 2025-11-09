import { useEffect, useState } from 'react';
import { requestJson, ApiError } from '../util/apiClient';

interface LibrarySyncProgress {
  current_page: number;
  total_pages: number;
  total_items?: number;
  total_fetched?: number;
  message?: string | null;
  phase?: 'shows' | 'episodes' | null;
  shows_current?: number;
  shows_total?: number;
  episodes_current?: number;
  episodes_total?: number;
}

interface LibrarySyncStatus {
  is_syncing: boolean;
  library_id: number;
  started_at: string | null;
  started_by: number | null;
  started_by_username: string | null;
  progress: LibrarySyncProgress;
}

interface LibrarySyncStatusResponse {
  data: LibrarySyncStatus;
  meta: {
    request_id: string;
  };
}

export const useLibrarySyncStatus = (libraryId: string | number, pollInterval = 1500) => {
  const [status, setStatus] = useState<LibrarySyncStatus>({
    is_syncing: false,
    library_id: Number(libraryId),
    started_at: null,
    started_by: null,
    started_by_username: null,
    progress: {
      current_page: 0,
      total_pages: 0,
      total_items: 0,
      total_fetched: 0,
      message: null,
    },
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let stopped = false;

    const fetchStatus = async () => {
      try {
        const resp = await requestJson<LibrarySyncStatusResponse>(`/admin/api/v2/libraries/${libraryId}/sync-status`);
        setStatus(resp.data);
        setLoading(false);
      } catch (err) {
        const e = err as ApiError;
        if (e && typeof e.status === 'number' && e.status === 401) {
          if (intervalId) clearInterval(intervalId);
          intervalId = null;
          stopped = true;
          setLoading(false);
          return;
        }
        if (!stopped) {
          // Avoid noisy logs; keep UI going
          setLoading(false);
        }
      }
    };

    fetchStatus();
    intervalId = setInterval(fetchStatus, pollInterval);

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [libraryId, pollInterval]);

  // Expose a manual refetch to allow immediate updates when starting sync
  const refetch = async () => {
    try {
      const resp = await requestJson<LibrarySyncStatusResponse>(`/admin/api/v2/libraries/${libraryId}/sync-status`);
      setStatus(resp.data);
      setLoading(false);
    } catch {
      // ignore
    }
  };

  return { status, loading, refetch };
};
