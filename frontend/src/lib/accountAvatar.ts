// Pictures beside linked accounts (account page and the admin user page).
// The server signs a short-lived link to its own picture route for each
// account that has a picture; the browser never loads Plex, Discord or a
// media server directly. Anything else in a reply is refused.

export type AvatarRoute = 'service' | 'discord';

const patterns: Record<AvatarRoute, RegExp> = {
  service: /^\/api\/service-avatars\/[1-9][0-9]*\?[^#\s]+$/,
  discord: /^\/api\/discord-avatars\/[1-9][0-9]*\?[^#\s]+$/,
};

// avatarLink checks an optional picture link: null when absent.
export function avatarLink(value: unknown, route: AvatarRoute): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 2048 || !patterns[route].test(value)) throw new Error('Unexpected account picture link');
  return value;
}

// accountInitial is the letter shown when an account has no picture.
export function accountInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}
