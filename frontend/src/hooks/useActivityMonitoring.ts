import {useEffect, useSyncExternalStore} from 'react';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {getAccessToken, getAuthSnapshot, subscribeToAuthStore} from '../store/authStore';
import {fetchActivityMonitoring, MONITORING_EVENT} from '../lib/activityMonitoring';

export function useActivityMonitoring() {
  const {user, isAdministrator} = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot);
  const actor = isAdministrator && session.accessToken ? user?.uuid : undefined;
  const state = useSWR(actor ? ['/api/settings/activity-monitoring', actor] : null, async ([, identity]: [string, string]) => {
    const token = getAccessToken();
    const snapshot = await fetchActivityMonitoring(identity);
    return {snapshot, token};
  }, {refreshInterval: 5000, keepPreviousData: false});
  useEffect(() => {
    if (actor) void state.mutate().catch(() => {});
  }, [actor, session.accessToken, state.mutate]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{actor_uuid: string}>).detail?.actor_uuid === actor) void state.mutate().catch(() => {});
    };
    window.addEventListener(MONITORING_EVENT, changed);
    return () => window.removeEventListener(MONITORING_EVENT, changed);
  }, [actor, state.mutate]);
  const snapshot = !state.error && state.data && state.data.snapshot.actor_uuid === actor && state.data.token === session.accessToken ? state.data.snapshot : undefined;
  return {actor, snapshot, loading: state.isLoading || Boolean(actor && !state.error && !snapshot), error: state.error,
    refresh: state.mutate, sessionToken: session.accessToken};
}
