// A server's Overview wording (SERVER_OVERVIEW_DESIGN.md).

/**
 * One Availability line for a server: whether its server type is turned on
 * in Media Servers and whether the server itself is on. When both are off the
 * server type is named, since turning the server on alone wouldn't help.
 */
export function serverAvailability(server: { provider_enabled?: boolean | null; is_active?: boolean | null }, serviceLabel: string): { active: boolean; text: string } {
  if (server.provider_enabled === false) return { active: false, text: `Off: ${serviceLabel} is turned off in Media Servers` };
  if (server.is_active === false) return { active: false, text: 'Off: this server is turned off' };
  return { active: true, text: 'Active' };
}

/** The Connection tile's label; a server MUM hasn't checked isn't called offline. */
export function connectionLabel(online: boolean | null): 'Online' | 'Offline' | 'Not checked yet' {
  return online === null ? 'Not checked yet' : online ? 'Online' : 'Offline';
}
