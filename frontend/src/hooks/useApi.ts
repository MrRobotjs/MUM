import { useEffect, useState } from 'react';
import { ApiError, requestJson } from '../util/apiClient';

type FetchState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

export function useApi<T>(endpoint: string, deps: unknown[] = []) {
  const [state, setState] = useState<FetchState<T>>({
    data: null,
    loading: true,
    error: null
  });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    requestJson<T>(endpoint)
      .then((json) => {
        if (!cancelled) {
          setState({ data: json, loading: false, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = (error as ApiError).message || 'Request failed';
          setState({ data: null, loading: false, error: message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

export function useAdminApi<T>(path: string, deps: unknown[] = []) {
  const endpoint = `/api/v2${path}`;
  return useApi<T>(endpoint, deps);
}
