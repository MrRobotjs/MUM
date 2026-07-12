export const LIBRARY_TOKEN_SEPARATOR = '::';

export const getScopedLibraryToken = (serverId: number, libraryId: string): string =>
  `${serverId}${LIBRARY_TOKEN_SEPARATOR}${libraryId}`;

export const parseScopedLibraryToken = (
  token: string,
): { serverId: number; libraryId: string } | null => {
  const separatorIndex = token.indexOf(LIBRARY_TOKEN_SEPARATOR);
  if (separatorIndex <= 0) return null;

  const serverPart = token.slice(0, separatorIndex);
  const libraryPart = token.slice(separatorIndex + LIBRARY_TOKEN_SEPARATOR.length);
  if (!serverPart || !libraryPart || !/^\d+$/.test(serverPart)) return null;

  return { serverId: Number(serverPart), libraryId: libraryPart };
};

type LibraryLike = {
  id: string;
  server_name?: string | null;
};

type ServerLike = {
  id: number;
  server_nickname?: string | null;
  name?: string | null;
};

/** Normalize API library grants to v2 scoped tokens (`{server_id}::{library_id}`). */
export const resolveScopedLibraryTokens = (
  grantLibraryIds: string[] | undefined,
  libraries: LibraryLike[] | undefined,
  servers: ServerLike[] | undefined,
): string[] => {
  const scopedFromGrant = (grantLibraryIds ?? []).filter((token) =>
    Boolean(parseScopedLibraryToken(token)),
  );
  if (scopedFromGrant.length > 0) {
    return scopedFromGrant;
  }

  if (!libraries?.length || !servers?.length) {
    return [];
  }

  return libraries
    .map((library) => {
      const server = servers.find(
        (candidate) =>
          candidate.server_nickname === library.server_name ||
          candidate.name === library.server_name,
      );
      if (!server || !library.id) {
        return null;
      }
      return getScopedLibraryToken(server.id, String(library.id));
    })
    .filter((token): token is string => Boolean(token));
};
