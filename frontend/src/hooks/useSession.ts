import { useEffect } from 'react';
import useSWR from 'swr';
import { ApiError, requestJson } from '../util/apiClient';

export const useSession = () => {
  const { data, error, isLoading, mutate } = useSWR('/admin/api/v2/auth/session', (url: string) => requestJson(url), {
    revalidateOnFocus: false
  });

  useEffect(() => {
    if (error) {
      console.warn('Session bootstrap failed', error);
    }
  }, [error]);

  // No CSRF handling under JWT

  return {
    session: data?.data ?? null,
    loading: isLoading,
    error: error as ApiError | undefined,
    refresh: mutate
  };
};
