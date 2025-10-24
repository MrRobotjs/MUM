import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type StreamingCounts = {
  total: number;
  active: number;
  completed: number;
};

type StreamingDuration = {
  total_seconds: number;
  average_seconds: number;
};

type StreamingDailyPoint = {
  date: string;
  count: number;
};

type StreamingServiceBreakdown = {
  service_type: string;
  count: number;
};

type StreamingSummaryResponse = {
  data: {
    counts: StreamingCounts;
    duration: StreamingDuration;
    daily: StreamingDailyPoint[];
    by_service: StreamingServiceBreakdown[];
  };
};

export const useStreamingSummary = () => {
  const { data, error, isLoading } = useSWR<StreamingSummaryResponse>(
    '/admin/api/v1/streams/summary',
    (url: string) => requestJson<StreamingSummaryResponse>(url),
    {
      revalidateOnFocus: false,
      refreshInterval: 60_000
    }
  );

  return {
    summary: data?.data,
    loading: isLoading,
    error
  };
};

export type {
  StreamingCounts,
  StreamingDuration,
  StreamingDailyPoint,
  StreamingServiceBreakdown
};
