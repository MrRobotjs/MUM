import { invitationServerLimits } from './invitationConstraints';
import { requestJson } from '../util/apiClient';
import { invitationExpiryTimestamp } from '../util/calendarDates';
import type { InviteRow } from '../components/invites/InvitesTable';
import type { InviteFormValues } from '../components/invites/InviteModal';

export const INVITATIONS_CACHE_KEY = '/api/invitations';
export type InvitationGrant = { server_id: number; all_libraries: boolean; library_ids: string[]; allow_downloads: boolean };
// Null expiry = never expires, null max_uses = unlimited, null membership = permanent (Flask behaviour).
export type InvitationRecord = { id: number; revision: number; created_at: string; expires_at: string | null; max_uses: number | null; current_uses: number; reserved_uses: number; is_active: boolean; grants: InvitationGrant[]; require_discord_auth?: boolean; require_discord_guild_membership?: boolean; custom_path?: string | null; membership_duration_days?: number | null; token_prefix?: string; archived_at?: string | null };
export type InvitationServer = { id: number; server_nickname: string; service_type: string; is_active: boolean; provider_enabled: boolean; effective_active: boolean; public_url?: string };
type Library = { id: number; server_id: number; external_id: string; name: string; library_type: string };
export type RecentInvitationUsage = { id: string; plex_username?: string; discord_username?: string; accepted_invite: boolean; used_at: string | null; status_message?: string };
export type InvitationCatalog ={ records: InvitationRecord[]; servers: InvitationServer[]; libraries: Library[] };
type CursorResponse<T> = { data: T[]; meta: { next_before: number | null } };
type Job = { plex_progress?: { phase: string }; id: string; invite_id: number; status: string; user_uuid: string; error_code: string; created_at: string; updated_at: string };

async function cursorRecords<T>(path: string): Promise<T[]> {
  const records: T[] = [];
  let before: number | null = null;
  const cursors = new Set<number>();
  do {
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    if (before !== null) query.set('before', String(before));
    const suffix = query.size ? `?${query}` : '';
    const response = await requestJson<CursorResponse<T>>(`${path.split('?')[0]}${suffix}`);
    if (!Array.isArray(response.data) || !response.meta || !('next_before' in response.meta)) throw new Error('Invalid invitation pagination');
    records.push(...response.data);
    if (records.length > 10000) throw new Error('More than 10,000 invitation records; narrow the operation before continuing');
    const next = response.meta.next_before;
    if (next !== null && (!Number.isSafeInteger(next) || next < 1 || cursors.has(next) || before !== null && next >= before)) throw new Error('Invalid invitation cursor');
    before = next;
    if (before !== null) cursors.add(before);
  } while (before !== null);
  return records;
}

export async function fetchInvitationCatalog(): Promise<InvitationCatalog> {
  const [records, servers, libraries] = await Promise.all([
    // Archived (deleted) invitations are included and shown only under the Archived filter.
    cursorRecords<InvitationRecord>('/api/invitations?include_archived=1'),
    requestJson<{ data: InvitationServer[] }>('/api/servers'),
    requestJson<{ data: Library[] }>('/api/libraries'),
  ]);
  if (!Array.isArray(servers.data) || !Array.isArray(libraries.data)) throw new Error('Invalid server or library catalog');
  return { records, servers: servers.data, libraries: libraries.data };
}

