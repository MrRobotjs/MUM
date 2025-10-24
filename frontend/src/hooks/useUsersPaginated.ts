import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type UsersFilters = {
  search?: string;
  userType?: string;
  role?: string;
  serverId?: string;
  filterType?: string;
  searchEmail?: string;
  searchUsername?: string;
  searchNotes?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
};

type UsersResponse = {
  data: Array<{
    uuid: string;
    username?: string;
    email?: string;
    user_type: string;
    display_name?: string;
    created_at?: string;
    last_streamed_at?: string | null;
    service_join_date?: string | null;
    last_login_at?: string;
    is_active: boolean;
    admin_roles: string[];
    user_roles: Array<{
      name: string;
      color?: string | null;
      description?: string | null;
      icon?: string | null;
    }>;
    linked_service_count: number;
    service_type?: string;
    server_nickname?: string;
    libraries?: string[];
    has_all_libraries?: boolean;
    linked_local_user?: {
      uuid: string;
      username?: string | null;
      display_name?: string | null;
    } | null;
  }>;
  meta: {
    pagination: {
      page: number;
      page_size: number;
      total_items: number;
      total_pages: number;
    };
  };
};

export const useUsersPaginated = (filters: UsersFilters = {}) => {
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;

  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize)
  });

  if (filters.search) params.set('search', filters.search);
  if (filters.userType) params.set('user_type', filters.userType);
  if (filters.role) params.set('role', filters.role);
  if (filters.serverId && filters.serverId !== 'all') params.set('server_id', filters.serverId);
  if (filters.filterType) params.set('filter_type', filters.filterType);
  if (filters.searchEmail) params.set('search_email', filters.searchEmail);
  if (filters.searchUsername) params.set('search_username', filters.searchUsername);
  if (filters.searchNotes) params.set('search_notes', filters.searchNotes);
  if (filters.sort) params.set('sort', filters.sort);

  const { data, error, isLoading, mutate } = useSWR<UsersResponse>(
    `/admin/api/v1/users?${params.toString()}`,
    (url: string) => requestJson<UsersResponse>(url),
    {
      revalidateOnFocus: false
    }
  );

  return {
    users: data?.data || [],
    pagination: data?.meta.pagination,
    error,
    loading: isLoading,
    mutate
  };
};
