import { useEffect, useRef, useState } from 'react';
import { useCatalogueView } from '../lib/catalogueView';
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
  shows_failed?: number;
  episodes_current?: number;
  episodes_total?: number;
}

/** The outcome of the library's last "TV Shows + Episodes" run. */
export interface LibraryEpisodeRun {
  finished_at: string;
  shows_total: number;
  shows_synced: number;
  shows_failed: number;
  shows_skipped: number;
  added: number;
  updated: number;
  removed: number;
  stopped: 'library_changed' | 'forbidden' | 'shutdown' | 'timeout' | null;
}

interface LibrarySyncStatus {
  is_syncing: boolean;
  library_id: number;
  started_at: string | null;
  started_by: number | null;
  started_by_username: string | null;
  progress: LibrarySyncProgress;
  last_episode_run?: LibraryEpisodeRun | null;
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

  const view = useCatalogueView({status: String(libraryId)});
  const inFlight = useRef<Promise<void> | null>(null);
  const denied = useRef(false);
  const refetch = () => {
    if (!view.current() || denied.current) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    const read = view.begin('status');
    inFlight.current = (async () => {
      try {
        const resp = await requestJson<LibrarySyncStatusResponse>(`/api/libraries/${libraryId}/sync-status`, {signal: read.signal, retryAuthentication: false});
        if (read.current() && resp.data?.library_id === Number(libraryId)) setStatus(resp.data);
      } catch (err) {
        if (read.current() && err instanceof ApiError && err.status === 401) denied.current = true;
      } finally {
        read.finish();
        if (read.current()) setLoading(false);
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refetch();
      if (!stopped && !denied.current && view.current()) timer = setTimeout(tick, pollInterval);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [libraryId, pollInterval]);

  return { status, loading, refetch };
};
