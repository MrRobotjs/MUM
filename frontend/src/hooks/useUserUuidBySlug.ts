import { useMemo } from 'react';
import useSWR from 'swr';
import { requestJson } from '../util/apiClient';

type UsersLookupResponse = {
  data: Array<{
    uuid: string;
    username?: string | null;
    server_nickname?: string | null;
  }>;
};

const normalizeSegment = (value?: string | null) => (value ? value.trim().toLowerCase() : '');

export const useUserUuidBySlug = (serverNickname?: string, username?: string) => {
  const shouldFetch = Boolean(serverNickname && username);
  const lookupTerm = username?.trim() ?? '';

  const { data, error, isLoading } = useSWR<UsersLookupResponse>(
    shouldFetch ? `/admin/api/v1/users?search=${encodeURIComponent(lookupTerm)}&page_size=50` : null,
    (url: string) => requestJson<UsersLookupResponse>(url),
    { revalidateOnFocus: false }
  );

  const match = useMemo(() => {
    if (!shouldFetch || !data?.data) {
      return null;
    }

    const normalizedServer = normalizeSegment(serverNickname);
    const normalizedUsername = normalizeSegment(username);

    return (
      data.data.find(
        (item) =>
          normalizeSegment(item.server_nickname) === normalizedServer &&
          normalizeSegment(item.username) === normalizedUsername
      ) ?? null
    );
  }, [data, serverNickname, username, shouldFetch]);

  return {
    uuid: match?.uuid ?? null,
    user: match,
    loading: shouldFetch && isLoading,
    error
  };
};
