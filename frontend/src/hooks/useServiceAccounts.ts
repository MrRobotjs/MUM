import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export const useServiceAccounts = (uuid?: string, enabled = true) => {
  const shouldFetch = Boolean(uuid) && enabled;
  const { data, error, isLoading, mutate } = useSWR(
    shouldFetch ? `/admin/api/v2/users/${uuid}/service-accounts` : null,
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
