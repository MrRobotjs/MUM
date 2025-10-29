import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type UserRole = {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
  user_count?: number;
};

type UserRolesResponse = {
  data: UserRole[];
  meta: {
    request_id: string;
  };
};

export const useUserRoles = (includeUsers = false) => {
  const params = new URLSearchParams();
  if (includeUsers) params.append('include_users', 'true');

  const url = `/admin/api/v2/user-roles${params.toString() ? `?${params.toString()}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<UserRolesResponse>(
    url,
    (url: string) => requestJson(url)
  );

  return {
    roles: data?.data ?? [],
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
