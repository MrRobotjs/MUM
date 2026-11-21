import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type GeneralSettings = {
  app_name: string;
  /** The address people outside the server's network use to reach MUM; "" when not set. */
  public_address: string;
  /** A sign-in ends after this many days without use. */
  session_idle_days: number;
  /** A sign-in ends this many days after it began, however active. */
  session_max_days: number;
  /** Whether this visit reached MUM over HTTPS as MUM sees it, and whether cookies are always marked secure. */
  sessions?: { https_detected: boolean; secure_cookies_forced: boolean };
};

export type DiscordSettings = {
  revision: number;
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
  // The Discord server's name, read from its invite link.
  guild_name?: string | null;
  server_invite_url: string | null;
  // Why the redirect address will not work, if it will not.
  redirect_problem?: 'missing' | 'not_https' | null;
  sign_in_enabled?: boolean;
  sign_in_admins?: boolean;
  // Whether invitations may require Discord sign-in and server membership.
  invite_ready?: boolean;
  membership_ready?: boolean;
  verified_at?: string | null;
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
    '/api/settings/general',
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
    '/api/settings/discord',
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
    '/api/settings/advanced',
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
    '/api/settings/user-accounts',
    (url: string) => requestJson<SettingsResponse<UserAccountSettings>>(url)
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
