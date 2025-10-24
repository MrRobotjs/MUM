import { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface StreamingUpdate {
  active_count: number;
  timestamp?: string;
  live_services?: string[];
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
    });

    socket.on('connect', () => {
      console.log('[WebSocket] Connected to streaming updates');
      setIsConnected(true);
      socket.emit('subscribe_streaming');
    });

    socket.on('disconnect', () => {
      console.log('[WebSocket] Disconnected from streaming updates');
      setIsConnected(false);
      setLiveServices([]);
    });

    socket.on('subscribed', (data: { channel: string }) => {
      console.log('[WebSocket] Subscribed to', data.channel);
    });

    socket.on('streaming_update', (data: StreamingUpdate) => {
      console.log('[WebSocket] Received streaming update:', data);
      setActiveCount(data.active_count);
      setLastUpdate(new Date());
      setLiveServices((data.live_services ?? []).map((service) => service.toLowerCase()));

      if (onUpdateRef.current) {
        onUpdateRef.current(data);
      }
    });

    socket.on('connect_error', (error) => {
      console.error('[WebSocket] Connection error:', error);
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
