import useSWR from 'swr';
import { useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getAccessToken, getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import { requestJson, ApiError, type ApiRequestInit } from '../util/apiClient';
import { fetchActivityCurrent } from './activityHistory';

// Dashboard cards keep their existing view models; these adapters build them
// from current Go endpoints. Each hook mirrors useAdminApi's return shape.
export function useDashboardData<T>(key: string | null, fetcher: () => Promise<T>) {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot);
  const token = session.accessToken;
  const enabled = Boolean(key && user?.uuid && isAdministrator && token);
  const { data, error, isLoading, mutate } = useSWR(enabled ? [key, user!.uuid, token] : null, async () => {
    if (!token || token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
    const value = await fetcher();
    if (token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
    return value;
  }, { revalidateOnFocus: false, keepPreviousData: false, shouldRetryOnError: false });
  return { data: enabled && !error ? data ?? null : null, error: error ? (error as ApiError).message || 'Request failed' : null, loading: enabled && isLoading, mutate };
}

// Every request belongs to the session that started it. In particular a probe
// must never refresh authentication and replay a POST under another session.
async function dashboardRequest<T>(path: string, init: ApiRequestInit = {}, token = getAccessToken()): Promise<T> {
  if (!token) throw Error('Sign in to read the dashboard.');
  if (token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const value = await requestJson<T>(path, { ...init, signal: controller.signal, retryAuthentication: false });
    if (token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
    return value;
  } finally { clearTimeout(timer); }
}

type ServerDTO = { id: number; server_nickname: string; service_type: string; effective_active: boolean; last_status: boolean | null; last_version: string; last_status_check: string };
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const text = (v: unknown, max = 255): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

async function readServers(token = getAccessToken()): Promise<ServerDTO[]> {
  const { data } = await dashboardRequest<{ data: ServerDTO[] }>('/api/servers', {}, token);
  if (!Array.isArray(data) || data.length > 1000) throw new Error('Invalid server list');
  const seen = new Set<number>();
  return data.map(s => {
    if (!s || !integer(s.id) || seen.has(s.id) || !text(s.server_nickname) || !text(s.service_type, 32) || typeof s.effective_active !== 'boolean' || s.last_status !== null && typeof s.last_status !== 'boolean' || !text(s.last_version, 64)) throw new Error('Invalid server list');
    seen.add(s.id);
    return { id: s.id, server_nickname: s.server_nickname, service_type: s.service_type, effective_active: s.effective_active, last_status: s.last_status, last_version: s.last_version, last_status_check: typeof s.last_status_check === 'string' ? s.last_status_check : '' };
  });
}

// Reads stored health. A refresh first probes active servers (four at a time);
// each probe records its own outcome, so a failed probe still shows as offline.
export async function fetchServerHealth(probe = false) {
  const token = getAccessToken();
  let servers = await readServers(token);
  if (probe) {
    const active = servers.filter(s => s.effective_active);
    for (let i = 0; i < active.length; i += 4) {
      if (token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
      await Promise.allSettled(active.slice(i, i + 4).map(s => dashboardRequest(`/api/servers/${s.id}/test-connection`, { method: 'POST' }, token)));
    }
    if (token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
    servers = await readServers(token);
  }
  const rows = servers.map(s => ({
    id: s.id, name: s.server_nickname, online: s.effective_active && s.last_status === true, service_type: s.service_type,
    ...(s.last_version ? { version: s.last_version } : {}),
    ...(!s.effective_active ? { error_message: 'Disabled' } : s.last_status === false ? { error_message: 'Last connection check failed' } : s.last_status === null ? { error_message: 'Not checked yet' } : {}),
  }));
  const online = rows.filter(r => r.online).length;
  return { data: { summary: { total_servers: rows.length, online, offline: rows.length - online }, servers: rows }, meta: { generated_at: new Date().toISOString() } };
}

// Current activity across all servers (administrators), shaped for the card.
export async function fetchActiveStreams(actor: string) {
  const [page, servers] = await Promise.all([fetchActivityCurrent(actor, 'all'), readServers()]);
  const byID = new Map(servers.map(s => [String(s.id), s]));
  const sessions = page.items.map(item => {
    const server = byID.get(item.server_id);
    const position = item.position_ticks === null ? null : Number(BigInt(item.position_ticks));
    const duration = item.duration_ticks === null ? null : Number(BigInt(item.duration_ticks));
    return {
      id: item.id, title: item.title, state: item.paused ? 'paused' : 'playing',
      user: { name: item.owner_name ?? item.service_username ?? 'Unlinked account' },
      server: { name: server?.server_nickname ?? `Server #${item.server_id}`, service_type: server?.service_type ?? '' },
      ...(position !== null && duration ? { progress_percent: Math.min(100, (position / duration) * 100) } : {}),
    };
  });
  return { data: { count: sessions.length, sessions } };
}

type AuditEvent = { id: number; timestamp: string | null; event_type: string | null; message: string };
export async function fetchRecentEvents(limit = 5) {
  const { data } = await dashboardRequest<{ data: AuditEvent[] }>(`/api/audit-events?limit=${limit}`);
  if (!Array.isArray(data) || data.length > limit) throw new Error('Invalid recent activity');
  return { data: data.map(e => {
    if (!e || !integer(e.id) || typeof e.timestamp !== 'string' || !Number.isFinite(Date.parse(e.timestamp)) || !text(e.event_type, 128) || !text(e.message)) throw new Error('Invalid recent activity');
    return { id: e.id, timestamp: e.timestamp, event_type: e.event_type, message: e.message };
  }) };
}

type WatchTitle = { title: string; plays: number; duration: string };
type WatchStats = { top_movies: WatchTitle[]; top_shows: WatchTitle[]; top_platforms: { name: string; plays: number; duration: string }[];
  totals: { total_plays: number; total_duration: string; unique_titles: number; unique_users: number; avg_session_length: string; peak_day_streams: number } };
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const titles = (v: unknown): WatchTitle[] => {
  if (!Array.isArray(v) || v.length > 10) throw new Error('Invalid watch statistics');
  return v.map(t => { if (!t || !text(t.title) || !t.title || !count(t.plays) || !text(t.duration, 16)) throw new Error('Invalid watch statistics'); return { title: t.title, plays: t.plays, duration: t.duration }; });
};
const platforms = (v: unknown) => {
  if (!Array.isArray(v) || v.length > 10) throw new Error('Invalid watch statistics');
  return v.map(p => { if (!p || !text(p.name) || !p.name || !count(p.plays) || !text(p.duration, 16)) throw new Error('Invalid watch statistics'); return { name: p.name as string, plays: p.plays as number, duration: p.duration as string }; });
};
export async function fetchWatchStats(days = 7) {
  const { data } = await dashboardRequest<{ data: WatchStats & { days: number } }>(`/api/activity/statistics?days=${days}`);
  const t = data?.totals;
  if (!data || data.days !== days || !t || !count(t.total_plays) || !count(t.unique_titles) || !count(t.unique_users) || !count(t.peak_day_streams) || !text(t.total_duration, 16) || !text(t.avg_session_length, 16)) throw new Error('Invalid watch statistics');
  return { data: { top_movies: titles(data.top_movies), top_shows: titles(data.top_shows), top_platforms: platforms(data.top_platforms),
    totals: { total_plays: t.total_plays, total_duration: t.total_duration, unique_titles: t.unique_titles, unique_users: t.unique_users, avg_session_length: t.avg_session_length, peak_day_streams: t.peak_day_streams } } };
}
