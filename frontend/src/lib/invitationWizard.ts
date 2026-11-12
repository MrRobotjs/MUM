import { invitationCredentialError } from './invitationConstraints';
import { isServiceType } from '../config/serviceTypes';
import type { WizardState } from './invitationWizardTypes';

export type PublicInvitation = {
  id: number;
  revision: number;
  expires_at: string | null;
  max_uses: number | null;
  current_uses: number;
  reserved_uses: number;
  servers: { id: number; name: string; provider: string; access_url: string; libraries: { id: string; name: string }[] }[];
  grants: { server_id: number; all_libraries: boolean; library_ids: string[]; allow_downloads: boolean }[];
  discord: { required: boolean; requires_guild: boolean; available: boolean; invite_url: string | null };
};
export type DiscordProof = { authorization_id: string; status: 'pending' | 'exchanging' | 'verified' | 'consumed' | 'failed' | 'expired'; error_code: string | null;
  user: { id: string; username: string; avatar: string | null } | null; guild_verified: boolean | null; invite_url: string | null };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type DraftAccount = {
  username: string; email: string; password: string; confirm_password: string;
  use_same_username: boolean; use_same_email: boolean; use_same_password: boolean;
};
type Credentials = { username: string; email: string; password: string; password_confirm: string };
export type RedemptionReceipt = {
  id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; requires_review: boolean;
  steps: { server_id: number; status: string; stage: string; error_code?: string }[];
};
type RedemptionRequest = {
  invitation_revision: number;
  request_id: string; username: string; password: string; email: string;
  server_credentials: { server_id: number; username: string; password: string }[];
  discord_authorization_id?: string;
  plex_authorization_id?: string;
};
// The invitee's Plex sign-in for this invitation (bound to this browser by an
// HttpOnly cookie). MUM shares the invited libraries with this Plex account.
export type PlexProof = { id: string; status: 'pending' | 'verified' | 'confirmed'; account: { id: string; username: string } | null };
type SavedAttempt = { version: 1; requestID: string; invitation: PublicInvitation };

function storagePort(): StoragePort | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}
const storageKey = (token: string) => `mum.invitation.attempt.${token}`;
function newRequestID() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const validPassword = (value: string) => new TextEncoder().encode(value).length >= 12 && new TextEncoder().encode(value).length <= 1024;
const validUsername = (value: string) => value.trim().length > 0 && new TextEncoder().encode(value.trim()).length <= 255;

