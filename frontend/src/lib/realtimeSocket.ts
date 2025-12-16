import { io, Socket } from 'socket.io-client';
import { getAccessToken } from '../util/tokenStore';
import { getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import type { UnifiedEvent } from '../types/realtime';

type ChannelListener = (envelope: UnifiedEvent) => void;
type ConnectionListener = (connected: boolean) => void;

let socket: Socket | null = null;
let isConnected = false;
let listenersBound = false;
const channelListeners = new Map<string, Set<ChannelListener>>();
const connectionListeners = new Set<ConnectionListener>();
let subscribedChannels = new Set<string>();

const notifyConnection = (connected: boolean) => {
  isConnected = connected;
  connectionListeners.forEach((listener) => {
    try {
      listener(connected);
    } catch (err) {
      console.error('[Realtime] connection listener error', err);
    }
  });
};

const resubscribeAll = () => {
  if (socket && socket.connected && subscribedChannels.size > 0) {
    socket.emit('subscribe', { channels: Array.from(subscribedChannels) });
  }
};

const bindGlobalAuthListeners = () => {
  if (listenersBound) return;
  listenersBound = true;
  let lastToken = getAccessToken();

  subscribeToAuthStore(() => {
    const next = getAuthSnapshot();

    if (next.status === 'anonymous') {
      disconnectRealtimeSocket();
      lastToken = null;
      return;
    }

    if (next.status !== 'authenticated') return;

    if (next.accessToken && next.accessToken !== lastToken && socket?.connected) {
      socket.emit('auth_update', { access_token: next.accessToken });
    }

    lastToken = next.accessToken;
  });
};

function ensureSocket(): Socket {
  if (socket) {
    return socket;
  }

  bindGlobalAuthListeners();

  const created = io({
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    auth: { access_token: getAccessToken() || undefined },
  });

  created.on('connect', () => {
    notifyConnection(true);
    resubscribeAll();
  });

  created.io.on('reconnect_attempt', () => {
    created.auth = { access_token: getAccessToken() || undefined };
  });

  created.on('disconnect', () => {
    notifyConnection(false);
  });

  created.on('ws_event', (envelope: UnifiedEvent) => {
    try {
      const sessLen = Array.isArray((envelope as any)?.payload?.sessions)
        ? (envelope as any).payload.sessions.length
        : null;
      const activeCount = (envelope as any)?.payload?.active_count;
      console.debug('[Realtime] ws_event', envelope.channel, envelope.type, { activeCount, sessLen });
    } catch {
      console.debug('[Realtime] ws_event', envelope.channel, envelope.type);
    }

    const listeners = channelListeners.get(envelope.channel);
    if (!listeners) return;
    listeners.forEach((listener) => {
      try {
        listener(envelope);
      } catch (err) {
        console.error('[Realtime] listener error', err);
      }
    });
  });

  created.on('subscription_error', (payload) => {
    console.warn('[Realtime] subscription error', payload);
  });

  created.on('error', (payload) => {
    console.warn('[Realtime] socket error', payload);
  });

  socket = created;
  return created;
}

export const connectRealtimeSocket = () => {
  ensureSocket();
};

export const disconnectRealtimeSocket = () => {
  try {
    socket?.disconnect();
  } catch (err) {
    console.warn('[Realtime] disconnect error', err);
  }
  socket = null;
  subscribedChannels = new Set();
  channelListeners.clear();
  notifyConnection(false);
};

export const subscribeToChannel = (channel: string, listener: ChannelListener) => {
  const sock = ensureSocket();
  const listeners = channelListeners.get(channel) ?? new Set<ChannelListener>();
  listeners.add(listener);
  channelListeners.set(channel, listeners);

  if (!subscribedChannels.has(channel)) {
    subscribedChannels.add(channel);
    if (sock.connected) {
      sock.emit('subscribe', { channels: [channel] });
    }
  }

  return () => {
    const current = channelListeners.get(channel);
    if (current) {
      current.delete(listener);
      if (current.size === 0) {
        channelListeners.delete(channel);
      }
    }

    if (!channelListeners.has(channel) && subscribedChannels.has(channel)) {
      subscribedChannels.delete(channel);
      if (socket?.connected) {
        socket.emit('unsubscribe', { channels: [channel] });
      }
    }
  };
};

export const onConnectionChange = (listener: ConnectionListener) => {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
};

export const getRealtimeState = () => ({
  connected: isConnected,
  channels: Array.from(subscribedChannels),
});
