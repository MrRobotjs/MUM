import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type GeneralSettings = {
  app_name: string;
  app_url: string;
  require_email: boolean;
  auto_approve_invites: boolean;
};

export type DiscordSettings = {
  enabled: boolean;
  client_id: string;
  client_secret?: string;
  bot_token?: string;
  guild_id: string;
  redirect_uri: string;
};

export type AdvancedSettings = {
  api_timeout_seconds: number;
};

type SettingsResponse<T> = {
  data: T;
  meta: {
    request_id: string;
  };
};

export const useGeneralSettings = () => {
  const { data, error, isLoading, mutate } = useSWR<SettingsResponse<GeneralSettings>>(
    '/admin/api/v2/settings/general',
    (url: string) => requestJson(url)
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
    '/admin/api/v2/settings/discord',
    (url: string) => requestJson(url)
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
    '/admin/api/v2/settings/advanced',
    (url: string) => requestJson(url)
  );

  return {
    settings: data?.data ?? null,
    loading: isLoading,
    error,
    refresh: mutate,
  };
};
