import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export const useUserSettings = (uuid?: string) => {
  const shouldFetch = Boolean(uuid);
  const { data, error, isLoading, mutate } = useSWR(
    shouldFetch ? `/admin/api/v2/users/${uuid}/settings` : null,
    (url: string) => requestJson(url),
    { revalidateOnFocus: false }
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate
  };
};
