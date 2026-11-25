import { requestJson } from '../util/apiClient';
import { isPlayPoster } from './playPosters';
import { getAccessToken } from '../store/authStore';
import { historyServices, type HistoryService } from './playHistory';

export { historyServiceName, type HistoryService } from './playHistory';

// The user page's History tab shows one server at a time: MUM's recorded
// plays, the plays imported from
// that server's own history, or both, with optional type and stream filters.
// The reply lists every server the person has an account on and the
// categories they have on the one shown. Imported plays have no player or
// quality; only Audiobookshelf reports how far, how long and time listened.
// Posters are signed administrator links; an imported play's comes from its
// own route.

// The Profile tab's Activity picker still chooses a source across servers.
export type TimelineSource = 'all' | 'mum' | HistoryService;
export type TimelineScope = 'own' | 'all';
export type TimelineRecords = 'all' | 'mum' | 'server';
export type TimelineCategory = 'movies' | 'tv' | 'music' | 'videos' | 'books' | 'podcasts';
export type TimelineMethod = 'direct_play' | 'direct_stream' | 'transcode';
export type TimelineFilters = Readonly<{ types: readonly TimelineCategory[]; methods: readonly TimelineMethod[] }>;
export type TimelineRequest = Readonly<{ server?: string; records: TimelineRecords; filters: TimelineFilters; before?: string }>;
export type TimelineServer = Readonly<{ server_id: string; name: string; service_type: string; live: boolean; history: boolean }>;
export type TimelineItem = Readonly<{
  source: 'mum' | HistoryService;
  id: string;
  server_id: string;
  service_uuid: string;
  media_type: string;
  title: string;
  parent_title: string | null;
  library_name: string | null;
  played_at: string;
  client: string | null;
  play_method: TimelineMethod | null;
  position_ticks: string | null;
  duration_ticks: string | null;
  // MUM's plays only (null on imported ones). The
  // player (a device name) and IP address come to administrators only.
  platform: string | null;
  player: string | null;
  ip_address: string | null;
  stopped_at: string | null;
  paused_seconds: string | null;
  watched_seconds: string | null;
  // Audiobookshelf imports only: how long the session was listened to.
  listened_seconds: string | null;
  // A MUM play still being watched; it can't be deleted until it ends.
  in_progress: boolean;
  // Who played it: their MUM account, else the server account, and its name.
  person_uuid: string;
  person_name: string;
  poster_url?: string;
  link?: { library_id: number; media_id: number; episode_id: number | null };
}>;
export type TimelinePage = Readonly<{
  actor_uuid: string; scope: TimelineScope; target_uuid: string; server_id: string | null; records: TimelineRecords;
  servers: readonly TimelineServer[]; categories: readonly TimelineCategory[]; items: TimelineItem[]; next_before: string | null;
}>;

export const timelineCategories: readonly TimelineCategory[] = ['movies', 'tv', 'music', 'videos', 'books', 'podcasts'];
export const timelineMethods: readonly TimelineMethod[] = ['direct_play', 'direct_stream', 'transcode'];
const recordsChoices: readonly string[] = ['all', 'mum', 'server'];

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const cursor = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z_[mp]_[1-9]\d{0,18}$/.test(v);
const serverID = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v);
const text = (v: unknown) => typeof v === 'string';
const optionalText = (v: unknown) => v === null || typeof v === 'string';
// A whole number of ticks or seconds, as a decimal string.
const whole = (v: unknown) => v === null || typeof v === 'string' && /^\d{1,19}$/.test(v);
const time = (v: unknown) => v === null || typeof v === 'string' && Number.isFinite(Date.parse(v));
const imported = (v: unknown): v is HistoryService => historyServices.includes(v as HistoryService);
const methods = [null, ...timelineMethods];

// The values of a filter in their fixed order, refusing unknown or repeated ones.
function ordered<T extends string>(values: readonly T[], allowed: readonly T[]): T[] {
  if (values.some(v => !allowed.includes(v)) || new Set(values).size !== values.length) throw new Error('Invalid history request');
  return allowed.filter(v => values.includes(v));
}

