import useSWR from 'swr';
import { useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getAccessToken, getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import { requestJson, ApiError, type ApiRequestInit } from '../util/apiClient';
import { fetchActivityCurrent } from './activityHistory';

// Dashboard cards keep their existing view models; these adapters build them
// from current Go endpoints. Each hook mirrors useAdminApi's return shape.
// refreshInterval re-reads quietly in the background (milliseconds; off by default).
export function useDashboardData<T>(key: string | null, fetcher: () => Promise<T>, refreshInterval = 0) {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot);
  const token = session.accessToken;
  const enabled = Boolean(key && user?.uuid && isAdministrator && token);
  const { data, error, isLoading, mutate } = useSWR(enabled ? [key, user!.uuid, token] : null, async () => {
    if (!token || token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
    const value = await fetcher();
    if (token !== getAccessToken()) throw Error('Dashboard session changed. Refresh.');
    return value;
  }, { revalidateOnFocus: false, keepPreviousData: false, shouldRetryOnError: false, refreshInterval });
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

export type ServerHealthStatus = 'online' | 'offline' | 'disabled' | 'unchecked';
export type ServerHealth = { id: number; name: string; service_type: string; status: ServerHealthStatus; version?: string; checked_at: string | null };
export type ServerHealthSummary = { total_servers: number; online: number; offline: number; disabled: number; unchecked: number };

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
  // A server turned off in MUM, or not checked yet, is neither online nor offline.
  const rows = servers.map(s => ({
    id: s.id, name: s.server_nickname, service_type: s.service_type,
    status: (!s.effective_active ? 'disabled' : s.last_status === true ? 'online' : s.last_status === false ? 'offline' : 'unchecked') as ServerHealthStatus,
    ...(s.last_version ? { version: s.last_version } : {}),
    checked_at: s.last_status_check || null,
  }));
  const count = (status: ServerHealthStatus) => rows.filter(r => r.status === status).length;
  return { data: { summary: { total_servers: rows.length, online: count('online'), offline: count('offline'), disabled: count('disabled'), unchecked: count('unchecked') }, servers: rows },
    meta: { generated_at: new Date().toISOString() } };
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

// The dashboard's Activity card: what people used across every server type,
// from MUM's recordings (Plex, Jellyfin, Emby) and imported history
// (Audiobookshelf); servers that report nothing are named.
export type ActivityKind = 'movies' | 'popular_movies' | 'shows' | 'popular_shows' | 'music' | 'popular_music' | 'audiobooks' | 'recent' | 'users' | 'libraries';
export type ActivityOrder = 'plays' | 'duration';
export type ActivityTitle = {
  server_id: number; title: string; subtitle: string | null; plays: number; seconds: number; people: number; poster_url: string | null;
  played_at: string | null; user_uuid: string | null; library_id: number | null; library_type: string | null; avatar_url: string | null;
  /** Recently played: who played it. */
  user_name: string | null;
  /** The title's page in the library catalogue, once a sync has catalogued it. */
  link: ActivityLink | null;
  /** Users: the servers they played on, most first. */
  server_ids: number[];
};
export type ActivityLink = { library_id: number; media_id: number; episode_id: number | null };
export type ActivityServer = { server_id: number; name: string; service_type: string; imported_at: string | null };
export type ActivityStats = {
  /** The chosen server, or null for every server; days 0 is all time. */
  days: number; server_id: number | null; order: ActivityOrder; totals: { plays: number; seconds: number; people: number; titles: number };
  sections: { kind: ActivityKind; items: ActivityTitle[] }[]; platforms: { name: string; plays: number; seconds: number; server_ids: number[] }[];
  /** Servers that report activity: the card's server picker. */
  servers: ActivityServer[]; unreported: ActivityServer[]; imported: ActivityServer[];
};
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const activityKinds: ActivityKind[] = ['movies', 'popular_movies', 'shows', 'popular_shows', 'music', 'popular_music', 'audiobooks', 'recent', 'users', 'libraries'];
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const optionalText = (v: unknown) => v === null || text(v);
const activityPosters = ['/api/activity/history-images/', '/api/activity/imported-history-images/'];
const invalidActivity = () => new Error('Invalid activity statistics');
const activityList = <T,>(v: unknown, max: number, read: (item: Record<string, unknown>) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) throw invalidActivity();
  return v.map(item => { if (!item || typeof item !== 'object') throw invalidActivity(); return read(item as Record<string, unknown>); });
};
const activityServerIDs = (v: unknown): number[] => {
  if (!Array.isArray(v) || v.length > 100 || !v.every(integer)) throw invalidActivity();
  return v as number[];
};
const activityLink = (v: unknown): ActivityLink | null => {
  if (v === null || v === undefined) return null;
  const l = v as Record<string, unknown>;
  if (typeof v !== 'object' || !integer(l.library_id) || !integer(l.media_id) || !(l.episode_id === null || l.episode_id === undefined || integer(l.episode_id))) throw invalidActivity();
  return { library_id: l.library_id as number, media_id: l.media_id as number, episode_id: (l.episode_id ?? null) as number | null };
};
const activityServer = (v: Record<string, unknown>): ActivityServer => {
  if (!integer(v.server_id) || !text(v.name) || !text(v.service_type, 64) || !(v.imported_at === null || typeof v.imported_at === 'string')) throw invalidActivity();
  return { server_id: v.server_id as number, name: v.name as string, service_type: v.service_type as string, imported_at: v.imported_at as string | null };
};

export async function fetchActivityStats(days = 7, server: number | null = null, order: ActivityOrder = 'plays'): Promise<ActivityStats> {
  if (server !== null && !integer(server) || !count(days) || days > 90) throw invalidActivity();
  const query = new URLSearchParams({ days: String(days), order, ...(server !== null ? { server: String(server) } : {}) });
  const { data } = await dashboardRequest<{ data: Record<string, unknown> }>(`/api/activity/statistics?${query}`);
  const t = data?.totals as Record<string, unknown> | undefined;
  if (!data || data.days !== days || data.order !== order || (data.server_id ?? null) !== server || !t || !count(t.plays) || !count(t.seconds) || !count(t.people) || !count(t.titles)) throw invalidActivity();
  return {
    days, server_id: server, order, totals: { plays: t.plays as number, seconds: t.seconds as number, people: t.people as number, titles: t.titles as number },
    sections: activityList(data.sections, activityKinds.length, section => {
      if (!activityKinds.includes(section.kind as ActivityKind)) throw invalidActivity();
      return { kind: section.kind as ActivityKind, items: activityList(section.items, 10, item => {
        // A user may play on several servers: their row has no server (0).
        if (!(integer(item.server_id) || section.kind === 'users' && item.server_id === 0) || !text(item.title) || !(item.subtitle === null || text(item.subtitle)) || !count(item.plays) || !count(item.seconds) ||
            !count(item.people) || !optionalText(item.played_at) || !(item.user_uuid === null || uuid(item.user_uuid)) || !(item.library_id === null || integer(item.library_id)) || !optionalText(item.library_type) ||
            !(item.avatar_url === null || item.avatar_url === undefined || typeof item.avatar_url === 'string' && item.avatar_url.startsWith('/api/service-avatars/')) ||
            !(item.user_name === null || item.user_name === undefined || text(item.user_name)) ||
            !(item.poster_url === null || typeof item.poster_url === 'string' && activityPosters.some(p => (item.poster_url as string).startsWith(p)))) throw invalidActivity();
        return { server_id: item.server_id as number, title: item.title as string, subtitle: item.subtitle as string | null, plays: item.plays as number, seconds: item.seconds as number,
          people: item.people as number, poster_url: item.poster_url as string | null, played_at: item.played_at as string | null, user_uuid: item.user_uuid as string | null,
          library_id: item.library_id as number | null, library_type: item.library_type as string | null, avatar_url: (item.avatar_url ?? null) as string | null,
          user_name: (item.user_name ?? null) as string | null, link: activityLink(item.link), server_ids: activityServerIDs(item.server_ids ?? []) };
      }) };
    }),
    platforms: activityList(data.platforms, 10, p => { if (!text(p.name) || !p.name || !count(p.plays) || !count(p.seconds)) throw invalidActivity(); return { name: p.name as string, plays: p.plays as number, seconds: p.seconds as number, server_ids: activityServerIDs(p.server_ids ?? []) }; }),
    servers: activityList(data.servers, 100, activityServer),
    unreported: activityList(data.unreported, 100, activityServer),
    imported: activityList(data.imported, 100, activityServer),
  };
}
