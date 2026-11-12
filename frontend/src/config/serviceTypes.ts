/**
 * The media services compiled into MUM's server (server/provider_registry.go),
 * in display order. This is the frontend's one list: data adapters reject any
 * other service type. Adding a service means adding it here and its icon and
 * colours in pluginMetadata.tsx.
 */
export const SERVICE_TYPES = [
  { value: 'plex', label: 'Plex' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'emby', label: 'Emby' },
  { value: 'kavita', label: 'Kavita' },
  { value: 'audiobookshelf', label: 'AudioBookshelf' },
  { value: 'komga', label: 'Komga' },
  { value: 'romm', label: 'RomM' },
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number]['value'];

export const SERVICE_IDS: readonly string[] = SERVICE_TYPES.map((type) => type.value);

export const isServiceType = (value: unknown): value is ServiceType =>
  typeof value === 'string' && SERVICE_IDS.includes(value);
