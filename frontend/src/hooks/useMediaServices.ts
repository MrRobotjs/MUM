import { useCallback } from 'react';
import useSWR from 'swr';
import { MEDIA_SERVICES_CACHE_KEY, fetchMediaServices, type MediaService } from '../cache/mediaServicesCache';

export type { MediaService, MediaServiceFeature } from '../cache/mediaServicesCache';

const none: readonly MediaService[] = Object.freeze([]);

/** The supported media services, from the shared cache. */
export const useMediaServices = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const { data, error, isLoading, mutate } = useSWR(enabled ? MEDIA_SERVICES_CACHE_KEY : null, fetchMediaServices);
  return { services: data ?? none, loading: isLoading, error: error as Error | undefined, refresh: mutate };
};

/**
 * Whether a media service advertises a capability: the key itself, or any
 * more specific key under it ("users" covers "users.sync").
 */
export const mediaServiceHasCapability = (services: readonly MediaService[], serviceId: string, capability: string): boolean => {
  const service = services.find(s => s.id === serviceId.trim().toLowerCase());
  const key = capability.trim().toLowerCase();
  return Boolean(service && key) && service!.capabilities.some(c => c === key || c.startsWith(`${key}.`));
};

/** The server forms' capability check, from the shared media services cache. */
export const useMediaServiceCapabilities = () => {
  const { services } = useMediaServices();
  const hasCapability = useCallback((serviceId: string, capability: string) => mediaServiceHasCapability(services, serviceId, capability), [services]);
  return { hasCapability };
};
