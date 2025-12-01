import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export interface SystemConfig {
  git_branch: string;
  git_commit: string;
  database_file: string;
  log_directory: string;
  instance_directory: string;
  platform: string;
  system_timezone: string;
  python_version: string;
  sqlite_version: string;
}

interface SystemConfigResponse {
  data: SystemConfig;
  meta: {
    request_id: string;
    generated_at: string;
  };
}

export const useSystemConfig = () => {
  const { data, error, isLoading, mutate } = useSWR<SystemConfigResponse>(
    '/admin/api/v2/settings/system-config',
    (url: string) => requestJson<SystemConfigResponse>(url)
  );

  return {
    config: data?.data || null,
    loading: isLoading,
    error,
    refresh: mutate
  };
};
