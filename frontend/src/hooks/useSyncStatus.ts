import { getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeToChannel } from '../lib/realtimeSocket';
import type { UnifiedEvent } from '../types/realtime';
import { requestJson } from '../util/apiClient';

interface SyncProgress {
  current_server: number;
  total_servers: number;
  current_server_name: string | null;
}

export interface SyncStatus {
  is_syncing: boolean;
  started_at: string | null;
  started_by: number | null;
  started_by_username: string | null;
  progress: SyncProgress;
}

const defaultStatus: SyncStatus = {
  is_syncing: false,
  started_at: null,
  started_by: null,
  started_by_username: null,
  progress: {
    current_server: 0,
    total_servers: 0,
    current_server_name: null,
  },
};

export const useSyncStatus = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const [observation, setObservation] = useState({ auth, status: defaultStatus });
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    const setSyncStatus = (status: SyncStatus) => setObservation({ auth, status });
    setSyncStatus(defaultStatus);
    setLoading(enabled);
    if (!enabled) return;
    const controller = new AbortController();
    let stopped = false;
    let live = false;
    const current = () => !stopped && getAuthSnapshot() === auth;
    void requestJson<{ data: SyncStatus }>('/api/sync/status', { signal: controller.signal }).then(response => {
      if (current() && !live) { setSyncStatus(response.data); setLoading(false); }
    }).catch(() => { if (current()) setLoading(false); });
    const unsubscribe = subscribeToChannel('system.sync_status', (envelope: UnifiedEvent) => {
      if (current() && envelope.type === 'TaskProgress') {
        live = true;
        setSyncStatus((envelope.payload as SyncStatus) ?? defaultStatus);
        setLoading(false);
      }
    });

    return () => {
      stopped = true;
      controller.abort();
      unsubscribe();
    };
  }, [enabled, auth]);

  return { syncStatus: enabled && observation.auth === auth ? observation.status : defaultStatus, loading: enabled && loading };
};
