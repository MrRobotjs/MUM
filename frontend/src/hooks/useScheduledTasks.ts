import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export interface ScheduledTask {
  id: string;
  name: string;
  type: string;
  state: string;
  side: string;
  next_run_time: string | null;
  interval_seconds: number | null;
}

interface ScheduledTasksResponse {
  data: ScheduledTask[];
  meta: {
    request_id: string;
    generated_at: string;
  };
}

export const useScheduledTasks = () => {
  const { data, error, isLoading, mutate } = useSWR<ScheduledTasksResponse>(
    '/admin/api/v2/settings/scheduled-tasks',
    (url: string) => requestJson<ScheduledTasksResponse>(url),
    { refreshInterval: 5000 } // Auto-refresh every 5 seconds for real-time countdown
  );

  return {
    tasks: data?.data || [],
    loading: isLoading,
    error,
    refresh: mutate
  };
};
