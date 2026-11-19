import { requestJson } from '../util/apiClient';
import { serverPlay, type ServerAccountPlay } from './serverAccounts';
import type { TimelineRecords } from './identityTimeline';

// A server's Libraries page: each library with its activity on that server
// only, for the chosen records. Watch time comes from MUM's recordings.

export type ServerLibrary = Readonly<{
  id: number; external_id: string; name: string; library_type: string | null;
  /** The server's count, else the synced catalogue's; null when neither is known. */
  item_count: number | null; last_scanned: string | null; catalogue_synced: boolean;
  /** From a synced catalogue: seasons (shows) or albums, and episodes or tracks; null otherwise. */
  parent_count: number | null; child_count: number | null;
  plays: number; watch_seconds: number | null; last_streamed_at: string | null; last_played: ServerAccountPlay | null;
}>;
export type ServerLibrariesPage = Readonly<{
  server_id: number; server_name: string; service_type: string; live: boolean; records: TimelineRecords; items: readonly ServerLibrary[];
}>;

const text = (v: unknown): v is string => typeof v === 'string';
const optional = (v: unknown) => v === null || typeof v === 'string';
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function library(value: unknown, seen: Set<number>): ServerLibrary {
  const v = value as Record<string, unknown>;
  if (!v || !count(v.id) || seen.has(v.id) || !text(v.external_id) || !text(v.name) || !optional(v.library_type) || !(v.item_count === null || count(v.item_count)) || !(v.parent_count === null || count(v.parent_count)) || !(v.child_count === null || count(v.child_count)) || !optional(v.last_scanned) ||
      typeof v.catalogue_synced !== 'boolean' || !count(v.plays) || !(v.watch_seconds === null || count(v.watch_seconds)) || !optional(v.last_streamed_at)) throw new Error('Invalid server library');
  seen.add(v.id);
  return Object.freeze({
    id: v.id, external_id: v.external_id, name: v.name, library_type: v.library_type as string | null, item_count: v.item_count as number | null, parent_count: v.parent_count as number | null, child_count: v.child_count as number | null, last_scanned: v.last_scanned as string | null,
    catalogue_synced: v.catalogue_synced, plays: v.plays, watch_seconds: v.watch_seconds as number | null, last_streamed_at: v.last_streamed_at as string | null,
    last_played: serverPlay(v.last_played ?? null),
  });
}

export async function fetchServerLibraries(server: number, records: TimelineRecords): Promise<ServerLibrariesPage> {
  if (!Number.isSafeInteger(server) || server < 1 || !['all', 'mum', 'server'].includes(records)) throw new Error('Invalid server libraries request');
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/servers/${server}/library-activity?${new URLSearchParams({ records })}`);
  if (!data || data.server_id !== server || data.records !== records || !text(data.server_name) || !text(data.service_type) || typeof data.live !== 'boolean' || !Array.isArray(data.items)) {
    throw new Error('Invalid server libraries page');
  }
  const seen = new Set<number>();
  return Object.freeze({ server_id: server, server_name: data.server_name, service_type: data.service_type, live: data.live, records,
    items: Object.freeze(data.items.map(item => library(item, seen))) });
}
