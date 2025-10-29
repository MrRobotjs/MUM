import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type StreamingSettings = {
  enable_navbar_stream_badge: boolean;
  session_monitoring_interval: number;
  websocket_refresh_interval: number;
};

type StreamingSettingsResponse = {
  data: StreamingSettings;
};

export const useStreamingSettings = () => {
  const { data, error, isLoading, mutate } = useSWR<StreamingSettingsResponse>(
    '/admin/api/v2/settings/streaming',
    (url: string) => requestJson<StreamingSettingsResponse>(url),
    {
      revalidateOnFocus: false
    }
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate
  };
};
