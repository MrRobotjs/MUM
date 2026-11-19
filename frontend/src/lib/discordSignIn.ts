import { avatarLink } from './accountAvatar';
import { requestJson } from '../util/apiClient';

// Linking a Discord account and signing in with it.
// Every account links its own Discord account on the account page; with
// Discord sign-in on, a linked account signs in with it. MUM sends the browser
// only to Discord's own authorize page, and Discord sends it back to the
// account or login page with an outcome.

// avatarUrl: a signed link to the linked Discord account's picture, or null.
export type AccountDiscord = { available: boolean; linked: boolean; username: string | null; signIn: boolean; avatarUrl: string | null };
export type DiscordPage = 'login' | 'account';
export type DiscordOutcome = { kind: 'success' | 'error'; message: string } | null;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

export function parseAccountDiscord(value: unknown): AccountDiscord {
  const v = record(value);
  if (!v || typeof v.available !== 'boolean' || typeof v.linked !== 'boolean' || typeof v.sign_in !== 'boolean' || !(v.username === null || typeof v.username === 'string') ||
    v.linked !== (typeof v.username === 'string') || !v.linked && v.avatar_url !== undefined) throw new Error('Unexpected Discord account answer');
  return { available: v.available, linked: v.linked, username: v.username as string | null, signIn: v.sign_in, avatarUrl: avatarLink(v.avatar_url, 'discord') };
}

export async function getAccountDiscord(): Promise<AccountDiscord> {
  const { data } = await requestJson<{ data?: unknown }>('/api/account/discord');
  return parseAccountDiscord(data);
}

// Only Discord's own authorize page is followed.
function authorizeURL(value: unknown): string {
  const raw = record(value)?.redirect_url;
  if (typeof raw !== 'string') throw new Error('Unexpected Discord answer');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Unexpected Discord answer'); }
  if (url.protocol !== 'https:' || url.host !== 'discord.com' || url.pathname !== '/oauth2/authorize') throw new Error('Unexpected Discord answer');
  return raw;
}

// Each start is sent once; a refused start is reported, never repeated.
export async function startDiscordSignIn(remember: boolean): Promise<string> {
  const { data } = await requestJson<{ data?: unknown }>('/api/auth/discord', { method: 'POST', body: JSON.stringify({ remember }) });
  return authorizeURL(data);
}

export async function startDiscordLink(): Promise<string> {
  const { data } = await requestJson<{ data?: unknown }>('/api/account/discord', { method: 'POST', body: JSON.stringify({}) });
  return authorizeURL(data);
}

export async function unlinkDiscord(): Promise<void> {
  await requestJson('/api/account/discord', { method: 'DELETE' });
}

const loginMessages: Record<string, string> = {
  not_linked: "This Discord account isn't linked to a MUM account. Sign in another way, then link Discord on your account page.",
  password_required: 'This account signs in with its MUM password.',
  turned_off: 'Signing in with Discord is turned off.',
  denied: 'Discord sign-in was cancelled.',
  not_allowed: "This account can't sign in right now.",
};
const accountMessages: Record<string, string> = {
  in_use: 'That Discord account is already linked to another MUM account.',
  denied: 'Linking was cancelled in Discord.',
};

// discordOutcome turns the outcome Discord returned with into a message.
export function discordOutcome(page: DiscordPage, outcome: string | undefined): DiscordOutcome {
  if (!outcome || page === 'login' && outcome === 'signed_in') return null;
  if (page === 'account' && outcome === 'linked') return { kind: 'success', message: 'Discord account linked.' };
  const messages = page === 'login' ? loginMessages : accountMessages;
  return { kind: 'error', message: messages[outcome] ?? (page === 'login' ? 'Discord sign-in failed. Try again.' : 'Linking Discord failed. Try again.') };
}

// discordRedirectHint explains why the redirect address will not work.
export function discordRedirectHint(problem: string | null | undefined): string | null {
  if (problem === 'missing') return 'Set App Base URL in General settings first; the address is built from it.';
  if (problem === 'not_https') return 'Discord only accepts an address starting with https:// (or one on this computer). Set an https:// App Base URL in General settings.';
  return null;
}

// What the Discord settings page edits.
export type DiscordSettingsValues = {
  enable_oauth: boolean; client_id: string; client_secret: string; server_invite_url: string; guild_id: string;
  default_require_discord_auth: boolean; default_require_discord_guild_membership: boolean; sign_in_enabled: boolean; sign_in_admins: boolean;
};

// discordSettingsPayload is the save body: the bot stays off, requiring
// membership implies requiring sign-in, and everything that needs Discord is
// off while Discord is off.
export function discordSettingsPayload(v: DiscordSettingsValues, revision: number) {
  const on = v.enable_oauth;
  const guild = on && v.default_require_discord_guild_membership;
  const signIn = on && v.sign_in_enabled;
  return {
    revision, enable_oauth: on, client_id: v.client_id.trim(), client_secret: v.client_secret, server_invite_url: v.server_invite_url.trim(), guild_id: v.guild_id.trim(),
    default_require_discord_auth: on && (v.default_require_discord_auth || guild), default_require_discord_guild_membership: guild,
    sign_in_enabled: signIn, sign_in_admins: signIn && v.sign_in_admins,
    enable_bot: false, enable_membership_requirement: false, whitelist_sharers: false, bot_token: '', monitored_role_id: '', thread_channel_id: '', bot_log_channel_id: '', oauth_auth_url: '', redirect_uri_admin: '',
  };
}
