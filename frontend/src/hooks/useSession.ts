import { useEffect, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { ApiError, requestJson } from '../util/apiClient';
import { bootstrapAuth, getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';

export const useSession = () => {
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const sessionKey = auth.status === 'authenticated' ? '/admin/api/v2/auth/session' : null;

  const { data, error, isLoading, mutate } = useSWR(
    sessionKey,
    sessionKey ? (url: string) => requestJson(url) : null,
    {
      revalidateOnFocus: false,
    }
  );

  useEffect(() => {
    void bootstrapAuth();
  }, []);

  useEffect(() => {
    if (auth.status !== 'authenticated') {
      mutate(null, false); // Clear cache without revalidation
    }
  }, [auth.status, mutate]);

  // No CSRF handling under JWT

  return {
    session: data?.data ?? null,
    loading: isLoading || auth.status === 'bootstrapping',
    error: error as ApiError | undefined,
    refresh: mutate
  };
};
