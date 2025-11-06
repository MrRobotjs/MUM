import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { ApiError, requestJson } from '../util/apiClient';
import { getAccessToken } from '../util/tokenStore';

export const useSession = () => {
  // Use state to track token so React re-renders when it changes
  const [hasToken, setHasToken] = useState(() => !!getAccessToken());
  const sessionKey = hasToken ? '/admin/api/v2/auth/session' : null;
  
  const { data, error, isLoading, mutate } = useSWR(
    sessionKey,
    sessionKey ? (url: string) => requestJson(url) : null,
    {
      revalidateOnFocus: false,
    }
  );

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
    loading: isLoading,
    error: error as ApiError | undefined,
    refresh: mutate
  };
};