// Cache an explicit public allowlist. Never persist profile/server credentials,
// email addresses, passwords, hashes, receipts or authenticated response bodies.
function publicSnapshot(value: unknown): PublicInvitation {
  const v = value as PublicInvitation;
  if (!v || !Number.isSafeInteger(v.id) || v.id < 1 || !Number.isSafeInteger(v.revision) || v.revision < 1 || (v.expires_at !== null && !Number.isFinite(Date.parse(v.expires_at))) ||
      (v.max_uses !== null && (!Number.isInteger(v.max_uses) || v.max_uses < 1)) || !Number.isInteger(v.current_uses) || !Number.isInteger(v.reserved_uses) ||
      !Array.isArray(v.servers) || !v.servers.length || v.servers.length > 20 || !Array.isArray(v.grants) || v.grants.length !== v.servers.length) {
    throw new Error('Invalid invitation response');
  }
  const seen = new Set<number>();
  const servers = v.servers.map(s => {
    if (!Number.isSafeInteger(s.id) || s.id < 1 || seen.has(s.id) || typeof s.name !== 'string' || !isServiceType(s.provider) || !Array.isArray(s.libraries)) throw new Error('Unsupported invitation server');
    seen.add(s.id);
    let access_url = '';
    if (s.access_url) {
      const url = new URL(s.access_url);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) access_url = url.href;
    }
    const libraries = s.libraries.map(l => {
      if (typeof l.id !== 'string' || !l.id || typeof l.name !== 'string') throw new Error('Invalid invitation library');
      return { id: l.id, name: l.name };
    });
    return { id: s.id, name: s.name, provider: s.provider, access_url, libraries };
  });
  const granted = new Set<number>();
  const grants = v.grants.map(g => {
    if (!seen.has(g.server_id) || granted.has(g.server_id) || typeof g.all_libraries !== 'boolean' || typeof g.allow_downloads !== 'boolean' ||
        !Array.isArray(g.library_ids) || g.library_ids.some(id => typeof id !== 'string' || !id) ||
        g.all_libraries && g.library_ids.length > 0 || !g.all_libraries && g.library_ids.length === 0) throw new Error('Invalid invitation grant');
    const provider = servers.find(server => server.id === g.server_id)!.provider;
    if (provider === 'romm' && (!g.all_libraries || g.library_ids.length || !g.allow_downloads)) throw new Error('RomM requires explicit all-platform access including downloads');
    if (provider === 'kavita' && (g.all_libraries || g.library_ids.some(id => !/^[1-9]\d*$/.test(id) || Number(id) > 2147483647))) throw new Error('Kavita requires selected libraries with valid IDs');
    if (new Set(g.library_ids).size !== g.library_ids.length) throw new Error('Invalid invitation grant');
    granted.add(g.server_id);
    return { server_id: g.server_id, all_libraries: g.all_libraries, library_ids: [...g.library_ids], allow_downloads: g.allow_downloads };
  });
  const d = (v as { discord?: unknown }).discord as PublicInvitation['discord'] | undefined;
  if (!d || typeof d.required !== 'boolean' || typeof d.requires_guild !== 'boolean' || typeof d.available !== 'boolean' || d.requires_guild && !d.required ||
      d.invite_url !== null && !(typeof d.invite_url === 'string' && /^https:\/\/(discord\.gg\/|discord\.com\/invite\/)[A-Za-z0-9-]+$/.test(d.invite_url))) throw new Error('Invalid invitation Discord requirement');
  const discord = { required: d.required, requires_guild: d.requires_guild, available: d.available, invite_url: d.invite_url };
  return { id: v.id, revision: v.revision, expires_at: v.expires_at, max_uses: v.max_uses, current_uses: v.current_uses, reserved_uses: v.reserved_uses, servers, grants, discord };
}

const discordStatuses = ['pending', 'exchanging', 'verified', 'consumed', 'failed', 'expired'];
function discordProof(value: unknown): DiscordProof {
  const p = value as DiscordProof;
  if (!p || typeof p.authorization_id !== 'string' || !/^[0-9a-f-]{36}$/.test(p.authorization_id) || !discordStatuses.includes(p.status) ||
      p.error_code !== null && !(typeof p.error_code === 'string' && /^[A-Z_]{1,64}$/.test(p.error_code)) || p.guild_verified !== null && typeof p.guild_verified !== 'boolean' ||
      p.invite_url !== null && typeof p.invite_url !== 'string') throw new Error('Invalid Discord sign-in status');
  let user: DiscordProof['user'] = null;
  if (p.user !== null) {
    const u = p.user;
    if (!u || typeof u.id !== 'string' || !/^\d{17,20}$/.test(u.id) || typeof u.username !== 'string' || !u.username || u.username.length > 64 || u.avatar !== null && !(typeof u.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(u.avatar))) throw new Error('Invalid Discord sign-in status');
    user = { id: u.id, username: u.username, avatar: u.avatar };
  }
  if ((p.status === 'verified' || p.status === 'consumed') !== (user !== null)) throw new Error('Invalid Discord sign-in status');
  return { authorization_id: p.authorization_id, status: p.status, error_code: p.error_code, user, guild_verified: p.guild_verified, invite_url: p.invite_url };
}
function plexProof(value: unknown): PlexProof {
  const p = value as PlexProof;
  if (!p || typeof p.id !== 'string' || !/^[0-9a-f-]{36}$/.test(p.id) || !['pending', 'verified', 'confirmed'].includes(p.status)) throw new Error('Invalid Plex sign-in status');
  let account: PlexProof['account'] = null;
  if (p.account !== undefined && p.account !== null) {
    const a = p.account;
    if (!a || typeof a.id !== 'string' || !/^[1-9]\d{0,18}$/.test(a.id) || typeof a.username !== 'string' || !a.username || a.username.length > 255) throw new Error('Invalid Plex sign-in status');
    account = { id: a.id, username: a.username };
  }
  if ((p.status !== 'pending') !== (account !== null)) throw new Error('Invalid Plex sign-in status');
  return { id: p.id, status: p.status, account };
}
const discordMessages: Record<string, string> = { DISCORD_GUILD_REQUIRED: 'Join the required Discord server, then sign in again.', DISCORD_DENIED: 'Discord sign-in was cancelled.',
  INVITATION_CHANGED: 'The invitation changed during sign-in. Sign in again.' };

