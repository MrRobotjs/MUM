import { apiFetch, requestJson } from '../util/apiClient';

// The API Debug page's Debug Logging card: each service's HTTP and WebSocket
// streams, switched on for a limited time, their newest records and files.

export type DebugTransport = 'http' | 'websocket';
export type DebugStream = Readonly<{ provider: string; provider_name: string; transport: DebugTransport; enabled: boolean; enabled_until: string | null }>;
export type DebugLogFile = Readonly<{ name: string; provider: string; transport: DebugTransport; part: number; size_bytes: number; modified_at: string }>;
export type DebugLoggingState = Readonly<{ available: boolean; window_hours: number; streams: readonly DebugStream[]; files: readonly DebugLogFile[]; dropped_records: number }>;
export type DebugRecord = Readonly<{
  time: string; server_id: number | null; server: string; provider: string; transport: DebugTransport; direction: string;
  method: string; url: string; status: number | null; duration_ms: number | null; bytes: number; truncated: boolean; error: string; body: string;
}>;

const transports: readonly DebugTransport[] = ['http', 'websocket'];
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z]{2,32}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const fileName = /^[a-z]+-(http|websocket)\.log(\.[1-3])?$/;

function readState(value: unknown): DebugLoggingState {
  const v = value as Record<string, unknown> | undefined;
  if (!v || typeof v.available !== 'boolean' || !count(v.window_hours) || !Array.isArray(v.streams) || !Array.isArray(v.files) || !count(v.dropped_records)) throw new Error('Invalid debug logging settings');
  const streams = v.streams.map((raw: unknown) => {
    const s = raw as Record<string, unknown>;
    if (!s || !id(s.provider) || typeof s.provider_name !== 'string' || !transports.includes(s.transport as DebugTransport) || typeof s.enabled !== 'boolean'
      || !(s.enabled_until === null || date(s.enabled_until)) || s.enabled !== (s.enabled_until !== null)) throw new Error('Invalid debug logging settings');
    return Object.freeze({ provider: s.provider, provider_name: s.provider_name, transport: s.transport as DebugTransport, enabled: s.enabled, enabled_until: s.enabled_until as string | null });
  });
  const files = v.files.map((raw: unknown) => {
    const f = raw as Record<string, unknown>;
    if (!f || typeof f.name !== 'string' || !fileName.test(f.name) || !id(f.provider) || !transports.includes(f.transport as DebugTransport) || !count(f.part) || (f.part as number) > 3
      || !count(f.size_bytes) || !date(f.modified_at)) throw new Error('Invalid debug logging settings');
    return Object.freeze({ name: f.name, provider: f.provider, transport: f.transport as DebugTransport, part: f.part as number, size_bytes: f.size_bytes as number, modified_at: f.modified_at });
  });
  return Object.freeze({ available: v.available, window_hours: v.window_hours, streams: Object.freeze(streams), files: Object.freeze(files), dropped_records: v.dropped_records });
}

export async function fetchDebugLogging(): Promise<DebugLoggingState> {
  const { data } = await requestJson<{ data?: unknown }>('/api/settings/debug-logging');
  return readState(data);
}

export async function saveDebugStream(provider: string, transport: DebugTransport, enabled: boolean): Promise<DebugLoggingState> {
  if (!id(provider) || !transports.includes(transport)) throw new Error('Invalid debug stream');
  const { data } = await requestJson<{ data?: unknown }>('/api/settings/debug-logging', {
    method: 'PUT', retryAuthentication: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, transport, enabled }),
  });
  return readState(data);
}

export async function clearDebugLogs(): Promise<DebugLoggingState> {
  const { data } = await requestJson<{ data?: unknown }>('/api/settings/debug-logging/files', { method: 'DELETE', retryAuthentication: false });
  return readState(data);
}

const optionalCount = (v: unknown) => v === undefined || count(v);
const optionalText = (v: unknown) => v === undefined || typeof v === 'string';

export async function fetchDebugRecords(provider: string, transport: DebugTransport, limit = 50): Promise<readonly DebugRecord[]> {
  if (!id(provider) || !transports.includes(transport) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid debug log request');
  const params = new URLSearchParams({ provider, transport, limit: String(limit) });
  const { data } = await requestJson<{ data?: { entries?: unknown } }>(`/api/settings/debug-logging/entries?${params}`);
  if (!Array.isArray(data?.entries) || data.entries.length > 200) throw new Error('Invalid debug log');
  return Object.freeze(data.entries.map((raw: unknown) => {
    const r = raw as Record<string, unknown>;
    if (!r || !date(r.time) || !id(r.provider) || !transports.includes(r.transport as DebugTransport) || typeof r.direction !== 'string' || !count(r.bytes)
      || !optionalCount(r.server_id) || !optionalText(r.server) || !optionalText(r.method) || !optionalText(r.url) || !optionalCount(r.status)
      || !optionalCount(r.duration_ms) || !(r.truncated === undefined || typeof r.truncated === 'boolean') || !optionalText(r.error) || !optionalText(r.body)) throw new Error('Invalid debug log');
    return Object.freeze({
      time: r.time, server_id: (r.server_id ?? null) as number | null, server: (r.server ?? '') as string, provider: r.provider, transport: r.transport as DebugTransport,
      direction: r.direction, method: (r.method ?? '') as string, url: (r.url ?? '') as string, status: (r.status ?? null) as number | null,
      duration_ms: (r.duration_ms ?? null) as number | null, bytes: r.bytes as number, truncated: r.truncated === true, error: (r.error ?? '') as string, body: (r.body ?? '') as string,
    });
  }));
}

// downloadDebugLog saves one file: the request carries the sign-in, so the
// file is fetched and handed to the browser rather than linked.
export async function downloadDebugLog(name: string): Promise<void> {
  if (!fileName.test(name)) throw new Error('Invalid debug log file');
  const response = await apiFetch(`/api/settings/debug-logging/files/${name}`);
  if (!response.ok) throw new Error('Debug log download failed');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = `mum-${name}.jsonl`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
