import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export const useOverseerr = (uuid?: string, enabled=true) => {
  const shouldFetch = Boolean(uuid)&&enabled;
  const { data, error, isLoading, mutate } = useSWR(
    shouldFetch ? `/api/users/${uuid}/overseerr` : null,
    (url: string) => requestJson<{ data: any }>(url),
    { revalidateOnFocus: false }
  );

  return {
    overseerrLinks: data?.data ?? [],
    loading: isLoading,
    error,
    refresh: mutate
  };
};
