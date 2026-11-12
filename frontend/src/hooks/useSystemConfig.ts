import useSWR from 'swr';
import { useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getAccessToken, getAuthSnapshot, subscribeToAuthStore } from '../store/authStore';
import { fetchRuntimeInfo } from '../lib/runtimeInfo';

export const useSystemConfig = () => {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot);
  const token = session.accessToken, actor = isAdministrator && token ? user?.uuid : undefined;
  const state = useSWR(actor ? ['/api/settings/runtime-info', actor, token] : null, async () => {
    if (token !== getAccessToken()) throw Error('Session changed. Refresh.');
    return fetchRuntimeInfo(actor!);
  }, { keepPreviousData: false, revalidateOnFocus: false, shouldRetryOnError: false });
  const config = actor && !state.error && state.data?.actor_uuid === actor ? state.data : null;
  return { config, loading: state.isLoading, error: state.error, refresh: state.mutate };
};
