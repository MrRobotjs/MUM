import useSWR from 'swr';
import { requestJson } from '@/util/apiClient';
import type { ActiveSessionsResponse } from '@/types/streaming';

export const useActiveStreamingSessions = () => {
  const { data, error, isLoading, mutate } = useSWR<ActiveSessionsResponse>(
    '/api/v2/streaming/active',
    (url: string) => requestJson<ActiveSessionsResponse>(url),
    {
      revalidateOnFocus: false,
      refreshInterval: 45_000,
    },
  );

  return {
    sessions: data?.sessions ?? [],
    totalCount: data?.total_count ?? 0,
    byServer: data?.by_server ?? {},
    byService: data?.by_service ?? {},
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
