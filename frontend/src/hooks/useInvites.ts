import useSWR from 'swr';
import { fetchInvitationCatalog, filterInvitations, INVITATIONS_CACHE_KEY } from '../lib/invitations';

type InviteFilters = { status?: string; page?: number; pageSize?: number; search?: string; serverId?: number };
export const useInvites = (filters: InviteFilters = {}) => {
  const { data, error, isLoading, mutate } = useSWR(INVITATIONS_CACHE_KEY, fetchInvitationCatalog, { revalidateOnFocus: false });
  const result = data ? filterInvitations(data, filters) : { invites: [], pagination: undefined };
  return { ...result, loading: isLoading, error, refresh: mutate };
};
