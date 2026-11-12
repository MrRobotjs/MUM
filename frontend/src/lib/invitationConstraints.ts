export function invitationServerLimits(provider: string) {
  switch (provider.toLowerCase()) {
    case 'romm':
      return { asciiOnly: true, passwordMaxBytes: 72, usernameWithoutAt: true, allLibraries: true, emailIdentity: false };
    case 'komga':
      return { asciiOnly: false, passwordMaxBytes: 72, usernameWithoutAt: false, allLibraries: true, emailIdentity: true };
    case 'kavita':
      return { asciiOnly: false, passwordMaxBytes: 256, usernameWithoutAt: true, allLibraries: false, emailIdentity: false };
    case 'audiobookshelf':
      return { asciiOnly: false, passwordMaxBytes: 72, usernameWithoutAt: false, allLibraries: true, emailIdentity: false };
    case 'jellyfin':
    case 'emby':
      return { asciiOnly: false, passwordMaxBytes: 1024, usernameWithoutAt: false, allLibraries: true, emailIdentity: false };
    case 'plex':
      // Plex access comes from the invitee's Plex sign-in, so no username or
      // password is ever typed for it; selected or all libraries are allowed.
      return { asciiOnly: false, passwordMaxBytes: 1024, usernameWithoutAt: false, allLibraries: true, emailIdentity: false };
    default:
      throw new Error('Unsupported invitation server');
  }
}

export function invitationCredentialError(provider: string, username: string, password: string): string | null {
  const limits = invitationServerLimits(provider);
  const nameBytes = new TextEncoder().encode(username.trim()).length;
  if (nameBytes < 1 || nameBytes > 255) return 'Enter a username of 1–255 bytes';
  if (limits.asciiOnly && (!/^[a-z0-9_-]{3,255}$/.test(username.trim()) || !/^[\x20-\x7e]{12,72}$/.test(password) || !password.trim())) return 'RomM requires an ASCII username of 3–255 characters using a–z, digits, underscores or hyphens and a printable ASCII password of 12–72 bytes';
  if (limits.emailIdentity && !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(username.trim())) return 'Komga requires a valid email identity';
  if (limits.usernameWithoutAt && username.includes('@')) return 'Kavita requires a username without @';
  const bytes = new TextEncoder().encode(password).length;
  if (bytes < 12 || bytes > limits.passwordMaxBytes) return `Password must contain 12–${limits.passwordMaxBytes} bytes for this server`;
  return null;
}
