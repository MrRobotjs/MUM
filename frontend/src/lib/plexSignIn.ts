import { requestJson } from '../util/apiClient';
import { plexAuthorizationURL } from './plexConnection';

// Sign in with Plex: start a Plex approval in this browser, then check it until
// Plex has verified the account. The server signs in the MUM account linked to
// that Plex account (Account → Credentials) and answers with its session.

export type PlexSignInStart = { id: string; authorizationUrl: string; expiresAt: string };
export type PlexSignInCheck = { status: 'pending' } | { status: 'signed_in'; accessToken: string };

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export async function startPlexSignIn(remember: boolean): Promise<PlexSignInStart> {
  const { data } = await requestJson<{ data?: { id?: unknown; status?: unknown; expires_at?: unknown; authorization_url?: unknown } }>('/api/auth/plex', {
    method: 'POST',
    body: JSON.stringify({ remember }),
    retryAuthentication: false,
  });
  if (!uuid(data?.id) || data?.status !== 'pending' || typeof data.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) {
    throw new Error('Plex sign-in returned an unexpected answer');
  }
  return { id: data.id, authorizationUrl: plexAuthorizationURL(data.authorization_url), expiresAt: data.expires_at };
}

export async function checkPlexSignIn(id: string): Promise<PlexSignInCheck> {
  if (!uuid(id)) throw new Error('Invalid Plex sign-in');
  const { data } = await requestJson<{ data?: { id?: unknown; status?: unknown; access_token?: unknown } }>(`/api/auth/plex/${id}/poll`, {
    method: 'POST',
    body: '{}',
    retryAuthentication: false,
  });
  if (data?.id !== id) throw new Error('Plex sign-in returned an unexpected answer');
  if (data.status === 'pending') return { status: 'pending' };
  if (data.status === 'signed_in' && typeof data.access_token === 'string' && data.access_token.length === 43) {
    return { status: 'signed_in', accessToken: data.access_token };
  }
  throw new Error('Plex sign-in returned an unexpected answer');
}
