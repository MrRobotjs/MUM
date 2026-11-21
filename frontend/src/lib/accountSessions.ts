import { requestJson } from '../util/apiClient';

// Sign-in sessions: a person's signed-in devices, signing them out, and an
// administrator signing a user out everywhere. Nothing here is retried: a
// failed request is reported and read again by the caller.

export type AccountSession = Readonly<{
  id: string;
  current: boolean;
  sign_in: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  user_agent: string | null;
  ip_address: string | null;
}>;

const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const optional = (v: unknown) => v === null || v === undefined || text(v);

export async function fetchAccountSessions(signal?: AbortSignal): Promise<readonly AccountSession[]> {
  const { data } = await requestJson<{ data?: { sessions?: unknown } }>('/api/account/sessions', { signal });
  const list = data?.sessions;
  if (!Array.isArray(list)) throw new Error('Invalid session list');
  return Object.freeze(list.map((value: Record<string, unknown>) => {
    if (!value || !text(value.id) || typeof value.current !== 'boolean' || !text(value.sign_in) || !text(value.created_at) || !text(value.last_used_at)
      || !text(value.expires_at) || !optional(value.user_agent) || !optional(value.ip_address)) throw new Error('Invalid session list');
    return Object.freeze({ id: value.id as string, current: value.current, sign_in: value.sign_in as string, created_at: value.created_at as string,
      last_used_at: value.last_used_at as string, expires_at: value.expires_at as string, user_agent: (value.user_agent ?? null) as string | null, ip_address: (value.ip_address ?? null) as string | null });
  }));
}

/** Signs out one of the asker's devices; says whether it was the one asking. */
export async function endAccountSession(id: string): Promise<{ signedOutHere: boolean }> {
  const { data } = await requestJson<{ data?: { signed_out_here?: unknown } }>(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', retryAuthentication: false });
  if (typeof data?.signed_out_here !== 'boolean') throw new Error('Invalid sign-out confirmation');
  return { signedOutHere: data.signed_out_here };
}

/** Signs out every device but this one; returns how many were signed out. */
export async function signOutOtherSessions(): Promise<number> {
  const { data } = await requestJson<{ data?: { ended?: unknown } }>('/api/account/sessions/sign-out-others', { method: 'POST', retryAuthentication: false });
  if (!Number.isSafeInteger(data?.ended) || (data?.ended as number) < 0) throw new Error('Invalid sign-out confirmation');
  return data!.ended as number;
}

/** Signs out this device and all other devices. */
export async function signOutAllSessions(): Promise<void> {
  const { data } = await requestJson<{ data?: { signed_out_here?: unknown; ended?: unknown } }>('/api/account/sessions/sign-out-all', { method: 'POST', retryAuthentication: false });
  if (data?.signed_out_here !== true || !Number.isSafeInteger(data?.ended) || (data.ended as number) < 1) throw new Error('Invalid sign-out confirmation');
}

/** An administrator signs a user out of every device; returns how many sessions ended. */
export async function signOutUserEverywhere(user: string): Promise<number> {
  const { data } = await requestJson<{ data?: { ended?: unknown } }>(`/api/users/${encodeURIComponent(user)}/sessions/sign-out`, { method: 'POST', retryAuthentication: false });
  if (!Number.isSafeInteger(data?.ended) || (data?.ended as number) < 0) throw new Error('Invalid sign-out confirmation');
  return data!.ended as number;
}

/** "Chrome on Windows" from a browser's user agent; "Unknown device" when it can't tell. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari' : null;
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'Unknown device';
}

/** How a session was signed in, in words. */
export function describeSignIn(kind: string): string {
  return ({ password: 'Password', service: 'Media server login', plex_connection: 'Plex', discord: 'Discord' } as Record<string, string>)[kind] ?? 'Sign-in';
}
