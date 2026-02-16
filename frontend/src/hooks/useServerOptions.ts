import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type ServerOption = {
  id: number;
  server_nickname: string;
  service_type: string;
  invite_capabilities?: {
    supports_library_scoped_grants?: boolean;
  };
};

type ServersResponse = {
  data: ServerOption[];
};

export const useServerOptions = () => {
  const { data, error, isLoading } = useSWR<ServersResponse>(
    '/api/v2/servers?active_only=true',
    (url: string) => requestJson<ServersResponse>(url),
    {
      revalidateOnFocus: false
    }
  );

  return {
    servers: data?.data ?? [],
    loading: isLoading,
    error
  };
};
