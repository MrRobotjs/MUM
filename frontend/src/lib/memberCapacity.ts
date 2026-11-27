// Member limits of services that have one (Plex: 99 members besides the owner,
// 14 of them in Plex Home). The server reports each count against its limit.

export type CapacityState = 'open' | 'nearly_full' | 'full';
export type MemberCapacity = Readonly<{
  members: number; limit: number; home_members: number; home_limit: number; state: CapacityState; home_state: CapacityState;
}>;

const states: readonly CapacityState[] = ['open', 'nearly_full', 'full'];
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Reads a server's member_capacity; null for services without a limit or a malformed value. */
export function readMemberCapacity(value: unknown): MemberCapacity | null {
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || !count(v.members) || !count(v.limit) || v.limit < 1 || !count(v.home_members) || !count(v.home_limit) || v.home_limit < 1
    || !states.includes(v.state as CapacityState) || !states.includes(v.home_state as CapacityState)) return null;
  return Object.freeze({ members: v.members, limit: v.limit, home_members: v.home_members, home_limit: v.home_limit, state: v.state as CapacityState, home_state: v.home_state as CapacityState });
}

export const memberCapacityLabel = (c: MemberCapacity) => `${c.state === 'full' ? 'Full ' : ''}${Math.min(c.members, c.limit)}/${c.limit} members`;
export const homeCapacityLabel = (c: MemberCapacity) => `Home ${Math.min(c.home_members, c.home_limit)}/${c.home_limit}`;

/** The more serious of the member and Plex Home states. */
export const worstCapacityState = (c: MemberCapacity): CapacityState =>
  c.state === 'full' || c.home_state === 'full' ? 'full' : c.state === 'nearly_full' || c.home_state === 'nearly_full' ? 'nearly_full' : 'open';

/** Text colour for a capacity state: amber when nearly full, the destructive colour when full. */
export const capacityTone = (state: CapacityState) => state === 'full' ? 'text-destructive' : state === 'nearly_full' ? 'text-amber-500' : 'text-muted-foreground';

const list = (names: string[]) => names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

type InvitedServer = { id?: number; server_nickname?: string | null; name?: string | null; member_capacity?: MemberCapacity | null; invite_to_plex_home?: boolean };

/** A server an invite can't add members to: full, or Plex Home full when the invite uses Plex Home. */
export const serverIsFullForInvite = (s: InvitedServer) => s.member_capacity?.state === 'full' || s.invite_to_plex_home === true && s.member_capacity?.home_state === 'full';

/** The warning shown when an invite includes full servers, or null. */
export function fullServersWarning(servers: readonly InvitedServer[]): string | null {
  const full = servers.filter(serverIsFullForInvite).map(s => s.member_capacity?.state === 'full' ? s.server_nickname || s.name || `Server #${s.id ?? ''}` : `Plex Home on ${s.server_nickname || s.name || `server #${s.id ?? ''}`}`);
  if (!full.length) return null;
  if (full.length === servers.length) return `${list(full)} ${full.length === 1 ? 'is' : 'are'} full, so no one can join with this invite right now.`;
  return full.length === 1
    ? `${full[0]} is full, so new members can’t join it. They can still join the other servers on this invite.`
    : `${list(full)} are full, so new members can’t join them. They can still join any other servers on this invite.`;
}
