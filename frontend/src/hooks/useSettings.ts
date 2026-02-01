import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type GeneralSettings = {
  app_name: string;
  app_base_url: string;
  app_local_url?: string;
  enable_navbar_stream_badge: boolean;
  session_monitoring_interval: number;
  api_timeout_seconds: number;
  jwt_cookie_secure: boolean;
  // Legacy fields (deprecated but still sent by backend for compatibility)
  app_url?: string;
  require_email?: boolean;
  auto_approve_invites?: boolean;
};

export type DiscordSettings = {
  enable_oauth: boolean;
  client_id: string | null;
  client_secret_set: boolean;
  oauth_auth_url: string | null;
  redirect_uri_invite: string | null;
  redirect_uri_admin: string | null;
  default_require_discord_auth: boolean;
  default_require_discord_guild_membership: boolean;
  enable_membership_requirement: boolean;
  guild_id: string | null;
  server_invite_url: string | null;
  enable_bot: boolean;
  bot_token_set: boolean;
  monitored_role_id: string | null;
  thread_channel_id: string | null;
  bot_log_channel_id: string | null;
  whitelist_sharers: boolean;
  admin_linked: boolean;
  admin_user: {
    username: string | null;
    id: string | null;
    avatar: string | null;
  } | null;
};

export type AdvancedSettings = {
  api_timeout_seconds: number;
};

export type UserAccountSettings = {
  allow_user_accounts: boolean;
};

type SettingsResponse<T> = {
  data: T;
  meta: {
    request_id: string;
  };
};

export const useGeneralSettings = () => {
  const { data, error, isLoading, mutate } = useSWR<SettingsResponse<GeneralSettings>>(
    '/api/v2/settings/general',
    (url: string) => requestJson<SettingsResponse<GeneralSettings>>(url)
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};

export const useDiscordSettings = () => {
  const { data, error, isLoading, mutate } = useSWR<SettingsResponse<DiscordSettings>>(
    '/api/v2/settings/discord',
    (url: string) => requestJson<SettingsResponse<DiscordSettings>>(url)
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};

export const useAdvancedSettings = () => {
  const { data, error, isLoading, mutate } = useSWR<SettingsResponse<AdvancedSettings>>(
    '/api/v2/settings/advanced',
    (url: string) => requestJson<SettingsResponse<AdvancedSettings>>(url)
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};

export const useUserAccountSettings = () => {
  const { data, error, isLoading, mutate } = useSWR<SettingsResponse<UserAccountSettings>>(
    '/api/v2/settings/user-accounts',
    (url: string) => requestJson<SettingsResponse<UserAccountSettings>>(url)
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
