import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type InviteSummaryCounts = {
  total: number;
  active: number;
  inactive: number;
  expired: number;
  maxed: number;
  usable: number;
};

type InviteSummaryItem = {
  id: number;
  token: string;
  custom_path?: string | null;
  created_at?: string | null;
  is_active: boolean;
  is_expired: boolean;
  has_reached_max_uses: boolean;
  current_uses: number;
  max_uses?: number | null;
};

type InviteSummaryUsage = {
  id: number;
  invite_id: number;
  used_at?: string | null;
  accepted_invite: boolean;
  plex_username?: string | null;
  discord_username?: string | null;
  status_message?: string | null;
};

type InviteSummaryResponse = {
  data: {
    counts: InviteSummaryCounts;
    recent_invites: InviteSummaryItem[];
    recent_usages: InviteSummaryUsage[];
  };
};

export const useInviteSummary = () => {
  const { data, error, isLoading } = useSWR<InviteSummaryResponse>(
    '/api/v2/invites/summary',
    (url: string) => requestJson<InviteSummaryResponse>(url),
    {
      revalidateOnFocus: false,
      refreshInterval: 60_000
    }
  );

  return {
    summary: data?.data,
    loading: isLoading,
    error
  };
};

export type { InviteSummaryCounts, InviteSummaryItem, InviteSummaryUsage };
