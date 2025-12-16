import { useCallback, useSyncExternalStore } from 'react';

type Listener = () => void;

type MediaQueryEntry = {
  mql: MediaQueryList;
  listeners: Set<Listener>;
  onChange: () => void;
};

const entries = new Map<string, MediaQueryEntry>();

const canUseMatchMedia = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

export const getMediaQuerySnapshot = (query: string) => {
  if (!canUseMatchMedia()) return false;
  return entries.get(query)?.mql.matches ?? window.matchMedia(query).matches;
};

export const subscribeToMediaQuery = (query: string, listener: Listener) => {
  if (!canUseMatchMedia()) return () => {};

  let entry = entries.get(query);
  if (!entry) {
    const mql = window.matchMedia(query);
    const listeners = new Set<Listener>();
    const onChange = () => {
      for (const callback of Array.from(listeners)) callback();
    };
    mql.addEventListener('change', onChange);
    entry = { mql, listeners, onChange };
    entries.set(query, entry);
  }

  entry.listeners.add(listener);

  return () => {
    const current = entries.get(query);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.mql.removeEventListener('change', current.onChange);
      entries.delete(query);
    }
  };
};

export const useMediaQuery = (query: string) => {
  const subscribe = useCallback(
    (onStoreChange: Listener) => subscribeToMediaQuery(query, onStoreChange),
    [query]
  );
  const getSnapshot = useCallback(() => getMediaQuerySnapshot(query), [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
};

