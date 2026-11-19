import { requestJson } from '../util/apiClient';
import { formatDisplayTimestamp, type DisplayValues } from './accountDisplay';

// Importing a server's own play history from Plex,
// Jellyfin, Emby or Audiobookshelf. The import only reads from the server and
// can run again at any time: later runs add only plays MUM does not have yet.
// The History tab and Last Streamed show these plays; the Plex purge counts
// them with MUM's own.

export type HistoryService = 'plex' | 'jellyfin' | 'emby' | 'audiobookshelf';
export const historyServices: readonly HistoryService[] = ['plex', 'jellyfin', 'emby', 'audiobookshelf'];
export const historyServiceName: Readonly<Record<HistoryService, string>> = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby', audiobookshelf: 'Audiobookshelf' };
export const importsHistory = (serviceType: string): serviceType is HistoryService => historyServices.includes(serviceType as HistoryService);

export type PlayHistoryStatus = {
  server_id: number;
  state: 'never' | 'running' | 'completed' | 'failed' | 'stopped';
  total: number;
  read: number;
  added: number;
  already_stored: number;
  already_recorded: number;
  unknown_accounts: number;
  error_code: string | null;
  stored_plays: number;
  oldest_play: string | null;
  // When MUM first recorded a play on this server, if it has.
  mum_since: string | null;
};

const states = ['never', 'running', 'completed', 'failed', 'stopped'];
const counts = ['total', 'read', 'added', 'already_stored', 'already_recorded', 'unknown_accounts', 'stored_plays'] as const;
const validServer = (id: number) => Number.isInteger(id) && id > 0;

export async function readPlayHistory(serverId: number): Promise<PlayHistoryStatus> {
  if (!validServer(serverId)) throw new Error('Invalid server');
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/servers/${serverId}/play-history`);
  if (!data || data.server_id !== serverId || !states.includes(data.state as string) || counts.some(key => !Number.isInteger(data[key]) || (data[key] as number) < 0) ||
      !(data.error_code === null || typeof data.error_code === 'string') || !(data.oldest_play === null || typeof data.oldest_play === 'string') ||
      !(data.mum_since === null || typeof data.mum_since === 'string')) throw new Error('Invalid play history status');
  const out = { server_id: serverId, state: data.state as PlayHistoryStatus['state'], error_code: data.error_code as string | null, oldest_play: data.oldest_play as string | null,
    mum_since: data.mum_since as string | null } as PlayHistoryStatus;
  for (const key of counts) out[key] = data[key] as number;
  return out;
}

// Sent once; a refused or failed start is reported, never repeated.
export async function startPlayHistoryImport(serverId: number): Promise<void> {
  if (!validServer(serverId)) throw new Error('Invalid server');
  const { data } = await requestJson<{ data?: { state?: unknown } }>(`/api/servers/${serverId}/play-history/import`, { method: 'POST' });
  if (data?.state !== 'running') throw new Error('The server returned an unexpected answer');
}

const number = (n: number) => n.toLocaleString('en-US');
const reasons = (name: string): Record<string, string> => ({
  server_read_failed: `${name} could not be read`, page_mismatch: `${name} returned an unexpected page`, store_failed: 'MUM could not save the plays',
  server_removed: 'the server was removed', interrupted: 'was interrupted when MUM stopped', shutdown: 'was interrupted when MUM stopped',
});

// A day in the account's timezone, or null before the display settings are read.
const day = (value: string | null, settings: DisplayValues | undefined) => formatDisplayTimestamp(value, settings, 'date', '') || null;

export function playHistorySummary(s: PlayHistoryStatus, service: HistoryService, settings?: DisplayValues): string {
  const name = historyServiceName[service];
  if (s.state === 'never') return 'Not imported yet.';
  if (s.state === 'running') return `Importing: ${number(s.read)} of ${number(s.total)} entries read.`;
  const oldest = day(s.oldest_play, settings);
  const held = s.stored_plays && oldest ? ` MUM holds ${number(s.stored_plays)} ${name} plays from ${oldest}.` : '';
  const plays = (n: number) => `${number(n)} play${n === 1 ? '' : 's'}`;
  if (s.state === 'completed') {
    const recorded = s.already_recorded ? ` (${number(s.already_recorded)} already recorded by MUM)` : '';
    return `Last import added ${plays(s.added)}${recorded}.${held}`;
  }
  const reason = reasons(name)[s.error_code ?? ''] ?? 'of an error';
  const why = reason.startsWith('was ') ? `The last import ${reason}` : `The last import stopped because ${reason}`;
  return `${why}; ${plays(s.added)} ${s.added === 1 ? 'was' : 'were'} added before that.${held}`;
}

// The purge dialog's notice for a Plex server whose history has not been
// imported (never, or the last run did not finish); null when none is needed.
export function playHistoryNotice(s: PlayHistoryStatus, serverName: string, settings?: DisplayValues): { title: string; body: string } | null {
  if (s.state === 'completed') return null;
  if (s.state === 'running') return { title: `${serverName}: importing play history`, body: playHistorySummary(s, 'plex') };
  const since = day(s.mum_since, settings);
  const known = since ? `MUM only knows plays it has seen since ${since}` : 'MUM has not recorded any plays on this server yet';
  const title = s.state === 'never' ? `${serverName}: play history not imported` : `${serverName}: play history import did not finish`;
  return { title, body: `${known}, so people who watched before then may look inactive. Importing the server's own play history fixes this; it only reads from Plex.` };
}
