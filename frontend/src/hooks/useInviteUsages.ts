import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

export type InviteUsageItem = {
  id: number;
  invite_id: number;
  used_at: string | null;
  ip_address: string | null;
  plex_username: string | null;
  plex_email: string | null;
  discord_username: string | null;
  discord_user_id: string | null;
  accepted_invite: boolean;
  status_message: string | null;
  user_uuid: string | null;
  plex_auth_successful: boolean;
  discord_auth_successful: boolean;
};

export type InviteUsageSummary = {
  total: number;
  accepted: number;
  pending: number;
  plex_auth_successful: number;
  discord_auth_successful: number;
  last_used_at: string | null;
};

export type InviteUsagesResponse = {
  data: {
    items: InviteUsageItem[];
    summary: InviteUsageSummary;
  };
  meta: {
    pagination: {
      page: number;
      page_size: number;
      total_items: number;
      total_pages: number;
    };
  };
};

export const useInviteUsages = (
  inviteId: number | null,
  page: number = 1,
  pageSize: number = 5,
) => {
  const { data, error, isLoading, mutate } = useSWR<InviteUsagesResponse>(
    inviteId ? `/api/v2/invites/${inviteId}/usages?page=${page}&page_size=${pageSize}` : null,
    (url: string) => requestJson<InviteUsagesResponse>(url),
    { revalidateOnFocus: false },
  );

  return {
    usages: data?.data?.items ?? [],
    summary: data?.data?.summary,
    pagination: data?.meta?.pagination,
    loading: isLoading,
    error,
    mutate,
  };
};
