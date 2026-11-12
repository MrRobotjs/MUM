import { useMemo } from 'react';
import useSWR from 'swr';
import {
  PLUGINS_CACHE_KEY,
  fetchPlugins,
  type PluginApi,
  type PluginsResponse,
} from '../cache/pluginsCache';
import { type CapabilityPayload } from '../lib/pluginCapabilities';

export type Plugin = {
  id: string;
  pluginId: string;
  name: string;
  description: string | null;
  status: string | null;
  enabled: boolean;
  enabledByUser: boolean;
  installed: boolean;
  author: string | null;
  repository_url: string | null;
  homepage: string | null;
  license: string | null;
  pluginType: string | null;
  serversCount: number;
  lastError: string | null;
  capabilities: string[];
  supportedFeatures: string[];
  capabilitiesRaw: CapabilityPayload;
  raw: PluginApi;
};

const normalizePlugin = (item: PluginApi): Plugin => {
  const available = item.available ?? null;
  const pluginId = item.plugin_id || available?.plugin_id || '';
  const name = item.name ?? available?.name ?? pluginId;
  const description = item.description ?? available?.description ?? null;
  const status = item.status ?? null;
  const enabledByUser = Boolean(item.enabled_by_user);
  const installed = Boolean(item.installed_at) || Boolean(status);
  const enabled = enabledByUser;
  const author = item.author ?? available?.author ?? null;
  const repository = item.repository ?? available?.repository ?? null;
  const homepage = item.homepage ?? available?.homepage ?? null;
  const license = item.license ?? available?.license ?? null;
  const lastError = item.last_error ?? null;
  const policy = item.policy ?? {};
  const integrations = item.integrations ?? {};
  const capabilitiesRaw = { policy, integrations };
  const capabilities = Array.isArray(item.capability_keys) ? item.capability_keys : [];
  const supportedFeatures = capabilities;
  const pluginType = (item as any).plugin_type ?? (item as { type?: string | null }).type ?? available?.plugin_type ?? null;
  const serversCount =
    item.servers_count ??
    (available as any)?.servers_count ??
    0;

  return {
    id: pluginId,
    pluginId,
    name,
    description,
    status,
    enabled,
    enabledByUser,
    installed,
    author,
    repository_url: repository,
    homepage,
    license,
    pluginType,
    serversCount,
    lastError,
    capabilities,
    supportedFeatures,
    capabilitiesRaw,
    raw: item
  };
};

type UsePluginsOptions = {
  enabled?: boolean;
};

export const usePlugins = (options: UsePluginsOptions = {}) => {
  const { enabled = true } = options;
  const { data, error, isLoading, mutate } = useSWR<PluginsResponse>(
    enabled ? PLUGINS_CACHE_KEY : null,
    fetchPlugins
  );

  const plugins = useMemo(() => (data?.data ? data.data.map(normalizePlugin) : []), [data]);

  return {
    plugins,
    loading: isLoading,
    error,
    refresh: mutate
  };
};
