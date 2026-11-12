import { getAccessToken } from '../util/tokenStore';
import { getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import type { UnifiedEvent } from '../types/realtime';
type ChannelListener = (event: UnifiedEvent) => void;
let socket: WebSocket | null = null;
let connected = false;
let wanted = false;
let retry: ReturnType<typeof setTimeout> | null = null;
const channels = new Map<string, Set<ChannelListener>>();
const connectionListeners = new Set<(connected: boolean) => void>();
const notify = (value: boolean) => { connected = value; connectionListeners.forEach(listener => listener(value)); };
const send = (message: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const connect = () => {
  if (!wanted || !getAccessToken() || socket) return;
  const url = new URL('/ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(url);
  socket = current;
  current.onopen = () => { if (socket === current) send({ type: 'authenticate', access_token: getAccessToken() }); };
  current.onmessage = message => {
    if (socket !== current) return;
    let parsed: any;
    try { parsed = JSON.parse(message.data); } catch { return; }
    if (parsed.type === 'authenticated') {
      notify(true);
      if (channels.size) send({ type: 'subscribe', channels: Array.from(channels.keys()) });
    } else if (parsed.type === 'event' && parsed.event) {
      channels.get(parsed.event.channel)?.forEach(listener => {
        try { listener(parsed.event); } catch (error) { console.error('[Realtime] listener failed', error); }
      });
    }
  };
  current.onclose = () => {
    if (socket !== current) return;
    socket = null;
    notify(false);
    if (wanted && getAccessToken()) retry = setTimeout(() => { retry = null; connect(); }, 1000);
  };
  current.onerror = () => current.close();
};
subscribeToAuthStore(() => {
  const auth = getAuthSnapshot();
  if (auth.status === 'anonymous') { disconnectRealtimeSocket(); return; }
  if (auth.accessToken && socket?.readyState === WebSocket.OPEN) {
    notify(false);
    send({ type: 'authenticate', access_token: auth.accessToken });
  } else if (wanted) connect();
});
export const connectRealtimeSocket = () => { wanted = true; connect(); };
export const disconnectRealtimeSocket = () => {
  wanted = false;
  if (retry) clearTimeout(retry);
  retry = null;
  const previous = socket;
  socket = null;
  previous?.close();
  notify(false);
};
export const subscribeToChannel = (channel: string, listener: ChannelListener) => {
  const current = channels.get(channel) ?? new Set<ChannelListener>();
  const first = current.size === 0;
  current.add(listener);
  channels.set(channel, current);
  connectRealtimeSocket();
  if (connected && first) send({ type: 'subscribe', channels: [channel] });
  return () => {
    current.delete(listener);
    if (!current.size) {
      channels.delete(channel);
      if (connected) send({ type: 'unsubscribe', channels: [channel] });
    }
  };
};
export const onConnectionChange = (listener: (connected: boolean) => void) => {
  connectionListeners.add(listener);
  return () => { connectionListeners.delete(listener); };
};
export const getRealtimeState = () => ({ connected, channels: Array.from(channels.keys()) });