export function invitationRow(record: InvitationRecord, catalog: InvitationCatalog): InviteRow {
  const servers = record.grants.map(g => {
    const server = catalog.servers.find(s => s.id === g.server_id);
    return { id: g.server_id, server_nickname: server?.server_nickname ?? `Server #${g.server_id}`, service_type: server?.service_type ?? '',
      is_active: server?.is_active ?? false, plugin_enabled: server?.provider_enabled ?? false, effective_active: server?.effective_active ?? false };
  });
  const selected = catalog.libraries.filter(l => record.grants.some(g => g.server_id === l.server_id && (g.all_libraries || g.library_ids.includes(l.external_id))));
  const expired = record.expires_at !== null && Date.parse(record.expires_at) <= Date.now();
  const maxed = record.max_uses !== null && record.current_uses + record.reserved_uses >= record.max_uses;
  const paused = servers.some(s => !s.effective_active);
  const archived = Boolean(record.archived_at);
  const usable = !archived && record.is_active && !expired && !maxed && !paused;
  // The card shows the custom path, else the code's first 12 characters, as in Flask.
  return { id: record.id, revision: record.revision, token: record.token_prefix || `Invitation #${record.id}`, custom_path: record.custom_path ?? undefined,
    membership_duration_days: record.membership_duration_days ?? undefined, is_archived: archived, archived_at: record.archived_at ?? null, created_at: record.created_at,
    expires_at: record.expires_at, max_uses: record.max_uses, current_uses: record.current_uses, reserved_uses: record.reserved_uses,
    is_active: record.is_active, is_expired: expired, has_reached_max_uses: maxed, is_usable: usable, is_effectively_usable: usable,
    is_paused: paused, effective_server_count: servers.filter(s => s.effective_active).length, disabled_server_count: servers.filter(s => !s.effective_active).length,
    servers, disabled_servers: servers.filter(s => !s.effective_active), grants_all_libraries: record.grants.every(g => g.all_libraries),
    all_library_server_ids: record.grants.filter(g => g.all_libraries).map(g => g.server_id),
    grant_library_ids: selected.map(l => `${l.server_id}::${l.external_id}`),
    libraries: selected.map(l => ({ server_id: l.server_id, id: `${l.server_id}::${l.external_id}`, name: l.name, server_name: servers.find(s => s.id === l.server_id)?.server_nickname ?? '', service_type: servers.find(s => s.id === l.server_id)?.service_type ?? '' })),
    allow_downloads: record.grants.some(g => g.allow_downloads), allow_4k_transcode: true,
    server_features: record.grants.map(g => ({ server_id: g.server_id, allow_downloads: g.allow_downloads })),
    require_discord_auth: record.require_discord_auth === true, require_discord_guild_membership: record.require_discord_guild_membership === true,
  };
}

export function filterInvitations(catalog: InvitationCatalog, filters: { status?: string; search?: string; serverId?: number; page?: number; pageSize?: number } = {}) {
  const rows = catalog.records.map(r => invitationRow(r, catalog));
  const search = filters.search?.toLowerCase().trim();
  // Archived invitations appear only under the Archived filter.
  const filtered = rows.filter(r => (filters.status === 'archived') === Boolean(r.is_archived)).filter(r => (!search || `${r.token} ${r.custom_path ?? ''} ${r.servers?.map(s => s.server_nickname).join(' ')}`.toLowerCase().includes(search)) &&
    (!filters.serverId || r.servers?.some(s => s.id === filters.serverId)) &&
    (!filters.status || filters.status === 'all' || filters.status === 'archived' || ({ usable: r.is_usable, paused: r.is_paused, active: r.is_active, inactive: !r.is_active, expired: r.is_expired, maxed: r.has_reached_max_uses } as Record<string, boolean | undefined>)[filters.status]));
  const size = Math.max(1, Math.min(100, filters.pageSize ?? 25));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.max(1, Math.min(pages, filters.page ?? 1));
  return { invites: filtered.slice((page - 1) * size, page * size), pagination: { page, page_size: size, total_pages: pages, total_items: filtered.length } };
}

export function invitationSummary(catalog: InvitationCatalog) {
  const rows = catalog.records.filter(r => !r.archived_at).map(r => invitationRow(r, catalog));
  return { counts: { total: rows.length, active: rows.filter(r => r.is_active).length, inactive: rows.filter(r => !r.is_active).length,
    expired: rows.filter(r => r.is_expired).length, maxed: rows.filter(r => r.has_reached_max_uses).length,
    usable: rows.filter(r => r.is_usable).length, paused: rows.filter(r => r.is_paused).length }, recent_invites: rows.slice(0, 5),
    // The catalogue carries no usage history, so recent usage is unavailable rather than empty.
    recent_usages: null as RecentInvitationUsage[] | null };
}

