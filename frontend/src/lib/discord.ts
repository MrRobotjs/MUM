const DISCORD_AVATAR_MIN_SIZE = 16;
const DISCORD_AVATAR_MAX_SIZE = 4096;
const DEFAULT_DISCORD_AVATAR_SIZE = 100;

type DiscordAvatarOptions = {
  userId?: string | null;
  avatarHash?: string | null;
  size?: number;
};

const isPowerOfTwo = (value: number) => (value & (value - 1)) === 0;

export const isDiscordAvatarSize = (size: number) =>
  Number.isInteger(size) &&
  size >= DISCORD_AVATAR_MIN_SIZE &&
  size <= DISCORD_AVATAR_MAX_SIZE &&
  isPowerOfTwo(size);

const normalizeDiscordAvatarSize = (size?: number) => {
  if (!Number.isFinite(size)) {
    return DEFAULT_DISCORD_AVATAR_SIZE;
  }

  const rounded = Math.round(size as number);
  return isDiscordAvatarSize(rounded) ? rounded : DEFAULT_DISCORD_AVATAR_SIZE;
};

export const buildDiscordAvatarUrl = ({ userId, avatarHash, size }: DiscordAvatarOptions) => {
  if (!userId || !avatarHash) {
    return null;
  }

  const extension = avatarHash.startsWith('a_') ? 'gif' : 'png';
  const resolvedSize = normalizeDiscordAvatarSize(size);
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=${resolvedSize}`;
};
