import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type LogEntry = {
  id: number;
  timestamp: string;
  event_type: string | null;
  message: string;
  details?: Record<string, unknown>;
  owner?: {
    id: number;
    uuid: string;
    username: string;
    display_name: string;
  } | null;
  local_user?: {
    id: number;
    uuid: string;
    username: string;
    display_name: string;
  } | null;
  invite_id?: number | null;
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

type LogFilters = {
  searchMessage?: string;
  eventType?: string;
  relatedUser?: string;
};

export const useLogs = (page = 1, pageSize = 50, filters?: LogFilters) => {
  const params = new URLSearchParams({
    page: page.toString(),
    page_size: pageSize.toString(),
  });

  if (filters?.searchMessage) params.append('search_message', filters.searchMessage);
  if (filters?.eventType) params.append('event_type', filters.eventType);
  if (filters?.relatedUser) params.append('related_user', filters.relatedUser);

  const url = `/admin/api/v2/settings/logs?${params.toString()}`;

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
