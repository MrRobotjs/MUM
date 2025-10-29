import { useEffect } from 'react';
import useSWR from 'swr';
import { ApiError, requestJson, setCsrfToken } from '../util/apiClient';

export const useSession = () => {
  const { data, error, isLoading, mutate } = useSWR('/admin/api/v2/auth/session', (url: string) => requestJson(url), {
    revalidateOnFocus: false
  });

  useEffect(() => {
    if (error) {
      setCsrfToken(null);
      console.warn('Session bootstrap failed', error);
    }
  }, [error]);

  useEffect(() => {
    if (data && typeof data === 'object' && 'data' in data) {
      try {
        const payload = data as {
          data?: { csrf_token?: string | null };
        };
        setCsrfToken(payload.data?.csrf_token ?? null);
      } catch (err) {
        console.warn('Failed to update CSRF token from session payload', err);
      }
    }
  }, [data]);

  return {
    session: data?.data ?? null,
    loading: isLoading,
    error: error as ApiError | undefined,
    refresh: mutate
  };
};
