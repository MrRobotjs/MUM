export type UserProfilePathInput = {
  uuid: string;
  username?: string | null;
  server_nickname?: string | null;
};

const encodeSegment = (value?: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const encoded = encodeURIComponent(trimmed);
  // Keep plus signs readable since they're common in server nicknames.
  return encoded.replace(/%2B/gi, '+');
};

export const buildUserProfilePath = ({ uuid, username, server_nickname }: UserProfilePathInput) => {
  const serverSegment = encodeSegment(server_nickname);
  const usernameSegment = encodeSegment(username);

  if (serverSegment && usernameSegment) {
    return `/admin/users/${serverSegment}/${usernameSegment}`;
  }

  return `/admin/users/${uuid}`;
};
