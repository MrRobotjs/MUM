import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export const useUserHistoryPaginated = (uuid?: string, page = 1, pageSize = 10) => {
  const url = uuid ? `/api/v2/users/${uuid}/history?page=${page}&page_size=${pageSize}` : null;

  const { data, error, isLoading } = useSWR(url, (url: string) => requestJson(url), {
    revalidateOnFocus: false
  });

  const entries = data?.data ?? [];
  const pagination = data?.meta?.pagination;

  console.log('[useUserHistoryPaginated]', {
    uuid,
    page,
    pageSize,
    entries: entries.length,
    pagination,
    error,
    isLoading
  });

  return {
    entries,
    error,
    loading: isLoading,
    currentPage: pagination?.page ?? 1,
    totalPages: pagination?.total_pages ?? 1,
    totalItems: pagination?.total_items ?? 0
  };
};
