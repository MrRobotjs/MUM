import { useCallback } from 'react';
import useSWR from 'swr';
import { useAuth } from '../contexts/AuthContext';
import { fetchOwnDisplay, formatDisplayTimestamp, formatRelativeTimestamp, type TimestampStyle } from '../lib/accountDisplay';

export function useAccountDisplay() {
  const { user } = useAuth();
  const owner = user?.uuid;
  const state = useSWR(owner ? ['/api/account/display', owner] : null, ([, id]: [string, string]) => fetchOwnDisplay(id), { keepPreviousData: false });
  const current = state.data?.user_uuid === owner && !state.error ? state.data : undefined;
  const formatTimestamp = useCallback((value: string | null | undefined, style: TimestampStyle = 'datetime', fallback = '—') => formatDisplayTimestamp(value, current?.display, style, fallback), [current]);
  const formatRelative = useCallback((value: string) => formatRelativeTimestamp(value, new Date().toISOString(), current?.display), [current]);
  return { ...state, current, owner, formatTimestamp, formatRelative };
}
