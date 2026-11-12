import { createContext, useContext, useMemo, type ReactNode } from 'react';
import useSWR from 'swr';
import {
  PLUGIN_CONFIG_CACHE_KEY,
  fetchPluginConfig,
  type PluginConfigResponse,
} from '../cache/pluginsCache';
import { useAuth } from './AuthContext';
import { hasCapabilityToken, normalizeCapabilityToken, type CapabilityPayload } from '../lib/pluginCapabilities';

type PluginCapabilityShape = {
  pluginId: string;
  capabilityKeys: string[];
  capabilitiesRaw: CapabilityPayload;
};

export type PluginCapabilitiesContextValue = {
  loading: boolean;
  error: Error | undefined;
  hasCapability: (pluginId: string, capability: string) => boolean;
  hasAnyCapability: (pluginId: string, capabilities: string[]) => boolean;
  hasAllCapabilities: (pluginId: string, capabilities: string[]) => boolean;
  getCapabilityKeys: (pluginId: string) => string[];
  getCapabilitiesRaw: (pluginId: string) => CapabilityPayload;
  refresh: () => Promise<unknown>;
};

const PluginCapabilitiesContext = createContext<PluginCapabilitiesContextValue | undefined>(undefined);

const normalizePluginId = (value: string) => value.trim().toLowerCase();

export const PluginCapabilitiesProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated, hasAdminAccess } = useAuth();
  const shouldLoadPlugins = isAuthenticated && hasAdminAccess;
  const { data, isLoading, error, mutate } = useSWR<PluginConfigResponse>(
    shouldLoadPlugins ? PLUGIN_CONFIG_CACHE_KEY : null,
    fetchPluginConfig
  );

  const capabilityMap = useMemo(() => {
    const map = new Map<string, PluginCapabilityShape>();
    const pluginConfigItems = data?.data ?? [];

    pluginConfigItems.forEach((plugin) => {
      const pluginId = normalizePluginId(plugin.plugin_id);
      if (!pluginId) return;

      const known = new Set<string>();
      const capabilityKeys = Array.isArray(plugin.capability_keys) ? plugin.capability_keys : [];
      capabilityKeys.forEach((token) => known.add(normalizeCapabilityToken(token)));

      const policy = plugin.policy ?? {};
      const integrations = plugin.integrations ?? {};

      map.set(pluginId, {
        pluginId,
        capabilityKeys: Array.from(known),
        capabilitiesRaw: { policy, integrations },
      });
    });

    return map;
  }, [data]);

  const getCapabilityKeys = (pluginId: string) => {
    const normalizedPluginId = normalizePluginId(pluginId);
    return capabilityMap.get(normalizedPluginId)?.capabilityKeys ?? [];
  };

  const getCapabilitiesRaw = (pluginId: string) => {
    const normalizedPluginId = normalizePluginId(pluginId);
    return capabilityMap.get(normalizedPluginId)?.capabilitiesRaw;
  };

  const hasCapability = (pluginId: string, capability: string) => {
    const capabilityKeys = getCapabilityKeys(pluginId);
    return hasCapabilityToken(capabilityKeys, capability);
  };

  const hasAnyCapability = (pluginId: string, capabilities: string[]) => {
    return capabilities.some((capability) => hasCapability(pluginId, capability));
  };

  const hasAllCapabilities = (pluginId: string, capabilities: string[]) => {
    return capabilities.every((capability) => hasCapability(pluginId, capability));
  };

  const value: PluginCapabilitiesContextValue = {
    loading: shouldLoadPlugins ? isLoading : false,
    error: shouldLoadPlugins ? (error as Error | undefined) : undefined,
    hasCapability,
    hasAnyCapability,
    hasAllCapabilities,
    getCapabilityKeys,
    getCapabilitiesRaw,
    refresh: () => mutate(),
  };

  return <PluginCapabilitiesContext.Provider value={value}>{children}</PluginCapabilitiesContext.Provider>;
};

export const usePluginCapabilities = (): PluginCapabilitiesContextValue => {
  const context = useContext(PluginCapabilitiesContext);
  if (!context) {
    throw new Error('usePluginCapabilities must be used within a PluginCapabilitiesProvider');
  }
  return context;
};
