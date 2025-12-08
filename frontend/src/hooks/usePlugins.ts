import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type PluginApi = {
  plugin_id: string;
  name?: string | null;
  description?: string | null;
  status?: string | null;
  author?: string | null;
  repository?: string | null;
  homepage?: string | null;
  license?: string | null;
  installed_at?: string | null;
  last_updated?: string | null;
  last_error?: string | null;
  servers_count?: number;
  supported_features?: string[] | null;
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

type PluginsResponse = {
  data: PluginApi[];
  meta: {
    request_id: string;
  };
};

export type Plugin = {
  id: string;
  pluginId: string;
  name: string;
  description: string | null;
  status: string | null;
  enabled: boolean;
  installed: boolean;
  author: string | null;
  repository_url: string | null;
  homepage: string | null;
  license: string | null;
  pluginType: string | null;
  serversCount: number;
  lastError: string | null;
  supportedFeatures: string[];
  raw: PluginApi;
};

const normalizePlugin = (item: PluginApi): Plugin => {
  const available = item.available ?? null;
  const pluginId = item.plugin_id || available?.plugin_id || '';
  const name = item.name ?? available?.name ?? pluginId;
  const description = item.description ?? available?.description ?? null;
  const status = item.status ?? null;
  const installed = Boolean(item.installed_at) || Boolean(status);
  const enabled = status === 'enabled';
  const author = item.author ?? available?.author ?? null;
  const repository = item.repository ?? available?.repository ?? null;
  const homepage = item.homepage ?? available?.homepage ?? null;
  const license = item.license ?? available?.license ?? null;
  const lastError = item.last_error ?? null;
  const supportedFeatures = (item.supported_features ?? []) as string[];
  const pluginType = (item as any).plugin_type ?? item.type ?? available?.plugin_type ?? null;
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
    installed,
    author,
    repository_url: repository,
    homepage,
    license,
    pluginType,
    serversCount,
    lastError,
    supportedFeatures,
    raw: item
  };
};

export const usePlugins = () => {
  const { data, error, isLoading, mutate } = useSWR<PluginsResponse>(
    '/admin/api/v2/plugins',
    (url: string) => requestJson<PluginsResponse>(url)
  );

  const plugins = data?.data ? data.data.map(normalizePlugin) : [];

  return {
    plugins,
    loading: isLoading,
    error,
    refresh: mutate
  };
};
