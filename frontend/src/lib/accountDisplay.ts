import { requestJson } from '../util/apiClient';
import { getAccessToken } from '../store/authStore';
import { parseCalendarDate, parseOffsetTimestamp } from '../util/calendarDates';

export type DisplayValues = { mode: 'device' | 'utc' | 'named'; time_format: '12' | '24'; time_zone: string | null };
export type AccountDisplay = { user_uuid: string; profile_revision: number; display: DisplayValues };

export function displayValues(value: unknown): DisplayValues {
  const v = value as DisplayValues;
  if (!v || !['device', 'utc', 'named'].includes(v.mode) || !['12', '24'].includes(v.time_format)) throw Error('Invalid display settings');
  if (v.mode === 'named') {
    if (typeof v.time_zone !== 'string' || v.time_zone.length > 128 || v.time_zone === 'Local' || v.time_zone.startsWith('/') || v.time_zone.includes('..') || !/^[A-Za-z0-9/_+-]+$/.test(v.time_zone)) throw Error('Choose a valid IANA timezone');
    try { new Intl.DateTimeFormat(undefined, { timeZone: v.time_zone }); } catch { throw Error('This browser does not support that timezone'); }
  } else if (v.time_zone !== null) throw Error('Device and UTC modes require a null timezone');
  return { mode: v.mode, time_format: v.time_format, time_zone: v.time_zone };
}

export function displayRecord(value: unknown, user: string): AccountDisplay {
  const p = value as AccountDisplay;
  if (!p || p.user_uuid !== user || !Number.isSafeInteger(p.profile_revision) || p.profile_revision < 1) throw Error('Invalid own-display response');
  return { user_uuid: p.user_uuid, profile_revision: p.profile_revision, display: displayValues(p.display) };
}

export async function fetchOwnDisplay(user: string, signal?: AbortSignal): Promise<AccountDisplay> {
  const { data } = await requestJson<{ data: unknown }>('/api/account/display', { signal, retryAuthentication: !signal });
  return displayRecord(data, user);
}

const saving = new Set<string>();
export async function saveOwnDisplay(current: AccountDisplay, values: DisplayValues): Promise<AccountDisplay> {
  const original = displayRecord(current, current.user_uuid), desired = displayValues(values);
  if (saving.has(original.user_uuid)) throw Error('Display settings are already being saved.');
  saving.add(original.user_uuid);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  try {
    const token = getAccessToken(), fresh = await fetchOwnDisplay(original.user_uuid, abort.signal);
    if (!token || token !== getAccessToken() || abort.signal.aborted || JSON.stringify(fresh) !== JSON.stringify(original)) throw Error('Account settings changed');
    const { data } = await requestJson<{ data: unknown }>('/api/account/display', {
      method: 'PUT', signal: abort.signal, retryAuthentication: false,
      body: JSON.stringify({ expected_user_uuid: original.user_uuid, profile_revision: original.profile_revision, display: desired }),
    });
    const result = displayRecord(data, original.user_uuid);
    if (abort.signal.aborted || token !== getAccessToken() || result.profile_revision !== original.profile_revision + 1 || JSON.stringify(result.display) !== JSON.stringify(desired)) throw Error('Unconfirmed display result');
    return result;
  } catch {
    throw Error('Display save could not be confirmed. Refresh before another attempt. No request was replayed.');
  } finally { clearTimeout(timer); saving.delete(original.user_uuid); }
}

export type TimestampStyle = 'datetime' | 'date' | 'time';
// Instants require an explicit offset. Calendar-only dates retain their calendar
// meaning and are never shifted across a timezone boundary.
export function formatDisplayTimestamp(value: string | null | undefined, settings: DisplayValues | undefined, style: TimestampStyle = 'datetime', fallback = '—', locale?: string): string {
  if (!settings || !value) return fallback;
  const calendar = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (calendar && style !== 'date') return fallback;
  const date = calendar ? parseCalendarDate(value) : parseOffsetTimestamp(value);
  if (!date) return fallback;
  try {
    const v = displayValues(settings);
    const options: Intl.DateTimeFormatOptions = {
      timeZone: calendar || v.mode === 'utc' ? 'UTC' : v.mode === 'named' ? v.time_zone! : undefined,
      ...(style !== 'time' ? { year: 'numeric', month: 'short', day: 'numeric' } : {}),
      ...(style !== 'date' ? { hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: v.time_format === '12' ? 'h12' : 'h23' } : {}),
    };
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch { return fallback; }
}

export function displayCalendarDayDifference(value: string, now: string, settings: DisplayValues | undefined): number | null {
  const target = parseOffsetTimestamp(value), origin = parseOffsetTimestamp(now);
  if (!settings || !target || !origin) return null;
  try {
    const v = displayValues(settings);
    const formatter = new Intl.DateTimeFormat('en-US', { calendar: 'gregory', numberingSystem: 'latn', timeZone: v.mode === 'utc' ? 'UTC' : v.mode === 'named' ? v.time_zone! : undefined, year: 'numeric', month: 'numeric', day: 'numeric' });
    const calendarDayNumber = (date: Date) => {
      const parts = formatter.formatToParts(date);
      const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
      const calendar = new Date(0);
      calendar.setUTCFullYear(part('year'), part('month') - 1, part('day'));
      calendar.setUTCHours(0, 0, 0, 0);
      return calendar.getTime() / 86400000;
    };
    return calendarDayNumber(target) - calendarDayNumber(origin);
  } catch { return null; }
}

export function formatRelativeTimestamp(value: string, now: string, settings: DisplayValues | undefined): string {
  const stamp = parseOffsetTimestamp(value), origin = parseOffsetTimestamp(now);
  if (!settings || !stamp || !origin) return '—';
  const diff = origin.getTime() - stamp.getTime();
  if (diff < 0) return formatDisplayTimestamp(value, settings);
  const minutes = Math.floor(diff / 60000), hours = Math.floor(diff / 3600000), days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min${minutes !== 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
  return formatDisplayTimestamp(value, settings, 'date');
}

export function displayExpirationInfo(value: string | null | undefined, now: string, settings: DisplayValues | undefined) {
  if (!value) return null;
  const days = displayCalendarDayDifference(value, now, settings);
  const target = parseOffsetTimestamp(value), origin = parseOffsetTimestamp(now);
  if (days === null || !target || !origin) return null;
  const isExpired = target.getTime() <= origin.getTime();
  const relativeLabel = isExpired ? 'expired' : days > 1 ? `${days} days left` : days === 1 ? '1 day left' : 'expires today';
  return { formattedDate: formatDisplayTimestamp(value, settings, 'date'), relativeLabel, isExpired };
}
