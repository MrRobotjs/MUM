export type AuthStatus = 'bootstrapping' | 'authenticated' | 'anonymous';
export type AuthSnapshot = { status: AuthStatus; accessToken: string | null; generation: number; credentialRevision: number };
let accessToken: string | null = null;
let bootstrapped = false;
let authRevision = 0;
let generation = 0;
// The account the current sign-in (generation) was confirmed to belong to,
// recorded from its first session read. A renewal that answers for another
// account, or names none, is a replacement rather than a routine renewal.
let principal: { generation: number; uuid: string } | null = null;
let bootstrapPromise: Promise<void> | null = null;
let refreshPromise: Promise<string | null> | null = null;
const listeners = new Set<() => void>();
let snapshot: AuthSnapshot = { status: 'bootstrapping', accessToken: null, generation, credentialRevision: authRevision };
const update = (status: AuthStatus) => {
  if (snapshot.status === status && snapshot.accessToken === accessToken && snapshot.generation === generation && snapshot.credentialRevision === authRevision) return;
  snapshot = { status, accessToken, generation, credentialRevision: authRevision };
  listeners.forEach(listener => listener());
};
export const getAuthSnapshot = () => snapshot;
export const subscribeToAuthStore = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getAccessToken = () => accessToken;
/** Record which account the given sign-in was confirmed to belong to. */
export const notePrincipal = (forGeneration: number, uuid: string) => {
  if (forGeneration === generation && uuid) principal = { generation: forGeneration, uuid };
};

export const setAccessToken = (token: string | null) => {
  authRevision++;
  generation++;
  principal = null;
  accessToken = token || null;
  update(accessToken ? 'authenticated' : 'anonymous');
};
export const clearAccessToken = () => setAccessToken(null);

// All callers share one rotation request; simultaneous 401s cannot replay a refresh cookie.
export const refreshAccessToken = (): Promise<string | null> => {
  if (refreshPromise) return refreshPromise;
  const revision = authRevision;
  refreshPromise = (async () => {
    try {
      const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { Accept: 'application/json' } });
      if (revision !== authRevision) return getAccessToken();
      if (!response.ok) { clearAccessToken(); return null; }
      const json = await response.json();
      if (revision !== authRevision) return getAccessToken();
      const token = typeof json?.data?.access_token === 'string' ? json.data.access_token : null;
      const renewedFor = typeof json?.data?.user?.uuid === 'string' ? json.data.user.uuid : null;
      // The cookie may belong to another account after a login in another tab.
      // Every accepted credential revision invalidates cached authority. Once a
      // sign-in has been confirmed for an account, a renewal for a different
      // (or unnamed) account replaces the sign-in, so nothing confirmed for the
      // previous account can be shown. Before confirmation nothing is shown
      // across a renewal anyway (useSession records its account first).
      authRevision++;
      accessToken = token;
      if (!token || (principal?.generation === generation && renewedFor !== principal.uuid)) {
        generation++;
        principal = null;
      }
      update(token ? 'authenticated' : 'anonymous');
      return token;
    } catch { if (revision === authRevision) clearAccessToken(); return null; }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
};

export const bootstrapAuth = async (options?: { force?: boolean }) => {
  if (accessToken) { bootstrapped = true; update('authenticated'); return; }
  if (bootstrapped && !options?.force) { update('anonymous'); return; }
  if (bootstrapPromise) return bootstrapPromise;
  update('bootstrapping');
  bootstrapPromise = (async () => {
    await refreshAccessToken();
    bootstrapped = true;
    update(accessToken ? 'authenticated' : 'anonymous');
  })().finally(() => { bootstrapPromise = null; });
  return bootstrapPromise;
};



