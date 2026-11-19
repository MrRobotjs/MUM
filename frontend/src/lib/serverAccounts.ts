import { requestJson } from '../util/apiClient';
import { isPlayPoster } from './playPosters';
import { avatarLink } from './accountAvatar';
import type { TimelineRecords } from './identityTimeline';

// A server's Users page: one page of the server's
// accounts with their activity on that server only, for the chosen records.
// IP, platform, player and watch time come from MUM's recordings; IP,
// platform and player are the newest ones known.

const sortColumns = ['username', 'email', 'last_streamed', 'last_played', 'last_ip', 'last_platform', 'last_player', 'plays', 'watch', 'libraries', 'expires'] as const;
export type ServerAccountSort = `${typeof sortColumns[number]}_${'asc' | 'desc'}`;
export const serverAccountSorts: readonly ServerAccountSort[] = sortColumns.flatMap(c => [`${c}_asc`, `${c}_desc`] as const);
// The Users table's columns and the server sort each one uses.
export type ServerAccountColumn = 'user' | 'username' | 'email' | 'lastStreamed' | 'lastPlayed' | 'lastIp' | 'lastPlatform' | 'lastPlayer' | 'plays' | 'watch' | 'libraries' | 'expires';
const columnSorts: Record<ServerAccountColumn, typeof sortColumns[number]> = { user: 'username', username: 'username', email: 'email', lastStreamed: 'last_streamed',
  lastPlayed: 'last_played', lastIp: 'last_ip', lastPlatform: 'last_platform', lastPlayer: 'last_player', plays: 'plays', watch: 'watch', libraries: 'libraries', expires: 'expires' };
// A table sort (a column and direction) as the server's sort; no sort or an unknown column is username A–Z.
export function serverAccountSort(sort: Readonly<{ id: string; desc: boolean }> | undefined): ServerAccountSort {
  if (!sort || !Object.prototype.hasOwnProperty.call(columnSorts, sort.id)) return 'username_asc';
  return `${columnSorts[sort.id as ServerAccountColumn]}_${sort.desc ? 'desc' : 'asc'}`;
}
export type ServerAccountPageSize = 10 | 25 | 50 | 100;
export const serverAccountPageSizes: readonly ServerAccountPageSize[] = [10, 25, 50, 100];
export type ServerAccountsRequest = Readonly<{ records: TimelineRecords; search: string; sort: ServerAccountSort; page: number; pageSize: ServerAccountPageSize }>;
// A catalogue page: a top-level item, or an episode of a show.
export type ServerAccountLink = Readonly<{ library_id: number; media_id: number; episode_id: number | null }>;
export type ServerAccountPlay = Readonly<{ title: string; parent_title: string | null; media_type: string; source: string; poster_url: string | null; link: ServerAccountLink | null }>;
export type ServerAccount = Readonly<{
  uuid: string; username: string; email: string | null; is_active: boolean; access_expires_at: string | null;
  plays: number; watch_seconds: number | null; last_streamed_at: string | null; last_played: ServerAccountPlay | null;
  last_ip: string | null; last_platform: string | null; last_player: string | null;
  linked_profile: Readonly<{ uuid: string; name: string }> | null; libraries: readonly string[]; has_all_libraries: boolean; avatar_url: string | null;
}>;
export type ServerAccountsPage = Readonly<{
  server_id: number; server_name: string; service_type: string; live: boolean; records: TimelineRecords;
  items: readonly ServerAccount[]; page: number; page_size: number; total_items: number; total_pages: number;
}>;

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text = (v: unknown) => typeof v === 'string';
const optional = (v: unknown) => v === null || typeof v === 'string';
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const sources = ['mum', 'plex', 'jellyfin', 'emby', 'audiobookshelf'];

const id = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
// Posters are the History tab's signed links: MUM's plays or imported ones.

