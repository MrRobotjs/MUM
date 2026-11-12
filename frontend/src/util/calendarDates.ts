// Calendar values carry no timezone. UTC is only a stable formatting reference,
// not an assertion that a calendar bucket is an instant at UTC midnight.
export function parseCalendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function parseOffsetTimestamp(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !parseCalendarDate(value.slice(0, 10))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatCalendarDate(value: string, style: 'short' | 'full' | 'numeric' = 'numeric', locale?: string): string {
  const date = parseCalendarDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', month: style === 'numeric' ? 'numeric' : 'short', day: 'numeric',
    ...(style === 'full' ? { weekday: 'short', year: 'numeric' } : style === 'numeric' ? { year: 'numeric' } : {}),
  }).format(date);
}

export function utcDateFromTimestamp(value: string): string {
  const date = parseOffsetTimestamp(value);
  if (!date) throw Error('Invalid expiration timestamp');
  return date.toISOString().slice(0, 10);
}

export function invitationExpiryFields(value: string | null | undefined) {
  return value ? { expires_at: utcDateFromTimestamp(value), original_expires_at: value } : { expires_at: null, original_expires_at: null };
}

export function invitationExpiryTimestamp(value: string, original?: string | null): string {
  if (parseCalendarDate(value)) {
    // Preserve even sub-millisecond precision when an unrelated field is edited.
    if (original && utcDateFromTimestamp(original) === value) return original;
    return `${value}T23:59:59Z`;
  }
  if (!parseOffsetTimestamp(value)) throw Error('Choose a valid UTC expiry date or an offset timestamp');
  return value;
}
