import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type UserTotalResponse = { meta?: { pagination?: { total_items?: number } } };

// Every user-total request starts with this, so a sync can refresh them all.
export const USER_TOTAL_KEY_PREFIX = '/api/users?page=1&page_size=1';

/**
 * How many users a users page lists, for the sidebar count badges: all users
 * (the Users page with no filters) or one server's service accounts (that
 * server's Users page). Reads one row and the reported total.
 */
export const useUserTotal = ({ serverId, enabled = true }: { serverId?: number; enabled?: boolean } = {}) => {
  const filter = serverId ? `&server_id=${serverId}&user_type=service` : '';
  const { data } = useSWR<UserTotalResponse>(
    enabled ? `${USER_TOTAL_KEY_PREFIX}${filter}` : null,
    (url: string) => requestJson<UserTotalResponse>(url)
  );
  const total = data?.meta?.pagination?.total_items;
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null;
};
