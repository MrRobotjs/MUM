const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
import { getAccessToken, setAccessToken, clearAccessToken } from './tokenStore';

export type ApiFetchOptions = {
  csrfUrl?: string;
};

export type ParsedJson<T = unknown> = {
  data?: T;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
} | T;

export class ApiError extends Error {
  status: number;
  details?: Record<string, unknown>;
  payload?: ParsedJson;

  constructor(message: string, status: number, payload?: ParsedJson) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    if (payload && typeof payload === 'object' && 'error' in payload && payload.error?.details) {
      this.details = payload.error.details;
    }
  }
}

// CSRF removed in JWT migration; no-ops retained for compatibility
const csrfToken: string | null = null;
export const setCsrfToken = (_token: string | null) => {};
export const clearCsrfToken = () => {};
export const ensureCsrfToken = async (_csrfUrl = '/admin/api/v2/auth/csrf-token') => null;

const getJson = async (response: Response): Promise<ParsedJson | null> => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const apiFetch = async (
  input: RequestInfo,
  init: RequestInit = {},
  options: ApiFetchOptions = {}
): Promise<Response> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers ?? {});

  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const body = init.body;
  if (body && !(body instanceof FormData) && !headers.has('Content-Type')) {
    if (typeof body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
  }

  // No CSRF header needed with JWT Authorization scheme
  // Attach Authorization header if we have an access token
  let token = getAccessToken();
  if (!token) {
    // Bootstrap: attempt a refresh once to obtain an access token before first request
    // Skip bootstrap refresh for login endpoint (would cause infinite loop)
    const url = typeof input === 'string' ? input : input.url;
    const isLoginEndpoint = url && (url.includes('/auth/jwt/login') || url.includes('/auth/jwt/refresh'));
    
    if (!isLoginEndpoint) {
      try {
        const refreshResp = await fetch('/admin/api/v2/auth/jwt/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (refreshResp.ok) {
          const json = await getJson(refreshResp);
          const newToken = (json && typeof json === 'object' && 'data' in json)
            ? (json.data as any)?.access_token as string | undefined
            : undefined;
          if (newToken) {
            setAccessToken(newToken);
            try { window.dispatchEvent(new CustomEvent('auth_token_updated', { detail: { accessToken: newToken } })); } catch {}
            token = newToken;
          }
        } else if (refreshResp.status === 401) {
          // Refresh failed with 401 - user is logged out, don't retry bootstrap refresh
          // This prevents repeated retry attempts after logout
        }
      } catch {
        // Silently fail bootstrap refresh - the request will proceed and handle 401 if needed
        // This prevents errors after login when refresh cookie might not be immediately available
      }
    }
  }
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      method,
      credentials: 'include',
      headers
    });
  } catch (networkErr) {
    // Network-level failure: attempt a refresh once, then retry original request
    try {
      const refreshResp = await fetch('/admin/api/v2/auth/jwt/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (refreshResp.ok) {
        const json = await getJson(refreshResp);
        const newToken = (json && typeof json === 'object' && 'data' in json)
          ? (json.data as any)?.access_token as string | undefined
          : undefined;
        if (newToken) {
          setAccessToken(newToken);
          try { window.dispatchEvent(new CustomEvent('auth_token_updated', { detail: { accessToken: newToken } })); } catch {}
          headers.set('Authorization', `Bearer ${newToken}`);
          response = await fetch(input, { ...init, method, credentials: 'include', headers });
        } else {
          throw networkErr;
        }
      } else {
        throw networkErr;
      }
    } catch {
      // Propagate original error so callers can handle/log
      throw networkErr;
    }
  }

  // On 401, attempt refresh flow once, then retry original request
  if (response.status === 401) {
    try {
      const refreshResp = await fetch('/admin/api/v2/auth/jwt/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (refreshResp.ok) {
        const json = await getJson(refreshResp);
        const newToken = (json && typeof json === 'object' && 'data' in json)
          ? (json.data as any)?.access_token as string | undefined
          : undefined;
        if (newToken) {
          // Persist new token for subsequent requests
          setAccessToken(newToken);
          try {
            // Notify interested listeners (e.g., WebSocket hook) that token changed
            window.dispatchEvent(new CustomEvent('auth_token_updated', { detail: { accessToken: newToken } }));
          } catch {}
          // Update Authorization header and retry original request
          headers.set('Authorization', `Bearer ${newToken}`);
          response = await fetch(input, {
            ...init,
            method,
            credentials: 'include',
            headers,
          });
        }
      } else {
        // Refresh failed; clear any stale token
        clearAccessToken();
      }
    } catch (e) {
      // fall through to return original 401
    }
  }
  
  return response;
};

export const requestJson = async <T = ParsedJson>(
  input: RequestInfo,
  init: RequestInit = {},
  options: ApiFetchOptions = {}
): Promise<T> => {
  const response = await apiFetch(input, init, options);
  const json = await getJson(response);

  if (!response.ok) {
    const errorPayload = (json ?? undefined) as ParsedJson | undefined;
    const message =
      (typeof errorPayload === 'object' &&
        errorPayload &&
        'error' in errorPayload &&
        errorPayload.error?.message) ||
      response.statusText ||
      'Request failed';
    throw new ApiError(message, response.status, errorPayload);
  }

  return (json as T) ?? ({} as T);
};
