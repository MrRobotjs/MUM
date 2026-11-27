import { requestJson } from '../util/apiClient';

// The log of a server refresh task's recent runs, newest first: how each run
// ended and what it did, written by MUM.

export type RefreshLogLevel = 'success' | 'info' | 'warning' | 'error';
export type RefreshItemChange = 'added' | 'updated' | 'removed' | 'skipped';
/** A title or account an entry is about; item_id, library_id and poster_url are set for titles still in the catalogue. */
export type RefreshLogItem = Readonly<{ title: string; change: RefreshItemChange; note: string; item_id: number | null; library_id: number | null; poster_url: string | null }>;
export type RefreshLogEntry = Readonly<{ level: RefreshLogLevel; message: string; detail: string; items: readonly RefreshLogItem[]; more_items: number }>;
export type RefreshRunOutcome = 'succeeded' | 'warnings' | 'failed' | 'cancelled';
export type RefreshRun = Readonly<{ id: number; started_at: string; finished_at: string; outcome: RefreshRunOutcome; entries: readonly RefreshLogEntry[] }>;

const levels: readonly RefreshLogLevel[] = ['success', 'info', 'warning', 'error'];
const outcomes: readonly RefreshRunOutcome[] = ['succeeded', 'warnings', 'failed', 'cancelled'];
const changes: readonly RefreshItemChange[] = ['added', 'updated', 'removed', 'skipped'];
const optionalId = (v: unknown) => v === undefined || positive(v);
// Poster links are MUM's own signed image routes.
const posterURL = (v: unknown) => v === undefined || typeof v === 'string' && v.startsWith('/api/media/images/') && v.length <= 2048;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

export async function fetchRefreshRuns(server: number, scope: 'users' | 'libraries', signal?: AbortSignal): Promise<readonly RefreshRun[]> {
  if (!positive(server) || (scope !== 'users' && scope !== 'libraries')) throw new Error('Invalid refresh log request');
  const { data } = await requestJson<{ data?: { runs?: unknown } }>(`/api/servers/${server}/refresh-runs?scope=${scope}`, { signal });
  const list = data?.runs;
  if (!Array.isArray(list) || list.length > 20) throw new Error('Invalid refresh log');
  return Object.freeze(list.map((value: unknown) => {
    const v = value as Record<string, unknown>;
    if (!v || !positive(v.id) || !date(v.started_at) || !date(v.finished_at) || !outcomes.includes(v.outcome as RefreshRunOutcome) || !Array.isArray(v.entries) || v.entries.length > 101) {
      throw new Error('Invalid refresh log');
    }
    const entries = v.entries.map((raw: unknown) => {
      const e = raw as Record<string, unknown>;
      if (!e || !levels.includes(e.level as RefreshLogLevel) || !text(e.message, 600) || !(e.detail === undefined || text(e.detail, 600))
        || !(e.items === undefined || Array.isArray(e.items) && e.items.length <= 25) || !(e.more_items === undefined || Number.isSafeInteger(e.more_items) && (e.more_items as number) > 0)) throw new Error('Invalid refresh log');
      const items = ((e.items ?? []) as unknown[]).map((rawItem: unknown) => {
        const i = rawItem as Record<string, unknown>;
        if (!i || !text(i.title, 600) || !changes.includes(i.change as RefreshItemChange) || !(i.note === undefined || text(i.note, 600))
          || !optionalId(i.item_id) || !optionalId(i.library_id) || !posterURL(i.poster_url)) throw new Error('Invalid refresh log');
        return Object.freeze({ title: i.title, change: i.change as RefreshItemChange, note: (i.note ?? '') as string, item_id: (i.item_id ?? null) as number | null,
          library_id: (i.library_id ?? null) as number | null, poster_url: (i.poster_url ?? null) as string | null });
      });
      return Object.freeze({ level: e.level as RefreshLogLevel, message: e.message, detail: (e.detail ?? '') as string, items: Object.freeze(items), more_items: (e.more_items ?? 0) as number });
    });
    return Object.freeze({ id: v.id, started_at: v.started_at, finished_at: v.finished_at, outcome: v.outcome as RefreshRunOutcome, entries: Object.freeze(entries) });
  }));
}