// Whole days from now until a chosen membership end date (Flask: at least 1).
export function membershipDaysUntil(date: string | null | undefined): number | null {
  if (!date?.trim()) return null;
  const end = new Date(`${date}T00:00:00`).getTime();
  if (!Number.isFinite(end)) throw new Error('Choose a valid membership expiration date');
  return Math.max(1, Math.ceil((end - Date.now()) / 86400000));
}

// The date shown when editing: today plus the saved duration, so saving
// unchanged keeps the same number of days.
export function membershipDateFromDays(days: number | null | undefined): string | null {
  if (!days) return null;
  const date = new Date(Date.now() + days * 86400000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function invitationPayload(values: InviteFormValues, servers: { id: number; service_type: string }[] = []) {
  if (values.grant_purge_whitelist || values.grant_bot_whitelist || values.invite_to_plex_home || values.allow_live_tv || values.server_features?.some(f => f.invite_to_plex_home || f.allow_live_tv)) throw new Error('Plex Home, Live TV and protection grants are not available yet');
  const require_discord_guild_membership = values.require_discord_guild_membership === true;
  const require_discord_auth = values.require_discord_auth === true || require_discord_guild_membership;
  // Blank or 0 = unlimited uses; blank expiry = never expires (Flask behaviour).
  const rawUses = values.max_uses as number | string | null | undefined;
  const maxUses = rawUses === null || rawUses === undefined || rawUses === '' || Number(rawUses) === 0 ? null : Number(rawUses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) throw new Error('Maximum uses must be a whole number (0 or blank for unlimited)');
  let expiresAt: string | null = null;
  if (values.expires_at) {
    expiresAt = invitationExpiryTimestamp(values.expires_at, values.original_expires_at);
    const expires = new Date(expiresAt);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw new Error('Choose a future expiration');
  }
  const customPath = values.custom_path?.trim() || null;
  if (customPath && (!/^[A-Za-z0-9_-]{3,100}$/.test(customPath) || customPath.length === 43)) throw new Error('Custom paths use 3–100 letters, numbers, - or _');
  const membershipDays = values.membership_expires_at ? membershipDaysUntil(values.membership_expires_at) : null;
  if (membershipDays !== null && membershipDays > 36500) throw new Error('Membership expiration must be within 100 years');
  const serverIDs = values.server_ids ?? [];
  if (!serverIDs.length || new Set(serverIDs).size !== serverIDs.length) throw new Error('Choose unique invited servers');
  const grants = serverIDs.map(server_id => {
    const all_libraries = values.all_library_server_ids?.includes(server_id) ?? false;
    const prefix = `${server_id}::`;
    const library_ids = all_libraries ? [] : (values.grant_library_ids ?? []).filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length));
    if (!all_libraries && !library_ids.length) throw new Error(`Choose at least one library for server #${server_id}`);
    const server = servers.find(server => server.id === server_id);
    if (server && !invitationServerLimits(server.service_type).allLibraries && (all_libraries || library_ids.some(id => !/^[1-9]\d*$/.test(id) || Number(id) > 2147483647))) throw new Error('Kavita requires selected libraries with valid IDs; future libraries are not included');
    const allow_downloads = values.server_features?.find(f => f.server_id === server_id)?.allow_downloads ?? values.allow_downloads ?? false;
    if (server?.service_type.toLowerCase() === 'romm' && (!all_libraries || library_ids.length || !allow_downloads)) throw new Error('RomM requires explicit all-platform access including downloads');
    return { server_id, all_libraries, library_ids, allow_downloads };
  });
  return { expires_at: expiresAt, max_uses: maxUses, is_active: values.is_active ?? true, grants, require_discord_auth, require_discord_guild_membership, custom_path: customPath, membership_duration_days: membershipDays };
}

