import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type ServerOption = {
  id: number;
  server_nickname: string;
  service_type: string;
};

type ServersResponse = {
  data: ServerOption[];
};

export const useServerOptions = () => {
  const { data, error, isLoading } = useSWR<ServersResponse>(
    '/admin/api/v1/servers',
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
