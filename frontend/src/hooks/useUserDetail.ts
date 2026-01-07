import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type UserHistoryEntry = {
  id: number;
  timestamp?: string | null;
  event_type?: string | null;
  message?: string | null;
  details?: Record<string, unknown>;
};

export type UserRoleDetail = {
  name: string;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
};

export type UserDetail = {
  uuid: string;
  username?: string | null;
  display_name?: string | null;
  email?: string | null;
  user_type: string;
  local_username?: string | null;
  external_username?: string | null;
  external_email?: string | null;
  external_user_id?: string | null;
  external_user_alt_id?: string | null;
  created_at?: string | null;
  last_login_at?: string | null;
  last_activity_at?: string | null;
  service_join_date?: string | null;
  access_expires_at?: string | null;
  is_active: boolean;
  notes?: string | null;
  avatar_url?: string | null;
  discord_avatar_url?: string | null;
  discord_username?: string | null;
  discord_user_id?: string | null;
  discord_email?: string | null;
  service_type?: string | null;
  service_types: string[];
  server_nickname?: string | null;
  server_names: string[];
  linked_local_user?: {
    uuid: string;
    username?: string | null;
    display_name?: string | null;
    email?: string | null;
  } | null;
  libraries: string[];
  has_all_libraries: boolean;
  allow_downloads: boolean;
  allow_4k_transcode: boolean;
  is_purge_whitelisted: boolean;
  is_discord_bot_whitelisted: boolean;
  is_home_user: boolean;
  shares_back: boolean;
  has_password: boolean;
  used_invite: boolean;
  force_password_change: boolean;
  stream_stats: {
    global?: {
      plays_24h?: number;
      duration_24h?: string;
      plays_7d?: number;
      duration_7d?: string;
      plays_30d?: number;
      duration_30d?: string;
      all_time_plays?: number;
      all_time_duration?: string;
      all_time_duration_seconds?: number;
    };
    players?: Array<{ name?: string; plays?: number }>;
  };
  total_plays: number;
  total_duration_seconds: number;
  roles: {
    admin_roles: string[];
    user_roles: string[];
  };
  admin_roles_detail?: UserRoleDetail[];
  user_roles_detail: UserRoleDetail[];
  service_accounts: Array<{
    uuid: string;
    service_type?: string | null;
    server_name?: string | null;
    external_username?: string | null;
    external_email?: string | null;
    linked_at?: string | null;
  }>;
  history: UserHistoryEntry[];
};

type UserDetailResponse = {
  data: UserDetail;
};

const normalizeUserDetail = (detail: UserDetail): UserDetail => ({
  ...detail,
  service_types: detail.service_types ?? [],
  server_names: detail.server_names ?? [],
  libraries: detail.libraries ?? [],
  stream_stats: detail.stream_stats ?? { global: {}, players: [] },
  service_accounts: detail.service_accounts ?? [],
  history: detail.history ?? [],
  admin_roles_detail: detail.admin_roles_detail ?? [],
  user_roles_detail: detail.user_roles_detail ?? []
});

export const useUserDetail = (uuid?: string) => {
  const shouldFetch = Boolean(uuid);
  const { data, error, isLoading, mutate } = useSWR<UserDetailResponse>(
    shouldFetch ? `/admin/api/v2/users/${uuid}` : null,
    (url: string) => requestJson<UserDetailResponse>(url),
    { revalidateOnFocus: false }
  );

  const user = data?.data ? normalizeUserDetail(data.data) : null;

  console.log('[useUserDetail]', {
    uuid,
    hasData: !!data,
    historyLength: user?.history?.length ?? 0,
    history: user?.history,
    error,
    isLoading
  });

  return {
    user,
    loading: isLoading,
    error,
    refresh: mutate
  };
};
