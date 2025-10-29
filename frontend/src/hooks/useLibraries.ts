import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type Library = {
  id: number;
  internal_id?: string | null;
  external_id: string;
  name: string;
  library_type?: string | null;
  item_count?: number | null;
  last_scanned?: string | null;
  server_id?: number;
  server?: {
    id: number;
    server_nickname: string;
    server_name?: string | null;
    service_type: string;
  };
  created_at?: string | null;
  updated_at?: string | null;
};

type LibrariesResponse = {
  data: Library[];
  meta: {
    request_id: string;
    total_count: number;
  };
};

type UseLibrariesOptions = {
  serverId?: number;
  libraryType?: string;
  search?: string;
  includeServer?: boolean;
};

export const useLibraries = (options: UseLibrariesOptions = {}) => {
  const params = new URLSearchParams();
  if (options.serverId) params.append('server_id', String(options.serverId));
  if (options.libraryType) params.append('library_type', options.libraryType);
  if (options.search) params.append('search', options.search);
  if (options.includeServer !== false) params.append('include_server', 'true');

  const url = `/admin/api/v2/libraries${params.toString() ? `?${params.toString()}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<LibrariesResponse>(
    url,
    (url: string) => requestJson(url)
  );

  return {
    libraries: data?.data ?? [],
    loading: isLoading,
    error,
    refresh: mutate,
  };
};

export const useLibraryDetail = (libraryId?: number) => {
  const url = libraryId
    ? `/admin/api/v2/libraries/${libraryId}?include_server=true&include_items_count=true`
    : null;

  const { data, error, isLoading, mutate } = useSWR(url, (url: string) =>
    requestJson(url)
  );

  return {
    library: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
