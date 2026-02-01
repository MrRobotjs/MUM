import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type Notification = {
  id: number;
  timestamp: string;
  notification_type: string;
  title: string;
  message: string;
  read: boolean;
  details?: Record<string, unknown>;
};

type NotificationsResponse = {
  data: Notification[];
  meta: {
    request_id: string;
    total: number;
    unread_count: number;
  };
};

type NotificationFilters = {
  unreadOnly?: boolean;
  type?: string;
  limit?: number;
};

export const useNotifications = (filters?: NotificationFilters) => {
  const params = new URLSearchParams();

  if (filters?.unreadOnly) params.append('unread_only', 'true');
  if (filters?.type) params.append('type', filters.type);
  if (filters?.limit) params.append('limit', filters.limit.toString());

  const url = `/api/v2/notifications?${params.toString()}`;

  const { data, error, isLoading, mutate } = useSWR<NotificationsResponse>(
    url,
    (url: string) => requestJson(url)
  );

  const markAsRead = async (notificationId: number) => {
    await requestJson(`/api/v2/notifications/${notificationId}/read`, {
      method: 'PATCH',
    });
    mutate(); // Refresh the list
  };

  const markAllAsRead = async () => {
    await requestJson('/api/v2/notifications/mark-all-read', {
      method: 'POST',
    });
    mutate(); // Refresh the list
  };

  const deleteNotification = async (notificationId: number) => {
    await requestJson(`/api/v2/notifications/${notificationId}`, {
      method: 'DELETE',
    });
    mutate(); // Refresh the list
  };

  return {
    notifications: data?.data ?? [],
    unreadCount: data?.meta?.unread_count ?? 0,
    total: data?.meta?.total ?? 0,
    loading: isLoading,
    error,
    refresh: mutate,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  };
};
