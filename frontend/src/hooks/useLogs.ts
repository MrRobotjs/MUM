import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type LogEntry = {
  id: number;
  timestamp: string;
  level: string;
  message: string;
  source?: string;
  details?: Record<string, unknown>;
};

type LogsResponse = {
  data: LogEntry[];
  meta: {
    request_id: string;
    pagination?: {
      page: number;
      page_size: number;
      total_items: number;
      total_pages: number;
    };
  };
};

export const useLogs = (page = 1, pageSize = 50) => {
  const url = `/admin/api/v2/settings/logs?page=${page}&page_size=${pageSize}`;

  const { data, error, isLoading, mutate } = useSWR<LogsResponse>(
    url,
    (url: string) => requestJson(url)
  );

  return {
    logs: data?.data ?? [],
    pagination: data?.meta?.pagination,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
