import useSWRInfinite from 'swr/infinite';
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

export const useUsers = (filters: UsersFilters = {}) => {
  const getKey = (pageIndex: number, previousPageData: UsersResponse | null) => {
    if (previousPageData && previousPageData.meta.pagination.page >= previousPageData.meta.pagination.total_pages) {
      return null;
    }

    const page = pageIndex + 1;
    const params = new URLSearchParams({ page: String(page) });
    if (filters.search) params.set('search', filters.search);
    if (filters.userType) params.set('user_type', filters.userType);
    if (filters.role) params.set('role', filters.role);
    if (filters.sort) params.set('sort', filters.sort);

    return `/api/v2/users?${params.toString()}`;
  };

  const { data, error, size, setSize, isLoading, mutate } = useSWRInfinite<UsersResponse>(
    getKey,
    (url: string) => requestJson<UsersResponse>(url),
    {
      revalidateOnFocus: false
    }
  );

  const users = data ? data.flatMap((page) => page.data) : [];
  const pagination = data?.[data.length - 1]?.meta.pagination;

  return {
    users,
    error,
    loading: isLoading && !data,
    size,
    setSize,
    mutate,
    hasMore: pagination ? pagination.page < pagination.total_pages : false
  };
};
