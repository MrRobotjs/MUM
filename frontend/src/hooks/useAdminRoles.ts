import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type AdminPermission = {
  id: number;
  name: string;
  description: string | null;
};

export type AdminRole = {
  id: string;
  name: string;
  description: string | null;
  position: number;
  color: string | null;
  icon: string | null;
  is_staff_role: boolean;
  is_auto_managed: boolean;
  permissions?: AdminPermission[];
  user_count?: number;
  users?: Array<{
    uuid: string;
    username: string;
    user_type: string;
  }>;
};

type AdminRolesResponse = {
  data: AdminRole[];
  meta: {
    request_id: string;
  };
};

type AdminPermissionsResponse = {
  data: AdminPermission[];
  meta: {
    request_id: string;
  };
};

export const useAdminRoles = (includePermissions = false, includeUsers = false) => {
  const params = new URLSearchParams();
  if (includePermissions) params.append('include_permissions', 'true');
  if (includeUsers) params.append('include_users', 'true');

  const url = `/admin/api/v2/admin-roles${params.toString() ? `?${params.toString()}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<AdminRolesResponse>(
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

export const useAdminPermissions = () => {
  const { data, error, isLoading } = useSWR<AdminPermissionsResponse>(
    '/admin/api/v2/admin-permissions',
    (url: string) => requestJson(url)
  );

  return {
    permissions: data?.data ?? [],
    loading: isLoading,
    error,
  };
};

export const useAdminRoleDetail = (roleId?: string) => {
  const url = roleId
    ? `/admin/api/v2/admin-roles/${roleId}`
    : null;

  const { data, error, isLoading, mutate } = useSWR(
    url,
    (url: string) => requestJson(url)
  );

  return {
    role: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