function savedAttempt(token: string, storage?: StoragePort): SavedAttempt | undefined {
  try {
    const saved = JSON.parse(storage?.getItem(storageKey(token)) ?? 'null') as SavedAttempt | null;
    if (saved?.version === 1 && typeof saved.requestID === 'string' && /^[0-9a-f-]{36}$/i.test(saved.requestID)) {
      return { version: 1, requestID: saved.requestID, invitation: publicSnapshot(saved.invitation) };
    }
  } catch { /* Untrusted or unavailable browser storage is never authoritative. */ }
  return undefined;
}

// Discord-bound requests send the HttpOnly browser-binding cookie; others omit cookies.
async function publicRequest<T>(token: string, suffix = '', body?: object, bound = false): Promise<T> {
  const response = await fetch(`/api/public/invitations/${encodeURIComponent(token)}${suffix}`, {
    method: body ? 'POST' : 'GET', credentials: bound ? 'same-origin' : 'omit', mode: 'same-origin', redirect: 'error',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Unable to load invitation') as Error & { status: number; code?: string };
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload?.data as T;
}

// A custom invite path (Flask feature) is resolved to the invitation's link
// code; every later request uses the code.
export async function resolveInvitationToken(value: string): Promise<string> {
  const response = await fetch(`/api/public/invitation-paths/${encodeURIComponent(value)}`, { headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => null) as { data?: { token?: unknown } } | null;
  const token = payload?.data?.token;
  if (!response.ok || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Object.assign(new Error('Invitation not found'), { status: response.status || 404 });
  return token;
}

// The address may hold the link code or a custom path. It is tried as a code
// first; only "not found" falls back to resolving a custom path.
export async function loadPublicInvitation(value: string, storage = storagePort()): Promise<InvitationDraft> {
  try {
    return await loadPublicInvitationByToken(value, storage);
  } catch (error) {
    if ((error as { status?: number }).status !== 404 || !/^[A-Za-z0-9_-]{3,100}$/.test(value) || value.length === 43) throw error;
    return loadPublicInvitationByToken(await resolveInvitationToken(value), storage);
  }
}

async function loadPublicInvitationByToken(token: string, storage: StoragePort | undefined): Promise<InvitationDraft> {
  const saved = savedAttempt(token, storage);
  try {
    const current = publicSnapshot(await publicRequest(token));
    const draft = new InvitationDraft(token, saved?.invitation.id === current.id ? saved.invitation : current, storage, saved?.requestID, Boolean(saved));
    if (current.discord.required) await draft.refreshDiscord();
    return draft;
  } catch (error) {
    // A reserved/consumed/revoked invitation can still return an existing receipt
    // after credentials are re-entered. Cached metadata cannot authorize work.
    if ((error as { status?: number }).status === 410 && saved) return new InvitationDraft(token, saved.invitation, storage, saved.requestID, true);
    throw error;
  }
}

export class InvitationDraft {
  private account?: DraftAccount;
  private credentials = new Map<number, Credentials>();
  private frozen?: RedemptionRequest;
  private pending?: Promise<RedemptionReceipt>;
  private requestID: string;
	private uncertain: boolean;
  private discord: DiscordProof | null = null;
  private plex: PlexProof | null = null;

  constructor(private token: string, private invitation: PublicInvitation, private storage = storagePort(), requestID?: string, readonly recovering = false) {
    this.invitation = publicSnapshot(invitation);
    this.requestID = requestID ?? newRequestID();
    this.uncertain = recovering;
  }

  // Reads this browser's proof; a missing proof simply means not signed in yet.
  async refreshDiscord() {
    try { this.discord = discordProof(await publicRequest(this.token, '/discord-authorization', undefined, true)); }
    catch (error) { if ((error as { status?: number }).status === 404) this.discord = null; else throw error; }
  }

  // Starting sends the browser to Discord; it is offered before any details are typed.
  async startDiscord(): Promise<string> {
    this.mutable();
    if (!this.invitation.discord.required || !this.invitation.discord.available) throw new Error('Discord sign-in is not available for this invitation');
    const started = await publicRequest<{ authorization_id: string; redirect_url: string }>(this.token, '/discord-authorizations', { invitation_revision: this.invitation.revision }, true);
    const url = new URL(started.redirect_url);
    if (url.protocol !== 'https:' || url.host !== 'discord.com' || url.pathname !== '/oauth2/authorize' || !url.searchParams.get('state')) throw new Error('Invalid Discord sign-in address');
    return url.href;
  }

  private hasPlex() {
    return this.invitation.servers.some(server => server.provider === 'plex');
  }

  private plexConfirmed() {
    return this.plex?.status === 'confirmed' && this.plex.account !== null;
  }

  // Starts the invitee's Plex sign-in; the returned Plex address is opened for
  // them to approve, then pollPlex() completes it.
  async startPlex(): Promise<string> {
    this.mutable();
    if (!this.hasPlex()) throw new Error('This invitation does not include a Plex server');
    const started = await publicRequest<{ authorization_url?: unknown }>(this.token, '/plex-authorizations', { invitation_revision: this.invitation.revision }, true);
    const proof = plexProof(started);
    if (typeof started.authorization_url !== 'string') throw new Error('Invalid Plex sign-in address');
    const url = new URL(started.authorization_url);
    if (url.protocol !== 'https:' || url.host !== 'app.plex.tv' || url.pathname !== '/auth' || url.username || url.password) throw new Error('Invalid Plex sign-in address');
    this.plex = proof;
    return url.href;
  }

  // Checks whether the invitee approved the sign-in in Plex; once Plex reports
  // the account, it is confirmed for this invitation.
  async pollPlex(): Promise<'pending' | 'confirmed'> {
    this.mutable();
    if (!this.plex) throw new Error('Start the Plex sign-in first');
    if (this.plexConfirmed()) return 'confirmed';
    let proof = plexProof(await publicRequest(this.token, `/plex-authorizations/${this.plex.id}/poll`, {}, true));
    if (proof.status === 'verified' && proof.account) {
      proof = plexProof(await publicRequest(this.token, `/plex-authorizations/${proof.id}/confirm`, { invitation_revision: this.invitation.revision, expected_account_id: proof.account.id }, true));
    }
    if (proof.id !== this.plex.id) throw new Error('Invalid Plex sign-in status');
    this.plex = proof;
    return this.plexConfirmed() ? 'confirmed' : 'pending';
  }

  private discordVerified() {
    return this.discord?.status === 'verified' && this.discord.user !== null && (!this.invitation.discord.requires_guild || this.discord.guild_verified === true);
  }

  private mutable() {
    if (this.frozen) throw new Error('An attempt has already been submitted. Check its result with the saved details.');
  }

  saveAccount(account: DraftAccount) {
    this.mutable();
    if (!validUsername(account.username)) throw new Error('Enter a username of 1–255 bytes');
    if (!validPassword(account.password)) throw new Error('Password must contain 12–1024 bytes');
    if (account.password !== account.confirm_password) throw new Error('Passwords do not match');
    this.account = { ...account, username: account.username.trim(), email: account.email.trim() };
    // Changing shared choices invalidates prepared per-server details.
    this.credentials.clear();
  }

  formFor(serverID: number): Credentials {
    const saved = this.credentials.get(serverID);
    if (saved) return { ...saved };
    const a = this.account;
    const password = a?.use_same_password ? a.password : '';
    const email = a?.use_same_email ? a.email : '';
    const username = this.invitation.servers.find(server => server.id === serverID)?.provider === 'komga' ? email : a?.use_same_username ? a.username : '';
    return { username, email, password, password_confirm: password };
  }

  saveServer(serverID: number, value: Credentials) {
    this.mutable();
    const server = this.invitation.servers.find(s => s.id === serverID);
    if (!this.account || !server) throw new Error('Choose an invited server after setting up your account');
    const username = server.provider === 'komga' ? value.email.trim() : value.username.trim();
    const error = invitationCredentialError(server.provider, username, value.password);
    if (error) throw new Error(error);
    if (value.password !== value.password_confirm) throw new Error('Passwords do not match');
    this.credentials.set(serverID, { ...value, username, email: server.provider === 'komga' ? username : value.email });
  }

  view(): WizardState {
    const a = this.account;
    const servers = this.invitation.servers.map(s => {
      const grant = this.invitation.grants.find(g => g.server_id === s.id)!;
      const credentials = this.formFor(s.id);
      // Plex access comes from the invitee's Plex sign-in, not a username/password.
      const plex = s.provider === 'plex';
      return { id: s.id, name: s.name, service_type: s.provider.toUpperCase(), access_url: s.access_url,
        completed: plex ? this.plexConfirmed() : Boolean(a && !invitationCredentialError(s.provider, credentials.username, credentials.password)), all_libraries: grant.all_libraries,
        credentials: a && !plex ? { username: credentials.username, email: ['kavita','audiobookshelf','romm'].includes(s.provider) ? '' : credentials.email } : null, libraries: s.libraries,
        features: { allow_downloads: grant.allow_downloads, invite_to_plex_home: false, allow_live_tv: false, allow_4k_transcode: true } };
    });
    const discordRequired = this.invitation.discord.required;
    const steps = [...(discordRequired ? [{ id: 'discord', name: 'Discord', icon: 'discord', required: true, completed: this.discordVerified() }] : []),
      { id: 'user_account', name: 'Account', icon: 'user-plus', required: true, completed: Boolean(a) },
      // One Plex sign-in step covers the invitation's Plex server, as in Flask.
      ...(this.hasPlex() ? [{ id: 'plex', name: `${servers.find(s => s.service_type === 'PLEX')!.name} Access`, icon: 'plex', required: true, completed: this.plexConfirmed() }] : []),
      ...servers.filter(s => s.service_type !== 'PLEX').map(s => ({ id: `server_access_${s.id}`, name: s.name, icon: 'server', required: true, completed: s.completed, server_id: s.id, server_name: s.name, server_type: s.service_type }))];
    return {
      invite: { id: this.invitation.id, token: this.token, custom_path: null, expires_at: this.invitation.expires_at,
        max_uses: this.invitation.max_uses, current_uses: this.invitation.current_uses + this.invitation.reserved_uses,
        is_active: true, is_paused: false, allow_downloads: this.invitation.grants.some(g => g.allow_downloads),
        invite_to_plex_home: false, allow_live_tv: false, allow_4k_transcode: true, membership_duration_days: null,
        grant_library_ids: this.invitation.grants.flatMap(g => g.library_ids.map(id => `${g.server_id}::${id}`)),
        require_discord_auth: discordRequired, require_discord_guild_membership: this.invitation.discord.requires_guild, server_count: servers.length,
        effective_server_count: servers.length, disabled_server_count: 0 },
      steps, next_step_id: steps.find(s => !s.completed)?.id ?? null,
      plex: { has_plex_servers: this.hasPlex(), authenticated: this.plexConfirmed(), user: this.plexConfirmed() && this.plex?.account ? { username: this.plex.account.username } : null, conflict: null },
      discord: { oauth_enabled: discordRequired && this.invitation.discord.available, requires_auth: discordRequired, requires_guild: this.invitation.discord.requires_guild,
        authenticated: this.discordVerified(), user: this.discordVerified() && this.discord?.user ? { id: this.discord.user.id, username: this.discord.user.username, avatar: this.discord.user.avatar } : null,
        invite_url: this.discord?.invite_url ?? this.invitation.discord.invite_url, guild_verified: this.discord?.guild_verified ?? null,
        guild_error: this.discord?.status === 'failed' ? discordMessages[this.discord.error_code ?? ''] ?? 'Discord sign-in failed. Try again.' : this.discord?.status === 'expired' ? 'Discord sign-in expired. Sign in again.' : null },
      account: { allowed: true, completed: Boolean(a), data: a ? { username: a.username, email: a.email } : null,
        preferences: { use_same_username: a?.use_same_username ?? true, use_same_email: a?.use_same_email ?? true, use_same_password: a?.use_same_password ?? true } },
      servers, disabled_servers: [], meta: { server_label: servers.length === 1 ? 'server' : 'servers', has_multiple_servers: servers.length > 1 },
    };
  }

  redeem(): Promise<RedemptionReceipt> {
    if (this.pending) return this.pending;
    if (!this.frozen) {
      if (!this.account || this.view().steps.some(s => s.required && !s.completed)) return Promise.reject(new Error('Complete your account and every server first'));
      this.frozen = { invitation_revision: this.invitation.revision, request_id: this.requestID, username: this.account.username, password: this.account.password, email: this.account.email,
        server_credentials: this.invitation.servers.filter(s => s.provider !== 'plex').map(s => { const c = this.formFor(s.id); return { server_id: s.id, username: c.username, password: c.password }; }),
        ...(this.invitation.discord.required && this.discord ? { discord_authorization_id: this.discord.authorization_id } : {}),
        ...(this.hasPlex() && this.plex ? { plex_authorization_id: this.plex.id } : {}) };
      try { this.storage?.setItem(storageKey(this.token), JSON.stringify({ version: 1, requestID: this.requestID, invitation: publicSnapshot(this.invitation) } satisfies SavedAttempt)); } catch { /* In-tab retries still use the frozen request. */ }
    }
    // Discord and Plex sign-ins are bound to this browser by HttpOnly cookies.
    this.pending = publicRequest<RedemptionReceipt>(this.token, '/redeem', this.frozen, this.invitation.discord.required || this.hasPlex()).then(receipt => {
      if (receipt && typeof receipt === 'object' && ('plex_progress' in receipt || Array.isArray(receipt.steps) && receipt.steps.some(step => step && typeof step === 'object' && 'plex' in step))) throw new Error('Plex receipts require the dedicated pending flow; public Plex provisioning is not enabled.');
      if (!receipt || typeof receipt.id !== 'string' || !['running', 'completed', 'failed', 'cancelled'].includes(receipt.status) || typeof receipt.requires_review !== 'boolean' || !Array.isArray(receipt.steps) ||
          receipt.steps.length !== this.invitation.servers.length || new Set(receipt.steps.map(s => s.server_id)).size !== receipt.steps.length ||
          receipt.steps.some(s => !this.invitation.servers.some(server => server.id === s.server_id)) || receipt.status === 'failed' && !receipt.requires_review || receipt.status === 'cancelled' && receipt.requires_review ||
          receipt.status === 'completed' && (receipt.requires_review || receipt.steps.length !== this.invitation.servers.length || receipt.steps.some(s => s.status !== 'completed'))) throw new Error('Invalid provisioning receipt; keep this tab open and check again');
      this.uncertain=true;
      return receipt;
    }).catch(error => {
      const rejected=error as {status?:number;code?:string};
      const notReserved = rejected.status===400 && ['INVALID_EMAIL','INVALID_REDEMPTION','INVALID_CREDENTIALS','INVALID_REVISION','INVALID_BODY','INVALID_KAVITA_CREDENTIALS','INVALID_AUDIOBOOKSHELF_CREDENTIALS','INVALID_KOMGA_CREDENTIALS','DISCORD_AUTH_REQUIRED','DISCORD_ACCOUNT_IN_USE','PLEX_AUTH_REQUIRED'].includes(rejected.code ?? '') || rejected.status===409 && rejected.code==='PLEX_ACCOUNT_IN_USE' || rejected.status===409 && rejected.code==='USERNAME_UNAVAILABLE';
      if (!this.uncertain && notReserved) {
        this.frozen=undefined;
        try { this.storage?.setItem(storageKey(this.token),'null'); } catch { /* Storage is optional. */ }
      } else { this.uncertain=true; }
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
