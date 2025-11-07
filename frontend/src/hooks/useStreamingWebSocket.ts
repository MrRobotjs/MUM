import { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccessToken } from '../util/tokenStore';

interface StreamingUpdate {
  active_count: number;
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
}

// Singleton socket instance shared across all components
let globalSocket: Socket | null = null;
let globalSocketListeners: Set<(data: StreamingUpdate) => void> = new Set();
let globalState = {
  isConnected: false,
  activeCount: 0,
  lastUpdate: null as Date | null,
  liveServices: [] as string[],
  lastSessionData: null as StreamingUpdate | null,  // Store last received session data
};

// Initialize singleton socket
function getOrCreateSocket(): Socket {
  if (globalSocket?.connected) {
    return globalSocket;
  }

  if (globalSocket) {
    // Socket exists but not connected, clean it up
    try {
      globalSocket.removeAllListeners();
      globalSocket.disconnect();
    } catch {}
  }

  const socket = io({
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
    auth: { access_token: getAccessToken() || undefined },
  });

  socket.on('connect', () => {
    globalState.isConnected = true;
    socket.emit('subscribe_streaming');
  });

  socket.io.on('reconnect_attempt', () => {
    socket.auth = { access_token: getAccessToken() || undefined };
  });

  socket.on('disconnect', () => {
    globalState.isConnected = false;
    globalState.liveServices = [];
  });

  socket.on('subscribed', (_data: { channel: string }) => {
    console.log('[WebSocket] Successfully subscribed to streaming updates channel')
  });

  socket.on('error', (data: any) => {
    console.error('[WebSocket] Error:', data)
  });

  socket.on('subscription_error', (data: any) => {
    console.error('[WebSocket] Subscription error:', data)
  });

  socket.on('streaming_update', (data: StreamingUpdate) => {
    // Use sessions.length as source of truth when sessions array is provided (matches actual current state)
    // This ensures the count updates correctly when streams stop (empty array = 0)
    if (Array.isArray(data.sessions)) {
      globalState.activeCount = data.sessions.length;
    } else {
      globalState.activeCount = data.active_count;
    }
    globalState.lastUpdate = new Date();
    globalState.liveServices = (data.live_services ?? []).map((service) => service.toLowerCase());
    globalState.lastSessionData = data;  // Store last received data
    
    // Notify all registered listeners
    globalSocketListeners.forEach((listener) => {
      try {
        listener(data);
      } catch (error) {
        console.error('[WebSocket] Error in update listener:', error);
      }
    });
  });

  socket.on('connect_error', (_error) => {
    // no-op
  });

  // Log any socket.io event to help diagnose missing payloads
  socket.onAny((event, ...args) => {
    try {
      const payload = args && args.length ? args[0] : undefined
      console.log('[WebSocket] Event:', event, payload)
    } catch {
      console.log('[WebSocket] Event:', event)
    }
  });

  globalSocket = socket;
  return socket;
}

export const useStreamingWebSocket = (options: UseStreamingWebSocketOptions = {}) => {
  const { autoConnect = true, onUpdate } = options;

  const [isConnected, setIsConnected] = useState(globalState.isConnected);
  const [activeCount, setActiveCount] = useState<number>(globalState.activeCount);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(globalState.lastUpdate);
  const [liveServices, setLiveServices] = useState<string[]>(globalState.liveServices);
  const onUpdateRef = useRef(onUpdate);

  // Update ref when callback changes
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  // Register/unregister update listener
  useEffect(() => {
    if (!onUpdate) return;

    const listener = (data: StreamingUpdate) => {
      if (onUpdateRef.current) {
        onUpdateRef.current(data);
      }
    };

    globalSocketListeners.add(listener);

    return () => {
      globalSocketListeners.delete(listener);
    };
  }, [onUpdate]);

  // Sync state from global state
  useEffect(() => {
    const syncState = () => {
      setIsConnected(globalState.isConnected);
      setActiveCount(globalState.activeCount);
      setLastUpdate(globalState.lastUpdate);
      setLiveServices([...globalState.liveServices]);
    };

    // Sync immediately
    syncState();

    // Set up interval to sync state changes
    const interval = setInterval(syncState, 100);

    return () => clearInterval(interval);
  }, []);

  // Listen for auth token updates
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent;
      const token = (ce.detail && (ce.detail as any).accessToken) as string | undefined;
      if (globalSocket && globalSocket.connected && token) {
        globalSocket.emit('auth_update', { access_token: token });
      }
    };
    window.addEventListener('auth_token_updated', handler as EventListener);
    return () => window.removeEventListener('auth_token_updated', handler as EventListener);
  }, []);

  // Cleanly disconnect on logout
  useEffect(() => {
    const onLogout = () => {
      if (globalSocket) {
        try { globalSocket.emit('unsubscribe_streaming'); } catch {}
        try { globalSocket.disconnect(); } catch {}
        globalSocket = null;
        globalState.isConnected = false;
        globalState.liveServices = [];
        setIsConnected(false);
        setLiveServices([]);
      }
    };
    window.addEventListener('auth_logged_out', onLogout as EventListener);
    return () => window.removeEventListener('auth_logged_out', onLogout as EventListener);
  }, []);

  // Initialize socket if autoConnect is true
  useEffect(() => {
    if (!autoConnect) {
      return;
    }

    getOrCreateSocket();

    // No cleanup - socket is singleton and shared
    return () => {
      // Don't disconnect on unmount - let other components continue using it
    };
  }, [autoConnect]);

  const connect = useCallback(() => {
    getOrCreateSocket();
  }, []);

  const disconnect = useCallback(() => {
    if (globalSocket) {
      globalSocket.emit('unsubscribe_streaming');
      globalSocket.disconnect();
      globalSocket = null;
      globalState.isConnected = false;
      globalState.liveServices = [];
      setIsConnected(false);
      setLiveServices([]);
    }
  }, []);

  return {
    isConnected,
    activeCount,
    lastUpdate,
    liveServices,
    lastSessionData: globalState.lastSessionData,  // Expose last session data
    connect,
    disconnect,
  };
};
