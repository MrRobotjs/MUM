import { mutate as mutateSWR } from 'swr';
import { requestJson } from '../util/apiClient';

export const PLUGINS_CACHE_KEY = '/api/providers';
export const PLUGIN_CONFIG_CACHE_KEY = PLUGINS_CACHE_KEY;

export type PluginApi = {
  plugin_id: string;
  plugin_type?: string;
  name?: string | null;
  description?: string | null;
  status?: string | null;
  enabled_by_user?: boolean | null;
  author?: string | null;
  repository?: string | null;
  homepage?: string | null;
  license?: string | null;
  installed_at?: string | null;
  last_updated?: string | null;
  last_error?: string | null;
  servers_count?: number;
  capability_keys?: string[] | null;
  policy?: Record<string, unknown> | null;
  integrations?: Record<string, unknown> | null;
  declared_policy?: Record<string, unknown> | null;
  declared_integrations?: Record<string, unknown> | null;
  effective_capabilities?: {
    behavior?: string[];
    policy?: string[];
    integration?: string[];
  } | null;
  effective_capability_keys?: string[] | null;
  derived_behavior_capability_keys?: string[] | null;
  policy_capability_keys?: string[] | null;
  integration_capability_keys?: string[] | null;
  declared_capability_keys?: string[] | null;
  declared_behavior_capability_keys?: string[] | null;
  invalid_declared_behavior?: string[] | null;
  invalid_derived_behavior?: string[] | null;
  undeclared_derived_behavior?: string[] | null;
  available?: {
    plugin_id?: string;
    name?: string;
    description?: string;
    author?: string;
    repository?: string;
    homepage?: string;
    license?: string;
    plugin_type?: string;
  } | null;
};

export type PluginsResponse = {
  data: PluginApi[];
  meta?: {
    request_id: string;
  };
};

type ProviderDto = { id: string; name: string; description: string; enabled: boolean; server_count: number; capabilities: string[] };
export const fetchPlugins = async (url: string): Promise<PluginsResponse> => {
  const response = await requestJson<{ data: ProviderDto[] }>(url);
  return {
    data: response.data.map(provider => ({
      plugin_id: provider.id, plugin_type: 'core', name: provider.name, description: provider.description,
      status: provider.enabled ? 'enabled' : 'disabled', enabled_by_user: provider.enabled,
      servers_count: provider.server_count, capability_keys: provider.capabilities,
    })),
  };
};

export type PluginConfigApi = {
  plugin_id: string;
  enabled: boolean;
  status?: string | null;
  type?: string | null;
  capability_keys?: string[] | null;
  effective_capabilities?: {
    behavior?: string[];
    policy?: string[];
    integration?: string[];
  } | null;
  policy?: Record<string, unknown> | null;
  integrations?: Record<string, unknown> | null;
};

export type PluginConfigResponse = PluginsResponse;
export const fetchPluginConfig = fetchPlugins;

export const prefetchPluginsCache = async () => {
  try {
    return await mutateSWR(
      PLUGINS_CACHE_KEY,
      fetchPlugins(PLUGINS_CACHE_KEY),
      {
        populateCache: true,
        revalidate: false,
      }
    );
  } catch {
    return null;
  }
};

export const prefetchPluginConfigCache = async () => {
  try {
    return await mutateSWR(
      PLUGIN_CONFIG_CACHE_KEY,
      fetchPluginConfig(PLUGIN_CONFIG_CACHE_KEY),
      {
        populateCache: true,
        revalidate: false,
      }
    );
  } catch {
    return null;
  }
};

export const revalidatePluginsCache = async () => {
  return mutateSWR(PLUGINS_CACHE_KEY);
};

export const revalidatePluginConfigCache = async () => {
  return mutateSWR(PLUGIN_CONFIG_CACHE_KEY);
};
