import { useEffect, useState } from 'react';
import { connectRealtimeSocket, subscribeToChannel } from '../lib/realtimeSocket';
import type { UnifiedEvent } from '../types/realtime';

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

export const useSyncStatus = () => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(defaultStatus);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    connectRealtimeSocket();
    const unsubscribe = subscribeToChannel('system.sync_status', (envelope: UnifiedEvent) => {
      if (envelope.type === 'TaskProgress') {
        setSyncStatus((envelope.payload as SyncStatus) ?? defaultStatus);
        setLoading(false);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return { syncStatus, loading };
};
