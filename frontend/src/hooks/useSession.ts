import { useEffect, useState, useRef } from 'react';
import useSWR from 'swr';
import { ApiError, requestJson } from '../util/apiClient';
import { getAccessToken, setAccessToken } from '../util/tokenStore';

export const useSession = () => {
  // Use state to track token so React re-renders when it changes
  const [hasToken, setHasToken] = useState(() => !!getAccessToken());
  const [isBootstrapRefreshing, setIsBootstrapRefreshing] = useState(() => !getAccessToken());
  const refreshAttempted = useRef(false); // Guard against duplicate refresh attempts
  const sessionKey = hasToken ? '/admin/api/v2/auth/session' : null;

  const { data, error, isLoading, mutate } = useSWR(
    sessionKey,
    sessionKey ? (url: string) => requestJson(url) : null,
    {
      revalidateOnFocus: false,
    }
  );

  // On initialization, if no token is present, try to refresh from refresh cookie
  // This implements the "Session Bootstrap & Reliability" pattern from the security model
  // Access token is stored in memory only; on page refresh, we use the HttpOnly refresh cookie
  // to get a new access token (sent automatically with credentials: 'include')
  useEffect(() => {
    console.log('[useSession] useEffect triggered:', {
      isBootstrapRefreshing,
      hasToken: !!getAccessToken(),
      refreshAttempted: refreshAttempted.current
    });

    if (isBootstrapRefreshing && !getAccessToken() && !refreshAttempted.current) {
      console.log('[useSession] Starting JWT refresh attempt');
      refreshAttempted.current = true; // Mark that we've started a refresh attempt
      // Attempt to refresh the token using the HttpOnly refresh cookie
      // The cookie is automatically sent with credentials: 'include'
      fetch('/admin/api/v2/auth/jwt/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
        .then(async (resp) => {
          console.log('[useSession] JWT refresh response:', { status: resp.status, ok: resp.ok });
          if (resp.ok) {
            const json = await resp.json().catch(() => null);
            const newToken = (json && typeof json === 'object' && 'data' in json)
              ? (json.data as any)?.access_token as string | undefined
              : undefined;
            if (newToken) {
              setAccessToken(newToken);
              try {
                window.dispatchEvent(new CustomEvent('auth_token_updated', { detail: { accessToken: newToken } }));
              } catch {}
              setHasToken(true);
            } else {
              // No token in response - user is not logged in
              setIsBootstrapRefreshing(false);
            }
          } else {
            // Refresh failed (401) - user is not logged in
            setIsBootstrapRefreshing(false);
          }
        })
        .catch(() => {
          // Network error or refresh failed - user may not be logged in
          setIsBootstrapRefreshing(false);
        })
        .finally(() => {
          setIsBootstrapRefreshing(false);
        });
    }
  }, [isBootstrapRefreshing]);

  // Update token state when token is updated
  // SWR will automatically fetch when sessionKey changes from null to a URL
  useEffect(() => {
    const handleTokenUpdate = () => {
      const token = getAccessToken();
      setHasToken(!!token);
      // SWR will automatically fetch when sessionKey changes
    };
    
    const handleLogout = () => {
      setHasToken(false);
      mutate(null, false); // Clear cache without revalidation
    };

    window.addEventListener('auth_token_updated', handleTokenUpdate);
    window.addEventListener('auth_logged_out', handleLogout);
    
    return () => {
      window.removeEventListener('auth_token_updated', handleTokenUpdate);
      window.removeEventListener('auth_logged_out', handleLogout);
    };
  }, [mutate]);

  // No CSRF handling under JWT

  return {
    session: data?.data ?? null,
    loading: isLoading || isBootstrapRefreshing, // Include bootstrap refresh in loading state
    error: error as ApiError | undefined,
    refresh: mutate
  };
};
