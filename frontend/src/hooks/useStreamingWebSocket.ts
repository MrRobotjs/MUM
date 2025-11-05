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

export const useStreamingWebSocket = (options: UseStreamingWebSocketOptions = {}) => {
  const { autoConnect = true, onUpdate } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [activeCount, setActiveCount] = useState<number>(0);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [liveServices, setLiveServices] = useState<string[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const onUpdateRef = useRef(onUpdate);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  // Listen for auth token updates to refresh socket auth without reconnect
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent;
      const token = (ce.detail && (ce.detail as any).accessToken) as string | undefined;
      const sock = socketRef.current;
      if (sock && sock.connected && token) {
        sock.emit('auth_update', { access_token: token });
      }
    };
    window.addEventListener('auth_token_updated', handler as EventListener);
    return () => window.removeEventListener('auth_token_updated', handler as EventListener);
  }, []);

  // Cleanly disconnect on logout to avoid noisy errors
  useEffect(() => {
    const onLogout = () => {
      const sock = socketRef.current;
      if (sock) {
        try { sock.emit('unsubscribe_streaming'); } catch {}
        try { sock.disconnect(); } catch {}
        socketRef.current = null;
        setIsConnected(false);
        setLiveServices([]);
      }
    };
    window.addEventListener('auth_logged_out', onLogout as EventListener);
    return () => window.removeEventListener('auth_logged_out', onLogout as EventListener);
  }, []);

  const initializeSocket = useCallback(() => {
    if (socketRef.current?.connected) {
      return socketRef.current;
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
      setIsConnected(true);
      // Request streaming updates channel
      socket.emit('subscribe_streaming');
    });

    socket.io.on('reconnect_attempt', () => {
      // Update auth with latest token before reconnection
      socket.auth = { access_token: getAccessToken() || undefined };
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      setLiveServices([]);
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

    // Log any socket.io event to help diagnose missing payloads
    socket.onAny((event, ...args) => {
      try {
        const payload = args && args.length ? args[0] : undefined
        console.log('[WebSocket] Event:', event, payload)
      } catch {
        console.log('[WebSocket] Event:', event)
      }
    });

    socket.on('streaming_update', (data: StreamingUpdate) => {
      setActiveCount(data.active_count);
      setLastUpdate(new Date());
      setLiveServices((data.live_services ?? []).map((service) => service.toLowerCase()));

      if (onUpdateRef.current) {
        onUpdateRef.current(data);
      }
    });

    socket.on('connect_error', (_error) => {
      // no-op
    });

    socketRef.current = socket;
    return socket;
  }, []);

  useEffect(() => {
    if (!autoConnect) {
      return;
    }

    const socket = initializeSocket();

    return () => {
      if (socketRef.current) {
        socketRef.current.emit('unsubscribe_streaming');
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        setLiveServices([]);
      }
    };
  }, [autoConnect, initializeSocket]);

  const connect = useCallback(() => {
    initializeSocket();
  }, [initializeSocket]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('unsubscribe_streaming');
      socketRef.current.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      setLiveServices([]);
    }
  }, []);

  return {
    isConnected,
    activeCount,
    lastUpdate,
    liveServices,
    connect,
    disconnect,
  };
};
