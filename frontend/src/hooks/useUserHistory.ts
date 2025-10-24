import useSWRInfinite from 'swr/infinite';
import { requestJson } from '../util/apiClient';

export const useUserHistory = (uuid?: string, pageSize = 10) => {
  const getKey = (pageIndex: number, previousPageData: any) => {
    if (!uuid) return null;
    if (previousPageData && previousPageData.meta.pagination.page >= previousPageData.meta.pagination.total_pages) {
      return null;
    }

    const page = pageIndex + 1;
    return `/admin/api/v1/users/${uuid}/history?page=${page}&page_size=${pageSize}`;
  };

  const { data, error, size, setSize, isLoading } = useSWRInfinite(getKey, (url: string) => requestJson(url), {
    revalidateOnFocus: false
  });

  const entries = data ? data.flatMap((page: any) => page.data) : [];
  const pagination = data?.[data.length - 1]?.meta.pagination;

  return {
    entries,
    error,
    loading: isLoading && !data,
    loadMore: () => setSize(size + 1),
    hasMore: pagination ? pagination.page < pagination.total_pages : false
  };
};
