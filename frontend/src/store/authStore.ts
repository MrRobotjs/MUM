export type AuthStatus = 'bootstrapping' | 'authenticated' | 'anonymous';

export type AuthSnapshot = {
  status: AuthStatus;
  accessToken: string | null;
};

type Listener = () => void;

let accessToken: string | null = null;
let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;

const listeners = new Set<Listener>();

let snapshot: AuthSnapshot = {
  status: accessToken ? 'authenticated' : 'bootstrapping',
  accessToken,
};

const emitChange = () => {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[authStore] listener error', err);
    }
  });
};

const setSnapshot = (next: AuthSnapshot) => {
  if (snapshot.status === next.status && snapshot.accessToken === next.accessToken) return;
  snapshot = next;
  emitChange();
};

export const getAuthSnapshot = (): AuthSnapshot => snapshot;

export const subscribeToAuthStore = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getAccessToken = (): string | null => accessToken;

export const setAccessToken = (token: string | null) => {
  accessToken = token || null;
  setSnapshot({
    status: accessToken ? 'authenticated' : 'anonymous',
    accessToken,
  });
};

export const clearAccessToken = () => setAccessToken(null);

export const bootstrapAuth = async (opts?: { force?: boolean }) => {
  const force = opts?.force === true;

  if (accessToken) {
    bootstrapped = true;
    setSnapshot({ status: 'authenticated', accessToken });
    return;
  }

  if (bootstrapped && !force) {
    setSnapshot({ status: 'anonymous', accessToken: null });
    return;
  }

  if (bootstrapPromise && !force) {
    return bootstrapPromise;
  }

  setSnapshot({ status: 'bootstrapping', accessToken: null });

  bootstrapPromise = (async () => {
    try {
      const resp = await fetch('/admin/api/v2/auth/jwt/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });

      if (!resp.ok) {
        bootstrapped = true;
        setSnapshot({ status: 'anonymous', accessToken: null });
        return;
      }

      const json = await resp.json().catch(() => null);
      const newToken =
        json && typeof json === 'object' && 'data' in json
          ? ((json.data as any)?.access_token as string | undefined)
          : undefined;

      if (newToken) {
        bootstrapped = true;
        setAccessToken(newToken);
        return;
      }

      bootstrapped = true;
      setSnapshot({ status: 'anonymous', accessToken: null });
    } catch {
      bootstrapped = true;
      setSnapshot({ status: 'anonymous', accessToken: null });
    }
  })().finally(() => {
    bootstrapPromise = null;
  });

  return bootstrapPromise;
};
