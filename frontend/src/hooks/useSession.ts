import { useEffect, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import type { AuthSnapshot } from '../store/authStore';
import type { SessionData } from '../contexts/AuthContext';
import { ApiError, requestJson } from '../util/apiClient';
import { bootstrapAuth, clearAccessToken, getAuthSnapshot, notePrincipal, refreshAccessToken, subscribeToAuthStore } from '../store/authStore';

const assertCurrent = (generation: number, credentialRevision?: number) => {
  const current = getAuthSnapshot();
  if (current.status !== 'authenticated' || current.generation !== generation || (credentialRevision !== undefined && current.credentialRevision !== credentialRevision)) {
    throw new Error('Authentication session changed during session read');
  }
};

/** Read current authority before navigating after login. Rejects account switches
 * and logout while pending; one credential rotation is allowed on a read 401.
 * Call after setAccessToken; never use a previous session as a fallback.
 * onValidated receives the exact final-read credential checkpoint synchronously;
 * consumers that await this function must compare it again before using authority. */
export const readFreshSession = async (onValidated?: (auth: AuthSnapshot) => void): Promise<SessionData> => {
  const { generation, accessToken, status } = getAuthSnapshot();
  if (status !== 'authenticated') throw new ApiError('Authentication required', 401);
  let credentialRevision = getAuthSnapshot().credentialRevision;
  for (let attempt = 0; attempt < 2; attempt++) {
    assertCurrent(generation, credentialRevision);
    try {
      const result = await requestJson<{ data: SessionData }>('/api/auth/session', { retryAuthentication: false });
      assertCurrent(generation, credentialRevision);
      // Publish the exact revision whose authority was read, before yielding.
      onValidated?.(getAuthSnapshot());
      return result.data;
    } catch (error) {
      assertCurrent(generation, credentialRevision);
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      if (attempt === 1) { clearAccessToken(); throw error; }
      // A concurrent rotation may already have replaced the rejected token.
      if (getAuthSnapshot().accessToken === accessToken) await refreshAccessToken();
      const current = getAuthSnapshot();
      if (current.generation !== generation || current.status !== 'authenticated') {
        if (current.status === 'anonymous') throw error;
        assertCurrent(generation);
      }
      credentialRevision = current.credentialRevision;
    }
  }
  throw new ApiError('Authentication required', 401);
};

// The last session confirmed for a sign-in (generation). A routine token
// renewal keeps the same generation, so this stays on screen while the new
// credential's session is read; a different sign-in never sees it.
let confirmed: { generation: number; session: SessionData } | null = null;

export const useSession = () => {
  const auth = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const sessionKey = auth.status === 'authenticated' ? ['/api/auth/session', auth.generation, auth.credentialRevision] as const : null;
  const { data, error, isLoading, mutate } = useSWR(
    sessionKey,
    sessionKey ? async ([, generation, credentialRevision]: readonly [string, number, number]) => {
      assertCurrent(generation, credentialRevision);
      const session = await readFreshSession();
      assertCurrent(generation, credentialRevision);
      if (session?.user?.uuid) notePrincipal(generation, session.user.uuid);
      return { generation, credentialRevision, session };
    } : null,
    {
      keepPreviousData: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      refreshInterval: 60000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      shouldRetryOnError: false,
    }
  );
  useEffect(() => { void bootstrapAuth(); }, []);
  const current = auth.status === 'authenticated' && data?.generation === auth.generation && data?.credentialRevision === auth.credentialRevision;
  // Only a session that names its account can be carried across a renewal,
  // and its account is recorded with it: the renewal rule compares that
  // account, so continuity never exists without it.
  if (current && !error && data.session?.user?.uuid) {
    notePrincipal(data.generation, data.session.user.uuid);
    confirmed = { generation: data.generation, session: data.session };
  }
  const continuing = !current && !error && auth.status === 'authenticated' && confirmed?.generation === auth.generation;
  return {
    session: current && !error ? data.session : continuing ? confirmed!.session : null,
    loading: auth.status === 'bootstrapping' || (auth.status === 'authenticated' && !error && (isLoading || !current) && !continuing),
    error: auth.status === 'authenticated' ? error as ApiError | undefined : undefined,
    refresh: mutate,
  };
};

