import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type Server = {
  id: number;
  server_nickname: string;
  server_name: string | null;
  service_type: string;
  url: string;
  public_url: string | null;
  jellyfin_owner_user_id?: string | null;
  is_active: boolean;
  plugin_enabled?: boolean;
  effective_active?: boolean;
  created_at: string;
  updated_at: string;
  last_status?: boolean | null;
  last_status_check?: string | null;
  last_version?: string | null;
  last_sync_at?: string | null;
  overseerr_enabled?: boolean;
  overseerr_url?: string | null;
  plugin_data?: Record<string, unknown>;
  websocket_refresh_interval?: number;
};

type ServersResponse = {
  data: Server[];
  meta: {
    request_id: string;
    total_count: number;
  };
};

type UseServersOptions = {
  includeStatus?: boolean;
  activeOnly?: boolean;
  serviceType?: string;
};

export const useServers = (options: UseServersOptions = {}) => {
  const params = new URLSearchParams();
  if (options.includeStatus) params.append('include_status', 'true');
  if (options.activeOnly) params.append('active_only', 'true');
  if (options.serviceType) params.append('service_type', options.serviceType);

  const url = `/api/v2/servers${params.toString() ? `?${params.toString()}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<ServersResponse>(
    url,
    (url: string) => requestJson(url)
  );

  return {
    servers: data?.data ?? [],
    loading: isLoading,
    error,
    refresh: mutate,
  };
};

export const useServerDetail = (serverId?: number) => {
  const url = serverId ? `/api/v2/servers/${serverId}?include_status=true&include_libraries=true` : null;

  const { data, error, isLoading, mutate } = useSWR(
    url,
    (url: string) => requestJson(url)
  );

  return {
    server: (data?.data ?? data) || null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
