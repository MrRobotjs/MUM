import useSWR from 'swr';
import { ApiError, requestJson } from '../util/apiClient';

const ADMIN_PREFIX = '/admin/api/v2';

export function useAdminApi<T = unknown>(path: string, enabled = true) {
  const endpoint = `${ADMIN_PREFIX}${path}`;
  const { data, error, isLoading, mutate } = useSWR(endpoint, requestJson, {
    revalidateOnFocus: false,
    shouldRetryOnError: enabled
  });

  return {
    data: (data as T) ?? null,
    error: error ? (error as ApiError).message : null,
    loading: isLoading,
    mutate
  };
}
