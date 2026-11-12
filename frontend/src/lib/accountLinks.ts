import {requestJson, ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type AccountLinkSelection = Readonly<{
  actor_uuid: string;
  user_uuid: string;
  service_uuid: string;
  role_revision: string;
  link_revision: string;
  profile_revision: string;
  can_link: boolean;
  can_unlink: boolean;
}>;

// A prepared selection is memory-only and tied to the exact authenticated read.
// Once dispatched, it cannot be reused even if the response is lost.
const tokens = new WeakMap<AccountLinkSelection, string>();
const dispatched = new WeakSet<AccountLinkSelection>();
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

function parseSelection(value: AccountLinkSelection, actor: string, user: string, service: string): AccountLinkSelection {
  if (!value || value.actor_uuid !== actor || value.user_uuid !== user || value.service_uuid !== service ||
    !revision(value.role_revision) || !revision(value.link_revision) || !revision(value.profile_revision) ||
    typeof value.can_link !== 'boolean' || typeof value.can_unlink !== 'boolean' || value.can_link && value.can_unlink) {
    throw Error('Account link selection is unavailable. Refresh.');
  }
  return Object.freeze({actor_uuid: actor, user_uuid: user, service_uuid: service,
    role_revision: value.role_revision, link_revision: value.link_revision, profile_revision: value.profile_revision,
    can_link: value.can_link, can_unlink: value.can_unlink});
}

export class AccountLinkWriteError extends Error {
  constructor(public uncertain: boolean) {
    super(uncertain ? 'The link outcome is unknown. Read current ownership before making another decision.' : 'The link change was rejected. Refresh the selection.');
  }
}

export async function prepareAccountLink(actor: string, user: string, service: string): Promise<AccountLinkSelection> {
  const token = getAccessToken();
  if (!token || !uuid(actor) || !uuid(user) || !uuid(service)) throw Error('Invalid account link selection.');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  try {
    const {data} = await requestJson<{data: AccountLinkSelection}>(`/api/account-links/${user}/${service}`, {signal: abort.signal, retryAuthentication: false});
    if (abort.signal.aborted || token !== getAccessToken()) throw Error('The session changed. Refresh.');
    const selection = parseSelection(data, actor, user, service);
    tokens.set(selection, token);
    return selection;
  } finally { clearTimeout(timer); }
}

export async function changeAccountLink(selection: AccountLinkSelection, action: 'link' | 'unlink'): Promise<AccountLinkSelection> {
  const token = tokens.get(selection);
  if (!token || token !== getAccessToken() || dispatched.has(selection) ||
    action !== 'link' && action !== 'unlink' || !(action === 'link' ? selection.can_link : selection.can_unlink)) {
    throw Error('Prepare a current authorized account link selection.');
  }
  dispatched.add(selection);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  try {
    const {data} = await requestJson<{data: AccountLinkSelection}>(`/api/account-links/${selection.user_uuid}/${selection.service_uuid}`, {
      method: action === 'link' ? 'PUT' : 'DELETE', signal: abort.signal, retryAuthentication: false,
      body: JSON.stringify({expected_actor_uuid: selection.actor_uuid, expected_user_uuid: selection.user_uuid,
        expected_service_uuid: selection.service_uuid, role_revision: selection.role_revision,
        link_revision: selection.link_revision, profile_revision: selection.profile_revision}),
    });
    if (abort.signal.aborted || token !== getAccessToken()) throw Error('Session changed after dispatch.');
    const result = parseSelection(data, selection.actor_uuid, selection.user_uuid, selection.service_uuid);
    if (BigInt(result.link_revision) <= BigInt(selection.link_revision) || result.can_unlink !== (action === 'link') || result.can_link && action === 'link') throw Error('Invalid committed link response.');
    // The response is a result, not a new prepared mutation selection.
    return result;
  } catch (error) {
    throw new AccountLinkWriteError(!(error instanceof ApiError && [400,401,403,404,405,409,422].includes(error.status)));
  } finally { clearTimeout(timer); }
}
