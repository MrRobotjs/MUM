import { requestJson } from '../util/apiClient';

// A Plex server's own dashboard statistics (Plex Web's Status → Dashboard),
// read on demand: bandwidth by bin size, and the recent CPU and memory use.

export type BandwidthTimespan = 'seconds' | 'hours' | 'days' | 'weeks' | 'months';
export const BANDWIDTH_TIMESPANS: Array<{ value: BandwidthTimespan; label: string }> = [
  { value: 'seconds', label: 'Real Time' },
  { value: 'hours', label: 'Hourly' },
  { value: 'days', label: 'Daily' },
  { value: 'weeks', label: 'Weekly' },
  { value: 'months', label: 'Monthly' },
];

export type BandwidthSample = { at: string; bytes: number; lan: boolean; account_id: string | null; device_id: string | null };
export type Named = { id: string; name: string };
export type BandwidthStatistics = { samples: BandwidthSample[]; accounts: Named[]; devices: Named[] };
export type ResourceSample = { at: string; host_cpu: number | null; process_cpu: number | null; host_memory: number | null; process_memory: number | null };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const percent = (value: unknown): number | null => (finite(value) && value >= 0 ? value : null);

export async function fetchBandwidth(serverId: number, timespan: BandwidthTimespan, signal?: AbortSignal): Promise<BandwidthStatistics> {
  const { data } = await requestJson<{ data?: { server_id?: unknown; samples?: unknown; accounts?: unknown; devices?: unknown } }>(
    `/api/servers/${serverId}/statistics/bandwidth?timespan=${timespan}`, { signal, retryAuthentication: false });
  if (data?.server_id !== serverId || !Array.isArray(data.samples)) throw new Error('Unexpected bandwidth statistics');
  const named = (list: unknown): Named[] => (Array.isArray(list) ? list : [])
    .filter((n): n is Named => typeof n?.id === 'string' && typeof n?.name === 'string');
  const samples = (data.samples as BandwidthSample[]).filter((s) => typeof s?.at === 'string' && Number.isFinite(Date.parse(s.at)) && finite(s.bytes) && s.bytes >= 0 && typeof s.lan === 'boolean');
  return { samples, accounts: named(data.accounts), devices: named(data.devices) };
}

export async function fetchResources(serverId: number, signal?: AbortSignal): Promise<ResourceSample[]> {
  const { data } = await requestJson<{ data?: { server_id?: unknown; samples?: unknown } }>(
    `/api/servers/${serverId}/statistics/resources`, { signal, retryAuthentication: false });
  if (data?.server_id !== serverId || !Array.isArray(data.samples)) throw new Error('Unexpected resource statistics');
  return (data.samples as ResourceSample[])
    .filter((s) => typeof s?.at === 'string' && Number.isFinite(Date.parse(s.at)))
    .map((s) => ({ at: s.at, host_cpu: percent(s.host_cpu), process_cpu: percent(s.process_cpu), host_memory: percent(s.host_memory), process_memory: percent(s.process_memory) }));
}

export type BandwidthPoint = { at: string; remote: number; local: number };

/**
 * Bandwidth per bin, remote and local, for all accounts or one. Real-time
 * bins become a rate in kilobits per second over the gap to the previous bin
 * (the first bin, over the gap to the next);
 * longer bins stay the bytes sent in that bin.
 */
export function bandwidthSeries(samples: BandwidthSample[], timespan: BandwidthTimespan, account: string | null): BandwidthPoint[] {
  const bins = new Map<string, { remote: number; local: number }>();
  for (const s of samples) {
    if (account !== null && s.account_id !== account) continue;
    const bin = bins.get(s.at) ?? { remote: 0, local: 0 };
    if (s.lan) bin.local += s.bytes; else bin.remote += s.bytes;
    bins.set(s.at, bin);
  }
  const ordered = [...bins.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  if (timespan !== 'seconds') return ordered.map(([at, b]) => ({ at, remote: b.remote, local: b.local }));
  const seconds = (i: number) => (Date.parse(ordered[i][0]) - Date.parse(ordered[i - 1][0])) / 1000;
  return ordered.map(([at, b], i) => {
    // The first bin has no earlier one; it uses the gap to the next.
    const gap = Math.max(1, i > 0 ? seconds(i) : ordered.length > 1 ? seconds(1) : 1);
    const kbps = (bytes: number) => (bytes * 8) / 1000 / gap;
    return { at, remote: kbps(b.remote), local: kbps(b.local) };
  });
}

export type ResourcePoint = { at: string; system: number | null; plex: number | null };

/** CPU or memory use over time: the whole machine ("system") and Plex itself. */
export function resourceSeries(samples: ResourceSample[], kind: 'cpu' | 'memory'): ResourcePoint[] {
  return [...samples]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((s) => kind === 'cpu'
      ? { at: s.at, system: s.host_cpu, plex: s.process_cpu }
      : { at: s.at, system: s.host_memory, plex: s.process_memory });
}

export const formatRate = (kbps: number) =>
  kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 10000 ? 0 : 1)} Mbps` : `${Math.round(kbps)} Kbps`;

export const formatBytes = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};
