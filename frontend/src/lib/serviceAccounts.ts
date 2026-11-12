import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type ProfileServiceAccount = {uuid: string; external_username: string; external_email: string; service_type: string; server_name: string};
export type ProfileAccountLinks = {actor_uuid: string; user_uuid: string; role_revision: string; link_revision: string; profile_revision: string;
  can_link: boolean; can_unlink: boolean; linked_accounts: ProfileServiceAccount[]; available_accounts: ProfileServiceAccount[]};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const revision = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

export async function fetchProfileAccountLinks(actor: string, user: string): Promise<ProfileAccountLinks> {
  const token = getAccessToken();
  if (!token || !uuid(actor) || !uuid(user)) throw Error('Invalid profile account selection.');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  try {
    const {data: p} = await requestJson<{data: ProfileAccountLinks}>(`/api/account-links/${user}/accounts`, {signal: abort.signal, retryAuthentication: false});
    if (abort.signal.aborted || token !== getAccessToken() || !p || p.actor_uuid !== actor || p.user_uuid !== user ||
      !revision(p.role_revision) || !revision(p.link_revision) || !revision(p.profile_revision) || typeof p.can_link !== 'boolean' || p.can_unlink !== true ||
      !Array.isArray(p.linked_accounts) || !Array.isArray(p.available_accounts) || p.linked_accounts.length + p.available_accounts.length > 1000 || !p.can_link && p.available_accounts.length) throw Error('Profile account links are unavailable. Refresh.');
    const seen = new Set<string>();
    const project = (accounts: ProfileServiceAccount[]) => accounts.map(a => {
      if (!a || !uuid(a.uuid) || seen.has(a.uuid) || !text(a.external_username,255) || !text(a.external_email,320) || !text(a.server_name,255) ||
        typeof a.service_type !== 'string' || !['plex','jellyfin','emby','kavita','audiobookshelf','komga','romm'].includes(a.service_type)) throw Error('Invalid service account selection.');
      seen.add(a.uuid);
      return {uuid:a.uuid,external_username:a.external_username,external_email:a.external_email,service_type:a.service_type,server_name:a.server_name};
    });
    return {actor_uuid:actor,user_uuid:user,role_revision:p.role_revision,link_revision:p.link_revision,profile_revision:p.profile_revision,
      can_link:p.can_link,can_unlink:true,linked_accounts:project(p.linked_accounts),available_accounts:project(p.available_accounts)};
  } finally { clearTimeout(timer); }
}

export type UnlinkedServiceAccount = { uuid: string; service_type: string | null; server_name: string | null; external_username: string | null; external_email: string | null; avatar_url: null };
type UserRow = { uuid: string; user_type: string; username: string; email: string; service_type: string; server_nickname: string; linked_local_user: unknown };
type UserPage = { data: UserRow[]; meta: { pagination: { page: number; page_size: number; total_items: number; total_pages: number } } };

const pageSize = 100;
const maxPages = 50;

// Reads every service account without a primary owner from the current users
// list. Pages must be complete and consistent; a directory larger than the
// bound fails instead of offering a silently truncated choice.
export async function fetchUnlinkedServiceAccounts(): Promise<UnlinkedServiceAccount[]> {
  const out: UnlinkedServiceAccount[] = [];
  const seen = new Set<string>();
  let total = -1;
  for (let page = 1; page <= maxPages; page++) {
    const response = await requestJson<UserPage>(`/api/users?user_type=service&unlinked=true&page_size=${pageSize}&page=${page}&sort=username_asc`);
    const p = response?.meta?.pagination;
    if (!Array.isArray(response?.data) || !p || p.page !== page || p.page_size !== pageSize || !Number.isSafeInteger(p.total_items) || p.total_items < 0 || total >= 0 && p.total_items !== total) throw new Error('Unlinked service accounts changed while loading. Try again.');
    total = p.total_items;
    if (total > pageSize * maxPages) throw new Error('Too many unlinked service accounts to list; filter by server first.');
    for (const row of response.data) {
      if (!row || !uuid(row.uuid) || seen.has(row.uuid) || row.user_type !== 'service' || row.linked_local_user !== null || !text(row.username, 255) || row.email !== null && !text(row.email, 320) || !text(row.service_type, 32) || !text(row.server_nickname, 255)) throw new Error('Invalid service account list');
      seen.add(row.uuid);
      out.push({ uuid: row.uuid, service_type: row.service_type || null, server_name: row.server_nickname || null, external_username: row.username || null, external_email: row.email || null, avatar_url: null });
    }
    if (out.length >= total || response.data.length < pageSize) break;
  }
  if (out.length !== total) throw new Error('Unlinked service accounts changed while loading. Try again.');
  return out;
}
