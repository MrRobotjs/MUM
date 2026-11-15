import { requestJson } from '../util/apiClient';

// Sign in with a media server login (Plex, Jellyfin, Emby, Audiobookshelf,
// Kavita). The chosen server checks its own username and password; MUM keeps
// neither. Answers are checked before use so a malformed reply never changes
// what the login or account page offers.

export type SignInServer = { id: number; name: string; type: string };
export type SignInMethods = { serviceSignIn: boolean; plex: boolean; servers: SignInServer[] };
export type ServiceLink = { serviceUuid: string; serverId: number; serverName: string; serverType: string; username: string; canUnlink: boolean };
export type ServiceLinks = { links: ServiceLink[]; servers: SignInServer[]; serviceSignIn: boolean };
export type SignInSettings = { serviceSignIn: boolean; serviceSignInAdmins: boolean; passwordlessAccounts: number; passwordlessAdmins: number };

const credentialTypes = ['jellyfin', 'emby', 'audiobookshelf', 'kavita'];

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function servers(value: unknown): SignInServer[] {
  if (!Array.isArray(value)) throw new Error('Unexpected sign-in server list');
  const seen = new Set<number>();
  return value.map((raw) => {
    const s = record(raw);
    if (!s || !Number.isSafeInteger(s.id) || (s.id as number) < 1 || seen.has(s.id as number) || typeof s.name !== 'string' || !credentialTypes.includes(s.type as string)) {
      throw new Error('Unexpected sign-in server');
    }
    seen.add(s.id as number);
    return { id: s.id as number, name: s.name, type: s.type as string };
  });
}

export function parseSignInMethods(value: unknown): SignInMethods {
  const v = record(value);
  if (!v || typeof v.service_sign_in !== 'boolean' || typeof v.plex !== 'boolean') throw new Error('Unexpected sign-in methods');
  const list = servers(v.servers);
  // A linked Plex account signs in without the media server switch.
  if (!v.service_sign_in && list.length) throw new Error('Unexpected sign-in methods');
  return { serviceSignIn: v.service_sign_in, plex: v.plex, servers: list };
}

export function parseServiceLinks(value: unknown): ServiceLinks {
  const v = record(value);
  if (!v || typeof v.service_sign_in !== 'boolean' || !Array.isArray(v.links)) throw new Error('Unexpected linked accounts');
  const links = v.links.map((raw) => {
    const l = record(raw);
    if (!l || typeof l.service_uuid !== 'string' || !/^[0-9a-f-]{36}$/.test(l.service_uuid) || !Number.isSafeInteger(l.server_id) || typeof l.server_name !== 'string' ||
      typeof l.server_type !== 'string' || typeof l.username !== 'string' || typeof l.can_unlink !== 'boolean') throw new Error('Unexpected linked account');
    return { serviceUuid: l.service_uuid, serverId: l.server_id as number, serverName: l.server_name, serverType: l.server_type, username: l.username, canUnlink: l.can_unlink };
  });
  return { links, servers: servers(v.servers), serviceSignIn: v.service_sign_in };
}

export function parseSignInSettings(value: unknown): SignInSettings {
  const v = record(value);
  if (!v || typeof v.service_sign_in !== 'boolean' || typeof v.service_sign_in_admins !== 'boolean' || !count(v.passwordless_accounts) || !count(v.passwordless_admins)) {
    throw new Error('Unexpected sign-in settings');
  }
  return { serviceSignIn: v.service_sign_in, serviceSignInAdmins: v.service_sign_in_admins, passwordlessAccounts: v.passwordless_accounts, passwordlessAdmins: v.passwordless_admins };
}

export async function getSignInMethods(): Promise<SignInMethods> {
  const { data } = await requestJson<{ data?: unknown }>('/api/auth/methods', { retryAuthentication: false });
  return parseSignInMethods(data);
}

// serviceSignIn signs in with a server's own login and returns the access token.
export async function serviceSignIn(serverId: number, username: string, password: string, remember: boolean): Promise<string> {
  const { data } = await requestJson<{ data?: { access_token?: unknown } }>('/api/auth/service', {
    method: 'POST',
    body: JSON.stringify({ server_id: serverId, username, password, remember }),
    retryAuthentication: false,
  });
  if (typeof data?.access_token !== 'string' || data.access_token.length !== 43) throw new Error('Sign-in response did not include an access token');
  return data.access_token;
}

export async function getServiceLinks(): Promise<ServiceLinks> {
  const { data } = await requestJson<{ data?: unknown }>('/api/account/service-links');
  return parseServiceLinks(data);
}

export async function linkServiceAccount(serverId: number, username: string, password: string): Promise<void> {
  await requestJson('/api/account/service-links', { method: 'POST', body: JSON.stringify({ server_id: serverId, username, password }) });
}

export async function unlinkServiceAccount(serviceUuid: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(serviceUuid)) throw new Error('Invalid linked account');
  await requestJson(`/api/account/service-links/${serviceUuid}`, { method: 'DELETE' });
}

export async function getSignInSettings(): Promise<SignInSettings> {
  const { data } = await requestJson<{ data?: unknown }>('/api/settings/sign-in');
  return parseSignInSettings(data);
}

export async function saveSignInSettings(serviceSignIn: boolean, serviceSignInAdmins: boolean): Promise<SignInSettings> {
  const { data } = await requestJson<{ data?: unknown }>('/api/settings/sign-in', {
    method: 'PUT',
    body: JSON.stringify({ service_sign_in: serviceSignIn, service_sign_in_admins: serviceSignIn && serviceSignInAdmins }),
  });
  return parseSignInSettings(data);
}
