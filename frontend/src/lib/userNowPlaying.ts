import { observationProgress, type ActivityHistoryPage, type ActivityHistoryRow } from './activityHistory';

// What a user card shows while its user is streaming (matches UserCard's
// UserNowPlaying shape).
export type CardNowPlaying = {
  state: string;
  mediaTitle: string;
  serviceType: string | null;
  serverName: string | null;
  sessionCount: number;
  // Percent played, when the server reports both position and length.
  progress: number | null;
};

export type NowPlayingUser = {
  uuid: string;
  server_id?: number | null;
  server_nickname?: string | null;
};

// The server's own playback state (playing, paused or buffering) when the
// viewer may see stream details, otherwise the paused flag. Shared with the
// user page's Now playing card.
export const playbackState = (row: ActivityHistoryRow) => row.display?.state ?? (row.paused ? 'paused' : 'playing');
// Active playback first, then the most recent.
export const byPlayback = (a: ActivityHistoryRow, b: ActivityHistoryRow) => stateRank(playbackState(a)) - stateRank(playbackState(b)) || b.last_observed_at.localeCompare(a.last_observed_at);
const stateRank = (state: string) => (state === 'playing' ? 0 : state === 'buffering' ? 1 : 2);

// Maps the administrator current-activity page to the users on a card page.
// A session belongs to the service account that is playing and to the local
// account that owns it. Only open observations from servers whose monitoring
// is currently fresh count, so a card never claims playback from stale data.
export function userNowPlaying(page: ActivityHistoryPage | undefined, users: NowPlayingUser[]): Map<string, CardNowPlaying> {
  const result = new Map<string, CardNowPlaying>();
  if (!page) return result;
  const fresh = new Map(page.servers.filter((s) => s.freshness === 'fresh').map((s) => [s.server_id, s]));
  const live = page.items.filter((row) => row.ended_observation_at === null && fresh.has(row.server_id));
  for (const user of users) {
    const rows = live.filter((row) => row.service_uuid === user.uuid || row.owner_uuid === user.uuid);
    if (rows.length === 0) continue;
    const primary = [...rows].sort(byPlayback)[0];
    const sameServer = user.server_id != null && String(user.server_id) === primary.server_id;
    result.set(user.uuid, {
      state: playbackState(primary),
      mediaTitle: primary.title,
      serviceType: fresh.get(primary.server_id)?.provider ?? null,
      serverName: sameServer ? user.server_nickname ?? null : null,
      sessionCount: rows.length,
      progress: observationProgress(primary.position_ticks, primary.duration_ticks),
    });
  }
  return result;
}
