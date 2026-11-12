import useSWR from 'swr';
import { fetchInvitationCatalog, invitationSummary, INVITATIONS_CACHE_KEY } from '../lib/invitations';

export const useInviteSummary = () => {
  const { data, error, isLoading } = useSWR(INVITATIONS_CACHE_KEY, fetchInvitationCatalog, { revalidateOnFocus: false, refreshInterval: 60_000 });
  return { summary: data ? invitationSummary(data) : undefined, loading: isLoading, error };
};
