import { requestJson } from '../util/apiClient';
import { getAccessToken } from '../store/authStore';
import { observationPosition, observationProgress, type ActivityHistoryPage, type ActivityScope } from './activityHistory';
import { historyServices, type HistoryService } from './playHistory';
import type { TimelineSource } from './identityTimeline';
import { byPlayback, playbackState } from './userNowPlaying';

// The user page's Profile tab: plays and watched time per period, like
// Tautulli, for the History tab's sources (everything, MUM's plays or one
// service's imported plays); the last play; and what the person plays now.
// Watched time comes only from MUM's plays, so each period says how many of
// its plays have time.

// platform is the one most of the app's plays reported (Plex only), for its logo.
export type PlayerPlays = Readonly<{ client: string; platform: string | null; plays: string }>;
export type PlayPeriod = Readonly<{ period: 'day' | 'week' | 'month' | 'all'; plays: string; timed_plays: string; seconds: string }>;
export type LastPlay = Readonly<{ source: 'mum' | HistoryService; media_type: string; title: string; parent_title: string | null; played_at: string; poster_url?: string }>;
export type IdentityPlayTotals = Readonly<{
  actor_uuid: string; scope: ActivityScope; target_uuid: string; source: TimelineSource; sources: readonly HistoryService[];
  imported_plays: string; periods: readonly PlayPeriod[]; last_play: LastPlay | null; players: readonly PlayerPlays[];
}>;

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const count = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,18})$/.test(v);
const sources: readonly string[] = ['all', 'mum', ...historyServices];
const service = (v: unknown): v is HistoryService => historyServices.includes(v as HistoryService);
const periodNames = ['day', 'week', 'month', 'all'];
const player = (v: unknown) => {
  const p = v as Record<string, unknown> | null;
  return !!p && typeof p.client === 'string' && p.client !== '' && (p.platform === null || typeof p.platform === 'string' && p.platform !== '' && [...p.platform].length <= 64) &&
    count(p.plays) && p.plays !== '0';
};
// Periods come in order and each holds the one before it.
const periodsValid = (v: unknown): v is PlayPeriod[] => Array.isArray(v) && v.length === 4 && v.every((p, i) => {
  const r = p as Record<string, unknown> | null;
  if (!r || r.period !== periodNames[i] || !count(r.plays) || !count(r.timed_plays) || !count(r.seconds) || BigInt(r.timed_plays) > BigInt(r.plays)) return false;
  const prev = i > 0 ? v[i - 1] as PlayPeriod : null;
  return !prev || BigInt(prev.plays) <= BigInt(r.plays) && BigInt(prev.timed_plays) <= BigInt(r.timed_plays) && BigInt(prev.seconds) <= BigInt(r.seconds);
});
const lastValid = (v: unknown): v is LastPlay | null => {
  if (v === null) return true;
  const r = v as Record<string, unknown> | undefined;
  return !!r && (r.source === 'mum' || service(r.source)) && typeof r.media_type === 'string' && typeof r.title === 'string' &&
    (r.parent_title === null || typeof r.parent_title === 'string') && typeof r.played_at === 'string' && Number.isFinite(Date.parse(r.played_at)) &&
    (r.poster_url === undefined || typeof r.poster_url === 'string' && r.poster_url.startsWith(r.source === 'mum' ? '/api/activity/history-images/' : '/api/activity/imported-history-images/'));
};

export async function fetchIdentityPlayTotals(actor: string, target: string, scope: ActivityScope, source: TimelineSource): Promise<IdentityPlayTotals> {
  if (!uuid(target) || (scope !== 'own' && scope !== 'all') || !sources.includes(source)) throw new Error('Invalid play totals request');
  const token = getAccessToken();
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/activity/identities/${target}/plays?${new URLSearchParams({ scope, source })}`, { retryAuthentication: false });
  if (!token || token !== getAccessToken()) throw new Error('The session changed. Refresh the profile.');
  if (!data || data.actor_uuid !== actor || data.scope !== scope || data.target_uuid !== target || data.source !== source ||
      !Array.isArray(data.sources) || !data.sources.every(service) || new Set(data.sources).size !== data.sources.length ||
      !count(data.imported_plays) || !periodsValid(data.periods) || !lastValid(data.last_play) || !Array.isArray(data.players) || !data.players.every(player)) throw new Error('Invalid play totals');
  const all = data.periods[3];
  // MUM's plays have time and imported ones do not, so all time adds up.
  if (BigInt(all.timed_plays) + BigInt(data.imported_plays) !== BigInt(all.plays)) throw new Error('Invalid play totals');
  return Object.freeze({ actor_uuid: actor, scope, target_uuid: target, source, sources: Object.freeze([...data.sources as HistoryService[]]),
    imported_plays: data.imported_plays, periods: Object.freeze(data.periods.map(p => Object.freeze({ period: p.period, plays: p.plays, timed_plays: p.timed_plays, seconds: p.seconds }))),
    last_play: data.last_play ? Object.freeze({ ...data.last_play }) : null,
    players: Object.freeze((data.players as PlayerPlays[]).map(p => Object.freeze({ client: p.client, platform: p.platform, plays: p.plays }))) });
}

// watchTime splits seconds into Tautulli's parts: days, hours and minutes,
// leaving out leading zeros ("2 hrs 57 mins", "0 mins").
export function watchTime(seconds: string): [string, string][] {
  const minutes = BigInt(seconds) / 60n, days = minutes / 1440n, hours = minutes % 1440n / 60n, mins = minutes % 60n;
  const part = (v: bigint, one: string, many: string): [string, string] => [v.toLocaleString(), v === 1n ? one : many];
  const out: [string, string][] = [];
  if (days > 0n) out.push(part(days, 'day', 'days'));
  if (days > 0n || hours > 0n) out.push(part(hours, 'hr', 'hrs'));
  out.push(part(mins, 'min', 'mins'));
  return out;
}

const serviceNames: Readonly<Record<string, string>> = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby', audiobookshelf: 'Audiobookshelf', kavita: 'Kavita', komga: 'Komga', romm: 'RomM' };

export type NowPlaying = Readonly<{
  title: string; subtitle: string | null;
  // playing, paused or buffering, as on the user cards.
  state: string;
  serverName: string; serviceType: string | null;
  // Percent watched, when the server reports both position and length.
  progress: number | null; position: string; duration: string;
  updatedAt: string;
  // Other things playing at the same time.
  others: number;
}>;

// nowPlaying is the person's current play, shown only while MUM is hearing
// from that server; a play on a server gone quiet may already have stopped.
export function nowPlaying(page: ActivityHistoryPage | undefined, target: string, serverNames: ReadonlyMap<string, string>): NowPlaying | null {
  if (!page || page.target_uuid !== target) return null;
  const playing = page.items.filter(row => row.ended_observation_at === null && page.servers.some(s => s.server_id === row.server_id && s.freshness === 'fresh'));
  const row = [...playing].sort(byPlayback)[0];
  if (!row) return null;
  const provider = page.servers.find(s => s.server_id === row.server_id)?.provider ?? null;
  return Object.freeze({
    title: row.title || 'Unknown title', subtitle: row.parent_title || null, state: playbackState(row),
    serverName: serverNames.get(row.server_id) || (provider && serviceNames[provider]) || provider || 'Unknown server', serviceType: provider,
    progress: observationProgress(row.position_ticks, row.duration_ticks), position: observationPosition(row.position_ticks), duration: observationPosition(row.duration_ticks),
    updatedAt: row.last_observed_at, others: playing.length - 1,
  });
}
