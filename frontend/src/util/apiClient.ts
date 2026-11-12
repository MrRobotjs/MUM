import { getAccessToken, clearAccessToken, refreshAccessToken } from '../store/authStore';

export type ParsedJson<T = unknown> = {
  data?: T;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
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
    if (payload && typeof payload === 'object' && 'error' in payload) {
      this.details = (payload as { error?: { details?: Record<string, unknown> } }).error?.details;
    }
  }
}

export type ApiRequestInit = RequestInit & { retryAuthentication?: boolean };
export const apiFetch = async (input: RequestInfo, init: ApiRequestInit = {}): Promise<Response> => {
  const { retryAuthentication = true, ...requestInit } = init;
  const rawUrl = typeof input === 'string' ? input : input.url;
  const url = new URL(rawUrl, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('API requests must use this origin');
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('Accept', 'application/json');
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const original = new Request(typeof input === 'string' ? url.href : input, { ...requestInit, credentials: 'include', headers });
  let response = await fetch(original.clone());
  const isAuthentication = url.pathname.startsWith('/api/auth/') || url.pathname === '/api/setup/account';
  if (response.status === 401 && !isAuthentication && retryAuthentication) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const retryHeaders = new Headers(original.headers);
      retryHeaders.set('Authorization', `Bearer ${refreshed}`);
      response = await fetch(new Request(original, { headers: retryHeaders }));
    } else {
      if (token) {
        try { window.sessionStorage.setItem('auth_logout_reason', 'inactivity'); } catch { /* optional notice */ }
      }
      clearAccessToken();
    }
  }
  return response;
};

export const requestJson = async <T = ParsedJson>(input: RequestInfo, init: ApiRequestInit = {}): Promise<T> => {
  const response = await apiFetch(input, init);
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* handled as invalid response below */ }
  if (!response.ok) throw new ApiError(payload?.error?.message || response.statusText || 'Request failed', response.status, payload ?? undefined);
  if (text && payload === null) throw new ApiError('Server returned invalid JSON', response.status);
  return (payload ?? {}) as T;
};
