import { ApiError, requestJson } from '../util/apiClient';

// Importing one person's history from one server, from the History tab.
// Plex and Audiobookshelf import just the
// person's plays; Jellyfin and Emby can only import the whole server, which
// the History tab offers with the server import in playHistory.ts; Kavita,
// Komga and RomM keep no history MUM can import.

export type PersonImportSupport = 'account' | 'server' | 'none';
export type PersonImportStatus = Readonly<{
  server_id: number;
  support: PersonImportSupport;
  state: 'never' | 'running' | 'completed' | 'failed' | 'stopped';
  added: number;
  // This person's own new plays from that run; a full import's other counts
  // cover every user on the server.
  person_added: number;
  already_stored: number;
  already_recorded: number;
  error_code: string | null;
  // Whether the last run imported one person ("account") or the whole server.
  scope: 'account' | 'server' | null;
}>;
export type PersonImportStart = 'started' | 'busy' | 'full_import_only' | 'unavailable';

const uuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const serverNumber = (v: string) => {
  if (!/^[1-9]\d{0,15}$/.test(v)) throw new Error('Invalid history import');
  return Number(v);
};
const supports = ['account', 'server', 'none'];
const states = ['never', 'running', 'completed', 'failed', 'stopped'];
const counts = ['added', 'person_added', 'already_stored', 'already_recorded'] as const;

export async function fetchPersonHistoryImport(target: string, server: string): Promise<PersonImportStatus> {
  const id = serverNumber(server);
  if (!uuid(target)) throw new Error('Invalid history import');
  const { data } = await requestJson<{ data?: Record<string, unknown> }>(`/api/activity/identities/${target}/history-import?server=${id}`, { retryAuthentication: false });
  if (!data || data.server_id !== id || !supports.includes(data.support as string) || !states.includes(data.state as string) ||
      counts.some(key => !Number.isInteger(data[key]) || (data[key] as number) < 0) || !(data.error_code === null || typeof data.error_code === 'string') ||
      !(data.scope === null || data.scope === 'account' || data.scope === 'server')) throw new Error('Invalid history import status');
  return Object.freeze({ server_id: id, support: data.support as PersonImportSupport, state: data.state as PersonImportStatus['state'], added: data.added as number, person_added: data.person_added as number,
    already_stored: data.already_stored as number, already_recorded: data.already_recorded as number, error_code: data.error_code as string | null,
    scope: data.scope as PersonImportStatus['scope'] });
}

const refusals: Readonly<Record<string, PersonImportStart>> = { HISTORY_RUNNING: 'busy', HISTORY_FULL_IMPORT_ONLY: 'full_import_only', HISTORY_UNAVAILABLE: 'unavailable' };

// Sent once; a refused start says why, a failed one is reported, never repeated.
export async function startPersonHistoryImport(target: string, server: string): Promise<PersonImportStart> {
  const id = serverNumber(server);
  if (!uuid(target)) throw new Error('Invalid history import');
  try {
    const { data } = await requestJson<{ data?: { state?: unknown; server_id?: unknown } }>(`/api/activity/identities/${target}/history-import`,
      { method: 'POST', body: JSON.stringify({ server_id: id }), retryAuthentication: false });
    if (data?.state !== 'running' || data.server_id !== id) throw new Error('The server returned an unexpected answer');
    return 'started';
  } catch (error) {
    const code = error instanceof ApiError && error.status === 409 ? (error.payload as { error?: { code?: string } } | undefined)?.error?.code : undefined;
    if (code && refusals[code]) return refusals[code];
    throw error;
  }
}

// How a server type's history can be imported for one person, as the server
// decides it: just theirs, only the whole server, or not at all.
export const historyImportSupport = (serviceType: string): PersonImportSupport =>
  serviceType === 'plex' || serviceType === 'audiobookshelf' ? 'account' : serviceType === 'jellyfin' || serviceType === 'emby' ? 'server' : 'none';

const reasons: Readonly<Record<string, string>> = { server_read_failed: 'the server could not be read', page_mismatch: 'the server returned an unexpected page',
  store_failed: 'MUM could not save the plays', server_removed: 'the server was removed', interrupted: 'MUM stopped', shutdown: 'MUM stopped' };

// What a finished import brought for this person. Only their own plays are
// counted: a Jellyfin or Emby import reads the whole server.
export function personImportSummary(s: PersonImportStatus): string {
  const n = s.person_added;
  const plays = n === 0 ? 'no new plays' : `${n.toLocaleString('en-US')} new play${n === 1 ? '' : 's'}`;
  if (s.state === 'completed') return n === 0 ? 'Import finished: nothing new to import for them.' : `Import finished: ${plays} for them.`;
  return `The import stopped because ${reasons[s.error_code ?? ''] ?? 'of an error'}; ${plays} for them ${n === 1 ? 'was' : 'were'} added before that.`;
}
