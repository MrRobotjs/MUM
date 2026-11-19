import { requestJson } from '../util/apiClient';
import { formatDisplayTimestamp, type DisplayValues } from './accountDisplay';
import { runEditOperation, type EditOperationsClient, type EditReceipt, type PurgeRule } from './editOperations';

// The purge: inactive Plex accounts listed by the server and
// removed through one prepared delete edit carrying the rule. The server checks
// each account against the rule again just before Plex is asked, and removes
// the MUM record only after Plex confirms. Only the owner may purge.

export type PurgeCandidate = {
  uuid: string;
  username: string;
  email: string | null;
  server_id: number;
  server_name: string;
  created_at: string;
  last_streamed_at: string | null;
  // Where the last play was recorded: by MUM, or in the imported Plex history.
  last_play_source: 'mum' | 'plex_history' | null;
  days_since_activity: number;
  is_sharer: boolean;
  is_whitelisted: boolean;
};

const validRule = (rule: PurgeRule) => Number.isInteger(rule.inactive_days) && rule.inactive_days >= 1 && rule.inactive_days <= 36500;

function candidate(value: unknown, seen: Set<string>): PurgeCandidate {
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => typeof x === 'string';
  const source = v?.last_play_source;
  if (!v || !text(v.uuid) || !v.uuid || seen.has(v.uuid as string) || !text(v.username) || !(v.email === null || text(v.email)) || !Number.isInteger(v.server_id) ||
      !text(v.server_name) || v.service_type !== 'plex' || !text(v.created_at) || !(source === null || source === 'mum' || source === 'plex_history') ||
      (source === null) !== (v.last_streamed_at === null) || !(v.last_streamed_at === null || text(v.last_streamed_at)) ||
      !Number.isInteger(v.days_since_activity) || typeof v.is_sharer !== 'boolean' || typeof v.is_whitelisted !== 'boolean') throw new Error('Invalid purge candidate');
  seen.add(v.uuid as string);
  return { uuid: v.uuid as string, username: v.username as string, email: v.email as string | null, server_id: v.server_id as number, server_name: v.server_name as string,
    created_at: v.created_at as string, last_streamed_at: v.last_streamed_at as string | null, last_play_source: source as PurgeCandidate['last_play_source'],
    days_since_activity: v.days_since_activity as number, is_sharer: v.is_sharer as boolean, is_whitelisted: v.is_whitelisted as boolean };
}

export async function readPurgeCandidates(rule: PurgeRule): Promise<PurgeCandidate[]> {
  if (!validRule(rule)) throw new Error('Inactive for must be a whole number of days from 1 to 36500');
  const query = new URLSearchParams({ inactive_days: String(rule.inactive_days), exclude_sharers: String(rule.exclude_sharers),
    exclude_whitelisted: String(rule.exclude_whitelisted), ignore_creation_date: String(rule.ignore_creation_date) });
  const { data } = await requestJson<{ data?: { users?: unknown } }>(`/api/users/eligible-for-purge?${query}`);
  if (!Array.isArray(data?.users)) throw new Error('Invalid purge candidates');
  const seen = new Set<string>();
  return data.users.map(user => candidate(user, seen));
}

// "Last played Mar 12, 2026 (Plex history)", the day in the account's
// timezone, or "Never played".
export function lastPlayLabel(user: PurgeCandidate, settings: DisplayValues | undefined): string {
  if (!user.last_streamed_at) return 'Never played';
  return `Last played ${formatDisplayTimestamp(user.last_streamed_at, settings, 'date')} (${user.last_play_source === 'plex_history' ? 'Plex history' : 'MUM'})`;
}

// Removes the chosen accounts: one prepare and one run, never resent.
export async function purgeUsers(client: EditOperationsClient, ids: string[], rule: PurgeRule): Promise<EditReceipt> {
  if (!ids.length || !validRule(rule)) throw new Error('Choose at least one user to purge');
  return runEditOperation(client, ids, { action: 'delete_users', purge: rule });
}
