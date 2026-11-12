import { requestJson } from '../util/apiClient';

// User sync requests return once the sync has finished, with its results.

export type UserSyncCounts = { added: number; updated: number; removed: number };
export type UserSyncResult = Partial<UserSyncCounts> & {
  server_id: number;
  server_name: string;
  service_type: string;
  success: boolean;
  message?: string;
};
export type UserSyncSummary = {
  total_servers: number;
  successful: number;
  failed: number;
  total_added: number;
  total_updated: number;
  total_removed: number;
};
export type UserSyncNotice = { ok: boolean; text: string };

export async function syncAllUsers(): Promise<{ results: UserSyncResult[]; summary: UserSyncSummary }> {
  const response = await requestJson<{ data: { results: UserSyncResult[]; summary: UserSyncSummary } }>('/api/users/sync-all', { method: 'POST' });
  return response.data;
}

export async function syncServerUsers(serverId: number): Promise<UserSyncCounts> {
  const response = await requestJson<{ data: UserSyncCounts }>(`/api/servers/${serverId}/sync-users`, { method: 'POST' });
  return response.data;
}

// "no changes needed" when the sync found nothing to change.
export function userSyncChanges({ added, updated, removed }: UserSyncCounts): string {
  if (added === 0 && updated === 0 && removed === 0) return 'no changes needed';
  return `${added} added, ${updated} updated, ${removed} removed`;
}

export function userSyncNotices(results: UserSyncResult[], summary: UserSyncSummary): UserSyncNotice[] {
  const servers = `${summary.total_servers} server${summary.total_servers !== 1 ? 's' : ''}`;
  const changes = userSyncChanges({ added: summary.total_added, updated: summary.total_updated, removed: summary.total_removed });
  if (summary.failed === 0) return [{ ok: true, text: `Synced ${servers}: ${changes}` }];
  return [
    { ok: false, text: `Sync completed with errors: ${summary.successful}/${summary.total_servers} servers successful (${changes})` },
    ...results.filter((result) => !result.success).map((result) => ({ ok: false, text: `Sync failed for ${result.server_name || 'Server'}: ${result.message ?? 'Unknown error'}` })),
  ];
}
