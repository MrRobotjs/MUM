import { useEffect, useState } from 'react';
import {
  connectRealtimeSocket,
  subscribeToChannel,
  type ChannelEnvelope,
} from '../lib/realtimeSocket';

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
    const unsubscribe = subscribeToChannel('system.sync_status', (envelope: ChannelEnvelope) => {
      if (envelope.event === 'sync_status_update') {
        setSyncStatus(envelope.data as SyncStatus);
        setLoading(false);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return { syncStatus, loading };
};
