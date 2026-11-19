import useSWR from 'swr';
import { ApiError, requestJson } from '../util/apiClient';

const ADMIN_PREFIX = '/api';

// refreshMs, when given, reads the data again in the background that often
// while the tab is visible; the last reply stays on screen meanwhile. While
// enabled is false nothing is read and the data shows as loading: the read
// waits for something it needs, such as the account's timezone.
export function useAdminApi<T = unknown>(path: string, enabled = true, refreshMs = 0) {
  const endpoint = `${ADMIN_PREFIX}${path}`;
  const { data, error, isLoading, mutate } = useSWR(enabled ? endpoint : null, requestJson, {
    revalidateOnFocus: false,
    shouldRetryOnError: enabled,
    refreshInterval: refreshMs,
  });

  return {
    data: (data as T) ?? null,
    error: error ? (error as ApiError).message : null,
    loading: isLoading || !enabled,
    mutate
  };
}
