import { requestJson } from '../util/apiClient';

// Importing a Plex server's own play history (PURGE_DESIGN.md). The import
// only reads from Plex and can run again at any time: later runs add only
// plays MUM does not have yet. The purge counts these plays with MUM's own.

export type PlexHistoryStatus = {
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

export async function readPlexHistory(serverId: number): Promise<PlexHistoryStatus> {
  if (!validServer(serverId)) throw new Error('Invalid server');
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/servers/${serverId}/plex-history`);
  if (!data || data.server_id !== serverId || !states.includes(data.state as string) || counts.some(key => !Number.isInteger(data[key]) || (data[key] as number) < 0) ||
      !(data.error_code === null || typeof data.error_code === 'string') || !(data.oldest_play === null || typeof data.oldest_play === 'string') ||
      !(data.mum_since === null || typeof data.mum_since === 'string')) throw new Error('Invalid play history status');
  const out = { server_id: serverId, state: data.state as PlexHistoryStatus['state'], error_code: data.error_code as string | null, oldest_play: data.oldest_play as string | null,
    mum_since: data.mum_since as string | null } as PlexHistoryStatus;
  for (const key of counts) out[key] = data[key] as number;
  return out;
}

// Sent once; a refused or failed start is reported, never repeated.
export async function startPlexHistoryImport(serverId: number): Promise<void> {
  if (!validServer(serverId)) throw new Error('Invalid server');
  const { data } = await requestJson<{ data?: { state?: unknown } }>(`/api/servers/${serverId}/plex-history/import`, { method: 'POST' });
  if (data?.state !== 'running') throw new Error('The server returned an unexpected answer');
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const number = (n: number) => n.toLocaleString('en-US');
const reasons: Record<string, string> = {
  plex_read_failed: 'Plex could not be read', plex_page_mismatch: 'Plex returned an unexpected page', store_failed: 'MUM could not save the plays',
  server_removed: 'the server was removed', interrupted: 'was interrupted when MUM stopped', shutdown: 'was interrupted when MUM stopped',
};

export function plexHistorySummary(s: PlexHistoryStatus): string {
  if (s.state === 'never') return 'Not imported yet.';
  if (s.state === 'running') return `Importing: ${number(s.read)} of ${number(s.total)} entries read.`;
  const oldest = s.oldest_play ? new Date(s.oldest_play) : null;
  const held = s.stored_plays && oldest && Number.isFinite(oldest.getTime())
    ? ` MUM holds ${number(s.stored_plays)} Plex plays from ${oldest.getUTCDate()} ${months[oldest.getUTCMonth()]} ${oldest.getUTCFullYear()}.` : '';
  const plays = (n: number) => `${number(n)} play${n === 1 ? '' : 's'}`;
  if (s.state === 'completed') {
    const recorded = s.already_recorded ? ` (${number(s.already_recorded)} already recorded by MUM)` : '';
    return `Last import added ${plays(s.added)}${recorded}.${held}`;
  }
  const reason = reasons[s.error_code ?? ''] ?? 'of an error';
  const why = reason.startsWith('was ') ? `The last import ${reason}` : `The last import stopped because ${reason}`;
  return `${why}; ${plays(s.added)} ${s.added === 1 ? 'was' : 'were'} added before that.${held}`;
}

const day = (value: string | null) => {
  const at = value ? new Date(value) : null;
  return at && Number.isFinite(at.getTime()) ? `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}` : null;
};

// The purge dialog's notice for a Plex server whose history has not been
// imported (never, or the last run did not finish); null when none is needed.
export function plexHistoryNotice(s: PlexHistoryStatus, serverName: string): { title: string; body: string } | null {
  if (s.state === 'completed') return null;
  if (s.state === 'running') return { title: `${serverName}: importing play history`, body: plexHistorySummary(s) };
  const since = day(s.mum_since);
  const known = since ? `MUM only knows plays it has seen since ${since}` : 'MUM has not recorded any plays on this server yet';
  const title = s.state === 'never' ? `${serverName}: play history not imported` : `${serverName}: play history import did not finish`;
  return { title, body: `${known}, so people who watched before then may look inactive. Importing the server's own play history fixes this; it only reads from Plex.` };
}
