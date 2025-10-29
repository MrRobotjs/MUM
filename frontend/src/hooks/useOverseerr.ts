import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export const useOverseerr = (uuid?: string) => {
  const shouldFetch = Boolean(uuid);
  const { data, error, isLoading, mutate } = useSWR(
    shouldFetch ? `/admin/api/v2/users/${uuid}/overseerr` : null,
    (url: string) => requestJson(url),
    { revalidateOnFocus: false }
  );

  return {
    overseerrLinks: data?.data ?? [],
    loading: isLoading,
    error,
    refresh: mutate
  };
};