export async function saveInvitation(values: InviteFormValues, existing?: { id: number; revision: number }) {
  const { custom_path, ...editable } = invitationPayload(values);
  // The custom path is chosen at creation only, as in Flask.
  return requestJson<{ data: { id: number; revision: number; token?: string } }>(existing ? `/api/invitations/${existing.id}` : '/api/invitations', {
    method: existing ? 'PATCH' : 'POST', retryAuthentication: false, body: JSON.stringify(existing ? { ...editable, revision: existing.revision } : { ...editable, custom_path }),
  });
}

export async function invitationShareURL(id: number): Promise<string> {
  const response = await requestJson<{ data: { id: number; token: string; path: string } }>(`/api/invitations/${id}/share-link`);
  const { token, path } = response.data;
  const custom = path.startsWith('/invite/') ? path.slice('/invite/'.length) : '';
  if (response.data.id !== id || !/^[A-Za-z0-9_-]{43}$/.test(token) || (custom !== token && !/^[A-Za-z0-9_-]{3,100}$/.test(custom))) throw new Error('Invalid invitation share link');
  return new URL(response.data.path, window.location.origin).href;
}

export async function openInvitation(id: number) {
  const popup = window.open('', '_blank');
  if (!popup) throw new Error('The new tab was blocked. Copy the invite link instead.');
  popup.opener = null;
  try { popup.location.replace(await invitationShareURL(id)); } catch (error) { popup.close(); throw error; }
}

// 'delete' archives (history kept); 'purge' permanently deletes archived invitations and their history.
export async function applyInvitationAction(ids: number[], action: 'enable' | 'disable' | 'delete' | 'purge') {
  return requestJson('/api/invitations/actions', { method: 'POST', body: JSON.stringify({ ids, action: action === 'delete' ? 'archive' : action }) });
}

export async function invitationDetail(id: number) {
  const [recordResponse, catalog, jobs] = await Promise.all([
    requestJson<{ data: InvitationRecord }>(`/api/invitations/${id}?include_archived=1`), fetchInvitationCatalog(), cursorRecords<Job>(`/api/provisioning-jobs?invite_id=${id}`),
  ]);
  const record = recordResponse.data;
  const row = invitationRow(record, catalog);
  const servers = record.grants.map(g => {
    const server = catalog.servers.find(s => s.id === g.server_id);
    return { ...server, id: g.server_id, service_type: server?.service_type ?? '', is_active: server?.is_active ?? false, effective_active: server?.effective_active ?? false, plugin_enabled: server?.provider_enabled ?? false,
      libraries: catalog.libraries.filter(l => l.server_id === g.server_id).map(l => ({ id: l.external_id, name: l.name, library_type: l.library_type, selected: g.all_libraries || g.library_ids.includes(l.external_id) })) };
  });
  return { ...row, is_expired: Boolean(row.is_expired), has_reached_max_uses: Boolean(row.has_reached_max_uses), is_usable: Boolean(row.is_usable), servers, disabled_servers: servers.filter(s => !s.effective_active), remaining_uses: record.max_uses === null ? null : Math.max(0, record.max_uses - record.current_uses - record.reserved_uses), library_selection_mode: row.grants_all_libraries ? 'all' as const : 'custom' as const,
    usage: jobs.map(j => ({ id: j.id, used_at: j.updated_at, accepted_invite: j.status === 'completed', status: j.status, plex_review_available: Boolean(j.plex_progress), user_uuid: j.user_uuid, status_message: j.status === 'failed' ? `Requires review: ${j.id} (${j.error_code})` : j.status, plex_auth_successful: false, discord_auth_successful: false })),
    usage_summary: { total: jobs.length, accepted: jobs.filter(j => j.status === 'completed').length, pending: jobs.filter(j => j.status === 'running' || j.status === 'pending').length, plex_auth_successful: 0, discord_auth_successful: 0, last_used_at: jobs[0]?.updated_at ?? null } };
}