function item(value: unknown, seen: Set<string>): TimelineItem {
  const v = value as Record<string, unknown>;
  const fromServer = imported(v?.source);
  if (!v || (v.source !== 'mum' && !fromServer) || !text(v.id) || !(v.id as string).startsWith(`${v.source}-`) || seen.has(v.id as string) || !text(v.server_id) || !uuid(v.service_uuid) ||
      !text(v.media_type) || !text(v.title) || !optionalText(v.parent_title) || !optionalText(v.library_name) || !text(v.played_at) || !Number.isFinite(Date.parse(v.played_at as string)) ||
      !optionalText(v.client) || !methods.includes(v.play_method as TimelineMethod | null) || !whole(v.position_ticks) || !whole(v.duration_ticks) ||
      v.poster_url !== undefined && !text(v.poster_url) ||
      v.link !== undefined && (!v.link || typeof v.link !== 'object' || !Number.isSafeInteger((v.link as Record<string,unknown>).library_id) || Number((v.link as Record<string,unknown>).library_id) < 1 || !Number.isSafeInteger((v.link as Record<string,unknown>).media_id) || Number((v.link as Record<string,unknown>).media_id) < 1 || ((v.link as Record<string,unknown>).episode_id !== null && (!Number.isSafeInteger((v.link as Record<string,unknown>).episode_id) || Number((v.link as Record<string,unknown>).episode_id) < 1))) ||
      !optionalText(v.platform) || !optionalText(v.player) || !optionalText(v.ip_address) || !time(v.stopped_at) || !whole(v.paused_seconds) || !whole(v.watched_seconds) ||
      !whole(v.listened_seconds) || v.source !== 'audiobookshelf' && v.listened_seconds !== null || typeof v.in_progress !== 'boolean' || fromServer && v.in_progress ||
      !uuid(v.person_uuid) || !text(v.person_name) ||
      // MUM always knows when it last saw its own play and how long it was watched.
      !fromServer && (v.stopped_at === null || v.watched_seconds === null) ||
      // Imported plays record no player or quality; only Audiobookshelf reports progress.
      fromServer && (v.client !== null || v.play_method !== null || v.platform !== null || v.player !== null || v.ip_address !== null || v.stopped_at !== null || v.paused_seconds !== null || v.watched_seconds !== null || v.source !== 'audiobookshelf' && (v.position_ticks !== null || v.duration_ticks !== null) ||
        v.poster_url !== undefined && !isPlayPoster(v.poster_url, 'imported')) ||
      // A MUM play's poster is its catalogue poster or the one MUM stored with it.
      !fromServer && v.poster_url !== undefined && !isPlayPoster(v.poster_url, 'mum')) throw new Error('Invalid history item');
  seen.add(v.id as string);
  return Object.freeze({ ...(v as TimelineItem) });
}

function server(value: unknown): TimelineServer {
  const v = value as Record<string, unknown>;
  if (!v || !serverID(v.server_id) || !text(v.name) || !text(v.service_type) || typeof v.live !== 'boolean' || typeof v.history !== 'boolean') throw new Error('Invalid history page');
  return Object.freeze({ server_id: v.server_id, name: v.name as string, service_type: v.service_type as string, live: v.live, history: v.history });
}

// The source to show for a person on the Activity picker: the chosen one, or
// Combined when they have no account on the chosen service.
export function offeredSource(source: TimelineSource, offered: readonly HistoryService[]): TimelineSource {
  return source === 'all' || source === 'mum' || offered.includes(source) ? source : 'all';
}

