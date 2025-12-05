import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import type { Server } from './useServers';
import {
  connectRealtimeSocket,
  disconnectRealtimeSocket,
  getRealtimeState,
  onConnectionChange,
  subscribeToChannel,
  type ChannelEnvelope,
} from '../lib/realtimeSocket';

interface StreamingUpdate {
  active_count?: number;
  timestamp?: string;
  live_services?: string[];
  // Optional per-session snapshots for real-time corrections (e.g., Plex backend)
  sessions?: Array<{
    session_key: string;
    current_time?: string;
    state?: string;
    service_type?: string;
    duration?: string;
  }>;
  summary?: {
    counts?: {
      total: number;
      active: number;
      completed: number;
    };
    duration?: {
      total_seconds: number;
      average_seconds: number;
    };
  };
}

interface UseStreamingWebSocketOptions {
  autoConnect?: boolean;
  onUpdate?: (data: StreamingUpdate) => void;
  servers?: Server[];
}

type StreamingListener = (data: StreamingUpdate) => void;

const channelSnapshots = new Map<string, StreamingUpdate>();
const streamingListeners = new Set<StreamingListener>();
const streamingState = {
  activeCount: 0,
  liveServices: [] as string[],
  lastSessionData: null as StreamingUpdate | null,
};

const recomputeAggregate = () => {
  const liveServices = new Set<string>();
  let activeCount = 0;
  const sessions: StreamingUpdate['sessions'] = [];
  let timestamp: string | undefined;

  channelSnapshots.forEach((payload) => {
    const count = Array.isArray(payload.sessions)
      ? payload.sessions.length
      : payload.active_count ?? 0;
    activeCount += count;

    if (Array.isArray(payload.sessions)) {
      sessions.push(...payload.sessions);
      payload.sessions.forEach((session) => {
        if (session.service_type) {
          liveServices.add(String(session.service_type).toLowerCase());
        }
      });
    }

    if (Array.isArray(payload.live_services)) {
      payload.live_services.forEach((svc) => liveServices.add(String(svc).toLowerCase()));
    }

    if (payload.timestamp) {
      timestamp = payload.timestamp;
    }
  });

  const aggregate: StreamingUpdate = {
    active_count: activeCount,
    sessions,
    live_services: Array.from(liveServices),
    timestamp,
  };

  streamingState.activeCount = activeCount;
  streamingState.liveServices = aggregate.live_services ?? [];
  streamingState.lastSessionData = aggregate;

  streamingListeners.forEach((listener) => {
    try {
      listener(aggregate);
    } catch (error) {
      console.error('[StreamingWebSocket] listener error', error);
    }
  });
};

// Module-level handler that ALL instances share
// This ensures channel snapshots are updated globally
const handleEnvelopeGlobal = (envelope: ChannelEnvelope) => {
  if (envelope.event !== 'session_update') return;
  channelSnapshots.set(envelope.channel, envelope.data as StreamingUpdate);
  recomputeAggregate();
};

const clearChannelSnapshots = () => {
  channelSnapshots.clear();
  recomputeAggregate();
};

