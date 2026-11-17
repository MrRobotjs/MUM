import { requestJson } from '../util/apiClient';
import { getAccessToken } from '../store/authStore';
import { historyServices, type HistoryService } from './playHistory';

export { historyServiceName, type HistoryService } from './playHistory';

// The user page's History tab: MUM's recorded plays and plays imported from
// the servers' own histories in one timeline, newest first (user decisions
// 2026-11-16). Imported plays have no player or quality; only Audiobookshelf
// reports how far and how long. Posters are signed administrator links; an
// imported play's comes from its own route. The page lists the services the
// person has accounts on, for the source picker.

export type TimelineSource = 'all' | 'mum' | HistoryService;
export type TimelineScope = 'own' | 'all';
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
  play_method: 'direct_play' | 'direct_stream' | 'transcode' | null;
  position_ticks: string | null;
  duration_ticks: string | null;
  poster_url?: string;
}>;
export type TimelinePage = Readonly<{ actor_uuid: string; scope: TimelineScope; target_uuid: string; source: TimelineSource; sources: readonly HistoryService[]; items: TimelineItem[]; next_before: string | null }>;

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const cursor = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z_[mp]_[1-9]\d{0,18}$/.test(v);
const text = (v: unknown) => typeof v === 'string';
const optionalText = (v: unknown) => v === null || typeof v === 'string';
const ticks = (v: unknown) => v === null || typeof v === 'string' && /^\d{1,19}$/.test(v);
const sources: readonly string[] = ['all', 'mum', ...historyServices];
const imported = (v: unknown): v is HistoryService => historyServices.includes(v as HistoryService);
const methods = [null, 'direct_play', 'direct_stream', 'transcode'];

function item(value: unknown, seen: Set<string>): TimelineItem {
  const v = value as Record<string, unknown>;
  const fromServer = imported(v?.source);
  if (!v || (v.source !== 'mum' && !fromServer) || !text(v.id) || !(v.id as string).startsWith(`${v.source}-`) || seen.has(v.id as string) || !text(v.server_id) || !uuid(v.service_uuid) ||
      !text(v.media_type) || !text(v.title) || !optionalText(v.parent_title) || !optionalText(v.library_name) || !text(v.played_at) || !Number.isFinite(Date.parse(v.played_at as string)) ||
      !optionalText(v.client) || !methods.includes(v.play_method as string | null) || !ticks(v.position_ticks) || !ticks(v.duration_ticks) ||
      v.poster_url !== undefined && !text(v.poster_url) ||
      // Imported plays record no player or quality; only Audiobookshelf reports progress.
      fromServer && (v.client !== null || v.play_method !== null || v.source !== 'audiobookshelf' && (v.position_ticks !== null || v.duration_ticks !== null) ||
        v.poster_url !== undefined && !(v.poster_url as string).startsWith('/api/activity/imported-history-images/'))) throw new Error('Invalid history item');
  seen.add(v.id as string);
  return Object.freeze({ ...(v as TimelineItem) });
}

// The source to show for a person: the chosen one, or Combined when they have
// no account on the chosen service (for example after opening someone else).
export function offeredSource(source: TimelineSource, offered: readonly HistoryService[]): TimelineSource {
  return source === 'all' || source === 'mum' || offered.includes(source) ? source : 'all';
}

export async function fetchIdentityTimeline(actor: string, target: string, scope: TimelineScope, source: TimelineSource, before?: string): Promise<TimelinePage> {
  if (!uuid(target) || !sources.includes(source) || before !== undefined && !cursor(before)) throw new Error('Invalid history request');
  const token = getAccessToken();
  const query = new URLSearchParams({ scope, source });
  if (before) query.set('before', before);
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/activity/identities/${target}/timeline?${query}`, { retryAuthentication: false });
  if (!token || token !== getAccessToken()) throw new Error('The session changed. Refresh history.');
  if (!data || data.actor_uuid !== actor || data.scope !== scope || data.target_uuid !== target || data.source !== source || !Array.isArray(data.items) ||
      !(data.next_before === null || cursor(data.next_before)) || !Array.isArray(data.sources) || !data.sources.every(imported) ||
      new Set(data.sources).size !== data.sources.length) throw new Error('Invalid history page');
  const seen = new Set<string>();
  return Object.freeze({ actor_uuid: actor, scope, target_uuid: target, source, sources: Object.freeze([...data.sources as HistoryService[]]),
    items: data.items.map(value => item(value, seen)), next_before: data.next_before as string | null });
}
