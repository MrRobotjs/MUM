import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export const useAvailableServiceAccounts = (uuid?: string, enabled = true) => {
  const shouldFetch = Boolean(uuid) && enabled;
  const { data, error, isLoading, mutate } = useSWR(
    shouldFetch ? `/api/v2/users/${uuid}/available-service-accounts` : null,
    (url: string) => requestJson(url),
    { revalidateOnFocus: false }
  );

  return {
    accounts: data?.data ?? [],
    loading: isLoading,
    error,
    refresh: mutate
  };
};
