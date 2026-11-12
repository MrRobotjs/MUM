import { ApiError, requestJson } from '../util/apiClient';
import { getAccessToken, clearAccessToken } from '../store/authStore';

export type AccountUsername = { user_uuid: string; username: string; profile_revision: number; username_change_available: boolean; initial_credentials_available: false };
export type UsernameChangeInput = { username: string; current_password: string; acknowledge_revoke_sessions: boolean };

export function usernameRecord(value: unknown, user: string): AccountUsername {
  const p = value as AccountUsername;
  if (!p || p.user_uuid !== user || typeof p.username !== 'string' || !Number.isSafeInteger(p.profile_revision) || p.profile_revision < 1 || typeof p.username_change_available !== 'boolean' || p.initial_credentials_available !== false || p.username_change_available && !p.username) throw Error('Invalid own-username response');
  return { user_uuid: p.user_uuid, username: p.username, profile_revision: p.profile_revision, username_change_available: p.username_change_available, initial_credentials_available: false };
}

export async function fetchOwnUsername(user: string, signal?: AbortSignal): Promise<AccountUsername> {
  const { data } = await requestJson<{ data: unknown }>('/api/account/username', { signal, retryAuthentication: !signal });
  return usernameRecord(data, user);
}

export function usernameChangePayload(current: AccountUsername, input: UsernameChangeInput) {
  const p = usernameRecord(current, current.user_uuid), username = input.username.trim(), bytes = new TextEncoder().encode(input.current_password).length;
  if (!/^[0-9a-f-]{36}$/.test(p.user_uuid) || !p.username_change_available || !/^[\x20-\x7e]{1,255}$/.test(username) || username === p.username || bytes < 12 || bytes > 1024 || input.acknowledge_revoke_sessions !== true) throw Error('Enter a different username of 1–255 printable ASCII characters, your current password and all-session sign-out acknowledgment.');
  return { expected_user_uuid: p.user_uuid, profile_revision: p.profile_revision, username, current_password: input.current_password, acknowledge_revoke_sessions: true };
}

const saving = new Set<string>();
export async function changeOwnUsername(current: AccountUsername, input: UsernameChangeInput) {
  const original = usernameRecord(current, current.user_uuid), body = usernameChangePayload(original, input), token = getAccessToken();
  if (saving.has(original.user_uuid)) throw Error('A username change is already pending.');
  saving.add(original.user_uuid);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  let submitted = false;
  try {
    const fresh = await fetchOwnUsername(original.user_uuid, abort.signal);
    if (abort.signal.aborted || !token || token !== getAccessToken() || JSON.stringify(fresh) !== JSON.stringify(original)) throw Error('Profile changed');
    submitted = true;
    const { data } = await requestJson<{ data: { user_uuid: string; username: string; profile_revision: number; sessions_revoked: boolean; reauthentication_required: boolean } }>('/api/account/username', { method: 'PATCH', signal: abort.signal, retryAuthentication: false, body: JSON.stringify(body) });
    if (abort.signal.aborted || token !== getAccessToken() || data?.user_uuid !== original.user_uuid || data.username !== body.username || data.profile_revision !== original.profile_revision + 1 || data.sessions_revoked !== true || data.reauthentication_required !== true) throw Error('Unconfirmed username result');
    clearAccessToken();
    return data;
  } catch (error) {
    if (!submitted) throw Error('Your account or session could not be verified. Refresh before saving.');
    if (error instanceof ApiError && (error.status === 400 || error.status === 409 || error.status === 403 && (error.payload as { error?: { code?: string } })?.error?.code === 'CURRENT_PASSWORD_INVALID')) {
      throw Error(error.status === 403 ? 'Current local password could not be verified.' : error.status === 409 ? 'The username is unavailable or your profile changed. Refresh before saving.' : 'Check the username, password and sign-out acknowledgment.');
    }
    if (token === getAccessToken()) clearAccessToken();
    throw Error('Username change could not be confirmed. Sign in again, trying the new username first. No request was replayed.');
  } finally { clearTimeout(timer); saving.delete(original.user_uuid); }
}
