import { mutate as mutateSWR } from 'swr';
import { requestJson } from '../util/apiClient';

// The media services MUM supports (Plex, Jellyfin, …), read once and shared:
// the Media Servers settings pages, the setup wizard and every server form
// read this one cache, so every reader sees the same shape.

export const MEDIA_SERVICES_CACHE_KEY = '/api/providers';

/** A supported media service: whether it's turned on, how many servers it has, and what MUM can do with it. */
export type MediaService = Readonly<{
  id: string;
  name: string;
  description: string | null;
  /** The server release MUM was last checked against, or null when it hasn't been checked against a real server. */
  testedVersion: string | null;
  enabled: boolean;
  serverCount: number;
  capabilities: readonly string[];
  /** Every feature the Media Servers cards list, in order, and whether this service supports it. */
  features: readonly MediaServiceFeature[];
}>;

export type MediaServiceFeature = Readonly<{ key: string; supported: boolean }>;

type MediaServiceDto = { id?: unknown; name?: unknown; description?: unknown; tested_version?: unknown; enabled?: unknown; server_count?: unknown; capabilities?: unknown; features?: unknown };

const feature = (value: unknown): value is { key: string; supported: boolean } => {
  const v = value as { key?: unknown; supported?: unknown } | null;
  return Boolean(v) && typeof v!.key === 'string' && /^[a-z]+\.[a-z_]{1,64}$/.test(v!.key) && typeof v!.supported === 'boolean';
};

export const fetchMediaServices = async (url: string): Promise<readonly MediaService[]> => {
  const response = await requestJson<{ data?: unknown }>(url);
  if (!Array.isArray(response.data)) throw new Error('Invalid media services');
  return Object.freeze(response.data.map((value: MediaServiceDto) => {
    if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.enabled !== 'boolean'
      || !Number.isSafeInteger(value.server_count) || (value.server_count as number) < 0
      || !Array.isArray(value.capabilities) || !value.capabilities.every(c => typeof c === 'string')
      || !Array.isArray(value.features) || value.features.length > 64 || !value.features.every(feature)) throw new Error('Invalid media services');
    return Object.freeze({
      id: value.id, name: value.name, description: typeof value.description === 'string' && value.description ? value.description : null,
      testedVersion: typeof value.tested_version === 'string' && /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(value.tested_version) ? value.tested_version : null,
      enabled: value.enabled, serverCount: value.server_count as number, capabilities: Object.freeze([...value.capabilities as string[]]),
      features: Object.freeze((value.features as { key: string; supported: boolean }[]).map(f => Object.freeze({ key: f.key, supported: f.supported }))),
    });
  }));
};

/** Loads the media services into the shared cache ahead of the pages that need them. */
export const prefetchMediaServices = async () => {
  try {
    return await mutateSWR(MEDIA_SERVICES_CACHE_KEY, fetchMediaServices(MEDIA_SERVICES_CACHE_KEY), { populateCache: true, revalidate: false });
  } catch {
    return null;
  }
};

/** Reads the media services again, after turning one on or off or changing its servers. */
export const revalidateMediaServices = async () => mutateSWR(MEDIA_SERVICES_CACHE_KEY);