export async function fetchIdentityTimeline(actor: string, target: string, scope: TimelineScope, request: TimelineRequest): Promise<TimelinePage> {
  const { server: chosen, records, filters, before } = request;
  if (!uuid(target) || chosen !== undefined && !serverID(chosen) || !recordsChoices.includes(records) || before !== undefined && !cursor(before)) throw new Error('Invalid history request');
  const types = ordered(filters.types, timelineCategories), streams = ordered(filters.methods, timelineMethods);
  const token = getAccessToken();
  const query = new URLSearchParams({ scope });
  if (chosen) query.set('server', chosen);
  query.set('records', records);
  if (types.length) query.set('types', types.join(','));
  if (streams.length) query.set('methods', streams.join(','));
  if (before) query.set('before', before);
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/activity/identities/${target}/timeline?${query}`, { retryAuthentication: false });
  if (!token || token !== getAccessToken()) throw new Error('The session changed. Refresh history.');
  if (!data || data.actor_uuid !== actor || data.scope !== scope || data.target_uuid !== target || data.records !== records || !Array.isArray(data.items) ||
      !(data.next_before === null || cursor(data.next_before)) || !Array.isArray(data.servers) || !Array.isArray(data.categories)) throw new Error('Invalid history page');
  const servers = data.servers.map(server);
  const categories = data.categories as TimelineCategory[];
  if (new Set(servers.map(s => s.server_id)).size !== servers.length || categories.some(c => !timelineCategories.includes(c)) ||
      categories.join() !== timelineCategories.filter(c => categories.includes(c)).join() ||
      (data.server_id === null ? servers.length !== 0 : !servers.some(s => s.server_id === data.server_id)) || chosen !== undefined && data.server_id !== chosen) throw new Error('Invalid history page');
  const seen = new Set<string>();
  return Object.freeze({ actor_uuid: actor, scope, target_uuid: target, server_id: data.server_id as string | null, records, servers: Object.freeze(servers),
    categories: Object.freeze([...categories]), items: data.items.map(value => item(value, seen)), next_before: data.next_before as string | null });
}

// A server's history (its History tab and the History page): everyone's plays
// on one server, with an optional person. Administrators only.
export type TimelinePerson = Readonly<{ uuid: string; name: string }>;
export type ServerTimelineRequest = Readonly<{ server?: string; user?: string; records: TimelineRecords; filters: TimelineFilters; before?: string }>;
export type ServerTimelinePage = Readonly<{
  actor_uuid: string; user: string | null; server_id: string | null; records: TimelineRecords;
  servers: readonly TimelineServer[]; categories: readonly TimelineCategory[]; people: readonly TimelinePerson[]; items: TimelineItem[]; next_before: string | null;
}>;

export async function fetchServerTimeline(actor: string, request: ServerTimelineRequest): Promise<ServerTimelinePage> {
  const { server: chosen, user, records, filters, before } = request;
  if (chosen !== undefined && chosen !== 'all' && !serverID(chosen) || user !== undefined && !uuid(user) || !recordsChoices.includes(records) || before !== undefined && !cursor(before)) throw new Error('Invalid history request');
  const types = ordered(filters.types, timelineCategories), streams = ordered(filters.methods, timelineMethods);
  const token = getAccessToken();
  const query = new URLSearchParams();
  if (chosen) query.set('server', chosen);
  if (user) query.set('user', user);
  query.set('records', records);
  if (types.length) query.set('types', types.join(','));
  if (streams.length) query.set('methods', streams.join(','));
  if (before) query.set('before', before);
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/activity/timeline?${query}`, { retryAuthentication: false });
  if (!token || token !== getAccessToken()) throw new Error('The session changed. Refresh history.');
  if (!data || data.actor_uuid !== actor || (data.user ?? null) !== (user ?? null) || data.records !== records || !Array.isArray(data.items) || !Array.isArray(data.people) ||
      !(data.next_before === null || cursor(data.next_before)) || !Array.isArray(data.servers) || !Array.isArray(data.categories)) throw new Error('Invalid history page');
  const servers = data.servers.map(server);
  const categories = data.categories as TimelineCategory[];
  const people = data.people.map((value: unknown) => {
    const p = value as Record<string, unknown>;
    if (!p || !uuid(p.uuid) || !text(p.name)) throw new Error('Invalid history page');
    return Object.freeze({ uuid: p.uuid as string, name: p.name as string });
  });
  if (new Set(servers.map(s => s.server_id)).size !== servers.length || new Set(people.map(p => p.uuid)).size !== people.length ||
      categories.some(c => !timelineCategories.includes(c)) || categories.join() !== timelineCategories.filter(c => categories.includes(c)).join() ||
      (data.server_id === null ? servers.some(s => s.history) : data.server_id !== 'all' && !servers.some(s => s.server_id === data.server_id)) || chosen !== undefined && data.server_id !== chosen) throw new Error('Invalid history page');
  const seen = new Set<string>();
  const items = data.items.map(value => item(value, seen));
  if (items.some(i => data.server_id === 'all' ? !servers.some(s => s.server_id === i.server_id) || user !== undefined && i.person_uuid !== user : i.server_id !== data.server_id || user !== undefined && i.person_uuid !== user)) throw new Error('Invalid history page');
  return Object.freeze({ actor_uuid: actor, user: user ?? null, server_id: data.server_id as string | null, records, servers: Object.freeze(servers),
    categories: Object.freeze([...categories]), people: Object.freeze(people), items, next_before: data.next_before as string | null });
}

export const maxTimelineDelete = 500;

// Deletes the plays permanently. Sent once: a failed request is reported,
// never repeated.
export async function deleteTimelinePlays(target: string, ids: readonly string[]): Promise<number> {
  if (!uuid(target)) throw new Error('Invalid history delete');
  return deletePlays(`/api/activity/identities/${target}/timeline/delete`, ids);
}

// Deletes plays on one server, from its History tab or the History page.
export async function deleteServerTimelinePlays(server: string, ids: readonly string[]): Promise<number> {
  if (server !== 'all' && !serverID(server)) throw new Error('Invalid history delete');
  return deletePlays(`/api/activity/servers/${server}/timeline/delete`, ids);
}

async function deletePlays(path: string, ids: readonly string[]): Promise<number> {
  if (ids.length < 1 || ids.length > maxTimelineDelete || new Set(ids).size !== ids.length ||
      ids.some(id => !/^(mum|plex|jellyfin|emby|audiobookshelf)-[1-9]\d{0,18}$/.test(id))) throw new Error('Invalid history delete');
  const { data } = await requestJson<{ data?: { deleted?: unknown } }>(path, { method: 'POST', body: JSON.stringify({ ids }), retryAuthentication: false });
  if (!Number.isInteger(data?.deleted) || (data!.deleted as number) !== ids.length) throw new Error('The server returned an unexpected answer');
  return data!.deleted as number;
}