function link(value: unknown): ServerAccountLink | null {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (!v || !id(v.library_id) || !id(v.media_id) || !(v.episode_id === null || v.episode_id === undefined || id(v.episode_id))) throw new Error('Invalid server account');
  return Object.freeze({ library_id: v.library_id, media_id: v.media_id, episode_id: (v.episode_id ?? null) as number | null });
}

/** A server's last play (Users and Libraries pages), validated; null when there's none. */
export function serverPlay(value: unknown): ServerAccountPlay | null {
  if (value === null) return null;
  const v = value as Record<string, unknown>;
  if (!v || !text(v.title) || !optional(v.parent_title) || !text(v.media_type) || !sources.includes(v.source as string) ||
      !(v.poster_url === undefined || isPlayPoster(v.poster_url))) throw new Error('Invalid server account');
  return Object.freeze({ title: v.title as string, parent_title: v.parent_title as string | null, media_type: v.media_type as string, source: v.source as string,
    poster_url: (v.poster_url ?? null) as string | null, link: link(v.link) });
}

function account(value: unknown, seen: Set<string>): ServerAccount {
  const v = value as Record<string, unknown>;
  const linked = v?.linked_profile as Record<string, unknown> | null | undefined;
  if (!v || !uuid(v.uuid) || seen.has(v.uuid) || !text(v.username) || !optional(v.email) || typeof v.is_active !== 'boolean' || !optional(v.access_expires_at) ||
      !count(v.plays) || !(v.watch_seconds === null || count(v.watch_seconds)) || !optional(v.last_streamed_at) || !optional(v.last_ip) || !optional(v.last_platform) ||
      !optional(v.last_player) || !(linked === null || linked && uuid(linked.uuid) && text(linked.name)) || !Array.isArray(v.libraries) || !v.libraries.every(text) ||
      typeof v.has_all_libraries !== 'boolean') throw new Error('Invalid server account');
  seen.add(v.uuid);
  return Object.freeze({
    uuid: v.uuid, username: v.username as string, email: v.email as string | null, is_active: v.is_active, access_expires_at: v.access_expires_at as string | null,
    plays: v.plays, watch_seconds: v.watch_seconds as number | null, last_streamed_at: v.last_streamed_at as string | null, last_played: serverPlay(v.last_played),
    last_ip: v.last_ip as string | null, last_platform: v.last_platform as string | null, last_player: v.last_player as string | null,
    linked_profile: linked ? Object.freeze({ uuid: linked.uuid as string, name: linked.name as string }) : null,
    libraries: Object.freeze([...(v.libraries as string[])]), has_all_libraries: v.has_all_libraries, avatar_url: avatarLink(v.avatar_url, 'service'),
  });
}

export async function fetchServerAccounts(server: number, request: ServerAccountsRequest): Promise<ServerAccountsPage> {
  const search = request.search.trim();
  if (!Number.isSafeInteger(server) || server < 1 || !['all', 'mum', 'server'].includes(request.records) || !serverAccountSorts.includes(request.sort) ||
      [...search].length > 200 || !Number.isSafeInteger(request.page) || request.page < 1 || !serverAccountPageSizes.includes(request.pageSize)) throw new Error('Invalid server accounts request');
  const query = new URLSearchParams({ records: request.records, sort: request.sort, page: String(request.page), page_size: String(request.pageSize) });
  if (search) query.set('search', search);
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/servers/${server}/accounts?${query}`);
  if (!data || data.server_id !== server || data.records !== request.records || !text(data.server_name) || !text(data.service_type) || typeof data.live !== 'boolean' ||
      !Array.isArray(data.items) || !count(data.page) || !count(data.page_size) || !count(data.total_items) || !count(data.total_pages)) throw new Error('Invalid server accounts page');
  const seen = new Set<string>();
  return Object.freeze({ server_id: server, server_name: data.server_name as string, service_type: data.service_type as string, live: data.live, records: request.records,
    items: Object.freeze(data.items.map(item => account(item, seen))), page: data.page, page_size: data.page_size, total_items: data.total_items, total_pages: data.total_pages });
}
