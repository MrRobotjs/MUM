import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type InviteFilters = {
  status?: string;
  page?: number;
  pageSize?: number;
  search?: string;
  serverId?: number;
};

export const useInvites = (filters: InviteFilters = {}) => {
  const params = new URLSearchParams();
  params.set('page', String(filters.page ?? 1));
  params.set('page_size', String(filters.pageSize ?? 25));
  if (filters.status) params.set('status', filters.status);
  if (filters.search) params.set('search', filters.search);
  if (filters.serverId) params.set('server_id', String(filters.serverId));

  const { data, error, isLoading, mutate } = useSWR(
    `/admin/api/v2/invites?${params.toString()}`,
    (url: string) => requestJson(url),
    {
      revalidateOnFocus: false
    }
  );

  return {
    invites: data?.data ?? [],
    pagination: data?.meta?.pagination,
    loading: isLoading,
    error,
    refresh: mutate
  };
};