export const useStreamingWebSocket = (options: UseStreamingWebSocketOptions = {}) => {
  const { autoConnect = true, onUpdate, servers = [] } = options;

  const [isConnected, setIsConnected] = useState<boolean>(getRealtimeState().connected);
  const [activeCount, setActiveCount] = useState<number>(streamingState.activeCount);
  const [liveServices, setLiveServices] = useState<string[]>(streamingState.liveServices);
  const [lastSessionData, setLastSessionData] = useState<StreamingUpdate | null>(
    streamingState.lastSessionData
  );
  const onUpdateRef = useRef(onUpdate);
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());

  // Create a unique handler for this instance that wraps the global handler
  // This ensures each instance has its own listener reference for subscription tracking
  const handleEnvelope = useRef<ChannelListener>((envelope) => {
    handleEnvelopeGlobal(envelope);
  }).current;

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  // Maintain connection state
  useEffect(() => {
    console.debug('[StreamingWebSocket] Connection effect - autoConnect:', autoConnect);
    if (!autoConnect) return;
    console.debug('[StreamingWebSocket] Connecting realtime socket');
    connectRealtimeSocket();
    const unsubscribe = onConnectionChange((connected) => {
      console.debug('[StreamingWebSocket] Connection state changed:', connected);
      setIsConnected(connected);
      if (!connected) {
        channelSnapshots.clear();
        recomputeAggregate();
      }
    });
    return () => unsubscribe();
  }, [autoConnect]);

  // Register aggregate listener for state updates and consumer callback
  useEffect(() => {
    const listener: StreamingListener = (data) => {
      setActiveCount(data.active_count ?? 0);
      setLiveServices(data.live_services ?? []);
      setLastSessionData(data);
      if (onUpdateRef.current) {
        onUpdateRef.current(data);
      }
    };

    streamingListeners.add(listener);
    const current = streamingState.lastSessionData;
    if (current) {
      listener({
        ...current,
        active_count: streamingState.activeCount,
        live_services: streamingState.liveServices,
      });
    }

    return () => {
      streamingListeners.delete(listener);
    };
  }, []);

  // Subscribe to channels for the provided servers
  const channelKey = useMemo(() => {
    // Only generate channel keys if autoConnect is true
    if (!autoConnect) return '';
    return (servers ?? [])
      .filter((srv) => srv && srv.id !== undefined && srv.is_active !== false)
      .map((srv) => `${srv.service_type}.${srv.id}.sessions`)
      .sort()
      .join('|');
  }, [servers, autoConnect]);

  useEffect(() => {
    console.debug('[StreamingWebSocket] Subscription effect - autoConnect:', autoConnect, 'channelKey:', channelKey);
    // Don't subscribe to channels if autoConnect is false
    if (!autoConnect) {
      // Clean up any existing subscriptions
      subscriptionsRef.current.forEach((cleanup) => cleanup());
      subscriptionsRef.current.clear();
      console.debug('[StreamingWebSocket] Cleaned up subscriptions (autoConnect=false)');
      return;
    }

    const desired = new Set(
      (servers ?? [])
        .filter((srv) => srv && srv.id !== undefined && srv.is_active !== false)
        .map((srv) => `${srv.service_type}.${srv.id}.sessions`)
    );

    console.debug('[StreamingWebSocket] Desired channels:', Array.from(desired));

    const activeSubs = subscriptionsRef.current;

    // Unsubscribe removed channels
    for (const [channel, cleanup] of Array.from(activeSubs.entries())) {
      if (!desired.has(channel)) {
        console.debug('[StreamingWebSocket] Unsubscribing from removed channel:', channel);
        cleanup();
        activeSubs.delete(channel);
        // Don't delete channelSnapshots here - the realtimeSocket will handle it
        // when the last listener unsubscribes. This allows multiple components
        // to share the same channel subscriptions.
      }
    }

    // Subscribe to new channels
    desired.forEach((channel) => {
      if (!activeSubs.has(channel)) {
        console.debug('[StreamingWebSocket] Subscribing to new channel:', channel);
        const cleanup = subscribeToChannel(channel, handleEnvelope);
        activeSubs.set(channel, cleanup);
      }
    });

    console.debug('[StreamingWebSocket] Active subscriptions:', Array.from(activeSubs.keys()));
    recomputeAggregate();
  }, [channelKey, autoConnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      subscriptionsRef.current.forEach((cleanup) => cleanup());
      subscriptionsRef.current.clear();
    };
  }, []);

  const connect = useCallback(() => connectRealtimeSocket(), []);
  const disconnect = useCallback(() => {
    subscriptionsRef.current.forEach((cleanup) => cleanup());
    subscriptionsRef.current.clear();
    clearChannelSnapshots();
    disconnectRealtimeSocket();
  }, []);

  return {
    isConnected,
    activeCount,
    lastUpdate: lastSessionData?.timestamp ? new Date(lastSessionData.timestamp) : null,
    liveServices,
    lastSessionData,
    connect,
    disconnect,
  };
};
