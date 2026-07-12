import useSWR from 'swr';
import { requestJson } from '@/util/apiClient';

export type RecentStreamRow = {
  id: number;
  user_uuid?: string;
  user_display_name?: string;
  user_avatar_url?: string;
  media_title?: string;
  media_type?: string;
  server_id?: number;
  server_name?: string;
  started_at?: string;
  stopped_at?: string;
  duration_seconds?: number;
  platform?: string;
  poster_url?: string;
};

type RecentStreamsResponse = {
  data: RecentStreamRow[];
  meta: {
    pagination: {
      page: number;
      page_size: number;
      total_items: number;
      total_pages: number;
    };
  };
};

type UseRecentStreamsOptions = {
  pageSize?: number;
  status?: 'active' | 'completed';
};

export const useRecentStreams = ({ pageSize = 8, status }: UseRecentStreamsOptions = {}) => {
  const params = new URLSearchParams({
    page: '1',
    page_size: String(pageSize),
  });
  if (status) {
    params.set('status', status);
  }

  const { data, error, isLoading, mutate } = useSWR<RecentStreamsResponse>(
    `/api/v2/streams?${params.toString()}`,
    (url: string) => requestJson<RecentStreamsResponse>(url),
    { revalidateOnFocus: false, refreshInterval: 60_000 },
  );

  return {
    streams: data?.data ?? [],
    pagination: data?.meta.pagination,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
