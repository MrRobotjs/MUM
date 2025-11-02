import { getAccessToken } from './tokenStore';

/**
 * DEPRECATED: Use cookie-authenticated image endpoints or ImageWithAuth.
 *
 * Append the short-lived access token as a query param to a same-origin URL.
 * Kept for backward compatibility during migration.
 */
export const appendAuthToken = (url: string, token?: string | null): string => {
  try {
    const t = token ?? getAccessToken();
    if (!t) return url;
    const u = new URL(url, window.location.origin);
    u.searchParams.set('access_token', t);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

