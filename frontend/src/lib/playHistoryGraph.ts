// Play history on the Graphs pages: watched time per period, stacked by media
// type, from MUM's recorded plays, with media and person filters.

export type PlayHistoryMedia = 'movies' | 'tv' | 'music' | 'photos' | 'other';
export type PlayHistoryBucket = { start: string; end: string; seconds: Record<PlayHistoryMedia, number> };
export type PlayHistory = {
  days: number;
  media: PlayHistoryMedia | 'all';
  bucket: 'day' | 'week' | 'month';
  buckets: PlayHistoryBucket[];
  totals: Record<PlayHistoryMedia, number>;
  users: { uuid: string; name: string }[];
};

export const playHistoryMedia: PlayHistoryMedia[] = ['movies', 'tv', 'music', 'photos', 'other'];
export const playHistoryLabels: Record<PlayHistoryMedia, string> = { movies: 'Movies', tv: 'TV', music: 'Music', photos: 'Photos', other: 'Other' };
export const playHistoryColors: Record<PlayHistoryMedia, string> = { movies: '#9ad186', tv: '#f1335e', music: '#4a7cf0', photos: '#e5a00d', other: '#9ca3af' };

const invalid = () => new Error('Invalid play history');
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const seconds = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

const readSeconds = (v: unknown, complete: boolean): Record<PlayHistoryMedia, number> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  const raw = v as Record<string, unknown>;
  if (Object.keys(raw).some(key => !playHistoryMedia.includes(key as PlayHistoryMedia))) throw invalid();
  const out = {} as Record<PlayHistoryMedia, number>;
  for (const media of playHistoryMedia) {
    const value = raw[media] ?? (complete ? undefined : 0);
    if (!seconds(value)) throw invalid();
    out[media] = value;
  }
  return out;
};

/** readPlayHistory checks the server's reply strictly and fills in absent types as zero. */
export function readPlayHistory(raw: unknown, days: number): PlayHistory {
  const data = (raw as { data?: Record<string, unknown> } | null)?.data;
  if (!data || data.days !== days || !['day', 'week', 'month'].includes(data.bucket as string) ||
      !(data.media === 'all' || playHistoryMedia.includes(data.media as PlayHistoryMedia)) ||
      !Array.isArray(data.buckets) || data.buckets.length === 0 || data.buckets.length > 400 || !Array.isArray(data.users) || data.users.length > 1000) throw invalid();
  const buckets = data.buckets.map((b: unknown) => {
    const item = b as Record<string, unknown>;
    if (!item || !day(item.start) || !day(item.end) || item.start > item.end) throw invalid();
    return { start: item.start, end: item.end, seconds: readSeconds(item.seconds, false) };
  });
  for (let i = 1; i < buckets.length; i++) if (buckets[i].start <= buckets[i - 1].end) throw invalid();
  const users = data.users.map((u: unknown) => {
    const item = u as Record<string, unknown>;
    if (!item || !uuid(item.uuid) || typeof item.name !== 'string' || item.name.length > 255) throw invalid();
    return { uuid: item.uuid as string, name: item.name };
  });
  return { days, media: data.media as PlayHistory['media'], bucket: data.bucket as PlayHistory['bucket'], buckets, totals: readSeconds(data.totals, true), users };
}

/** "0s", "36m", "9.7h", "3.5d": seconds, minutes, then hours and days to one decimal. */
export function playHistoryDuration(value: number): string {
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${(value / 3600).toFixed(1)}h`;
  return `${(value / 86400).toFixed(1)}d`;
}

const utc = (value: string) => new Date(`${value}T00:00:00Z`);
const daySuffixed = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
};
const monthDay = (value: string, month: 'short' | 'long') => utc(value).toLocaleDateString(undefined, { month, day: 'numeric', timeZone: 'UTC' });
const longDay = (value: string) => `${utc(value).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' })} ${daySuffixed(utc(value).getUTCDate())}`;
const monthYear = (value: string, month: 'short' | 'long') => utc(value).toLocaleDateString(undefined, { month, year: 'numeric', timeZone: 'UTC' });

/** The axis label: "Nov 14", "Oct 26 - Nov 2" or "Nov 2026". */
export function playHistoryAxisLabel(bucket: PlayHistory['bucket'], b: Pick<PlayHistoryBucket, 'start' | 'end'>): string {
  if (bucket === 'day') return monthDay(b.start, 'short');
  if (bucket === 'month') return monthYear(b.start, 'short');
  return `${monthDay(b.start, 'short')} - ${monthDay(b.end, 'short')}`;
}

/** The tooltip title: "November 14th", "November 9th - November 16th" or "November 2026". */
export function playHistoryTitle(bucket: PlayHistory['bucket'], b: Pick<PlayHistoryBucket, 'start' | 'end'>): string {
  if (bucket === 'day') return longDay(b.start);
  if (bucket === 'month') return monthYear(b.start, 'long');
  return `${longDay(b.start)} - ${longDay(b.end)}`;
}
