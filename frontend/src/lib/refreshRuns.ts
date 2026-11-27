import { requestJson } from '../util/apiClient';

// The log of a server refresh task's recent runs, newest first: how each run
// ended and what it did, written by MUM.

export type RefreshLogLevel = 'success' | 'info' | 'warning' | 'error';
export type RefreshLogEntry = Readonly<{ level: RefreshLogLevel; message: string; detail: string }>;
export type RefreshRunOutcome = 'succeeded' | 'warnings' | 'failed' | 'cancelled';
export type RefreshRun = Readonly<{ id: number; started_at: string; finished_at: string; outcome: RefreshRunOutcome; entries: readonly RefreshLogEntry[] }>;

const levels: readonly RefreshLogLevel[] = ['success', 'info', 'warning', 'error'];
const outcomes: readonly RefreshRunOutcome[] = ['succeeded', 'warnings', 'failed', 'cancelled'];
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
      if (!e || !levels.includes(e.level as RefreshLogLevel) || !text(e.message, 600) || !(e.detail === undefined || text(e.detail, 600))) throw new Error('Invalid refresh log');
      return Object.freeze({ level: e.level as RefreshLogLevel, message: e.message, detail: (e.detail ?? '') as string });
    });
    return Object.freeze({ id: v.id, started_at: v.started_at, finished_at: v.finished_at, outcome: v.outcome as RefreshRunOutcome, entries: Object.freeze(entries) });
  }));
}
