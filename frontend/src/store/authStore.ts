export type AuthStatus = 'bootstrapping' | 'authenticated' | 'anonymous';
export type AuthSnapshot = { status: AuthStatus; accessToken: string | null };
let accessToken: string | null = null;
let bootstrapped = false;
let authRevision = 0;
let bootstrapPromise: Promise<void> | null = null;
let refreshPromise: Promise<string | null> | null = null;
const listeners = new Set<() => void>();
let snapshot: AuthSnapshot = { status: 'bootstrapping', accessToken: null };
const update = (status: AuthStatus) => {
  if (snapshot.status === status && snapshot.accessToken === accessToken) return;
  snapshot = { status, accessToken };
  listeners.forEach(listener => listener());
};
export const getAuthSnapshot = () => snapshot;
export const subscribeToAuthStore = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getAccessToken = () => accessToken;
export const setAccessToken = (token: string | null) => {
  authRevision++;
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
      setAccessToken(token);
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
