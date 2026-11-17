import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFrontend } from './frontendLoader.mjs';

// Linking a Discord account on the account page and signing in with it
// (DISCORD_SIGN_IN_DESIGN.md). Answers are checked before use, a start goes
// only to Discord's own authorize page, and every outcome MUM returns with
// reads as plain words.
const load = () => loadFrontend("export * from './src/lib/discordSignIn';export {setAccessToken} from './src/store/authStore';export {parseSignInMethods} from './src/lib/serviceSignIn';");
const authorize = 'https://discord.com/oauth2/authorize?response_type=code&client_id=1&scope=identify&state=s&redirect_uri=x';

test('discord sign-in adapter', async t => {
  const before = { fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = { location: { origin: 'http://mum.test' } };

  await t.test('reads what the account page offers', async () => {
    const m = await load(); m.setAccessToken('session');
    let path;
    globalThis.fetch = async req => { path = new URL(req.url).pathname; return Response.json({ data: { available: true, linked: true, username: 'discord_viewer', sign_in: false } }); };
    assert.deepEqual(await m.getAccountDiscord(), { available: true, linked: true, username: 'discord_viewer', signIn: false });
    assert.equal(path, '/api/account/discord');
    for (const bad of [{ available: 'yes', linked: false, username: null, sign_in: false }, { available: true, linked: true, username: null, sign_in: false }, { available: true, linked: false, username: 5, sign_in: false }]) {
      globalThis.fetch = async () => Response.json({ data: bad });
      await assert.rejects(m.getAccountDiscord(), /Unexpected/);
    }
  });

  await t.test('starts sign-in and linking with one request each, only towards Discord', async () => {
    const m = await load(); m.setAccessToken('session');
    const calls = [];
    globalThis.fetch = async req => { calls.push([req.method, new URL(req.url).pathname, await req.text()]); return Response.json({ data: { redirect_url: authorize, expires_at: '2026-11-16T00:10:00Z' } }, { status: 201 }); };
    assert.equal(await m.startDiscordSignIn(true), authorize);
    assert.equal(await m.startDiscordLink(), authorize);
    assert.deepEqual(calls, [['POST', '/api/auth/discord', '{"remember":true}'], ['POST', '/api/account/discord', '{}']]);
    for (const url of ['https://evil.example/oauth2/authorize?x', 'http://discord.com/oauth2/authorize?x', 'https://discord.com.evil.example/oauth2/authorize']) {
      globalThis.fetch = async () => Response.json({ data: { redirect_url: url } }, { status: 201 });
      await assert.rejects(m.startDiscordSignIn(false), /Unexpected/, url);
    }
  });

  await t.test('unlinks with one request', async () => {
    const m = await load(); m.setAccessToken('session');
    const calls = [];
    globalThis.fetch = async req => { calls.push(req.method + ' ' + new URL(req.url).pathname); return Response.json({ data: { linked: false } }); };
    await m.unlinkDiscord();
    assert.deepEqual(calls, ['DELETE /api/account/discord']);
  });

  await t.test('explains every outcome in plain words', async () => {
    const m = await load();
    assert.equal(m.discordOutcome('login', 'signed_in'), null);
    assert.equal(m.discordOutcome('account', 'linked').kind, 'success');
    for (const outcome of ['not_linked', 'password_required', 'turned_off', 'denied', 'failed', 'not_allowed']) {
      const r = m.discordOutcome('login', outcome);
      assert.equal(r.kind, 'error', outcome);
      assert.doesNotMatch(r.message, /_|undefined/, outcome);
    }
    for (const outcome of ['in_use', 'denied', 'failed']) assert.equal(m.discordOutcome('account', outcome).kind, 'error', outcome);
    assert.match(m.discordOutcome('login', 'not_linked').message, /account page/);
    assert.equal(m.discordOutcome('login', 'something-else').kind, 'error');
    assert.equal(m.discordOutcome('login', undefined), null);
  });

  await t.test('the login page learns whether Discord sign-in is on', async () => {
    const m = await load();
    assert.equal(m.parseSignInMethods({ service_sign_in: false, plex: false, servers: [], discord: true }).discord, true);
    assert.throws(() => m.parseSignInMethods({ service_sign_in: false, plex: false, servers: [], discord: 'yes' }), /Unexpected/);
  });

  await t.test('says what is wrong with the redirect address', async () => {
    const m = await load();
    assert.equal(m.discordRedirectHint(null), null);
    assert.match(m.discordRedirectHint('missing'), /App Base URL/);
    assert.match(m.discordRedirectHint('not_https'), /https/);
  });
});

// render flattens a React element tree into text, calling function components.
const renderer = `export function render(e){if(e==null||e===false||e===true)return '';if(typeof e!=='object')return String(e);if(Array.isArray(e))return e.map(render).join('');if(typeof e.type==='function')return render(e.type(e.props));const p=e.props??{};if(typeof e.type==='symbol')return render(p.children);return '<'+e.type+(p.disabled?' disabled':'')+'>'+render(p.children)+'</'+e.type+'>';}`;
const uiMock = `export const Card='div',CardContent='div',CardHeader='div',CardTitle='div',CardDescription='div',Button='button',Checkbox='input',Alert='div',AlertDescription='div',Spinner='i';export const FontAwesomeIcon='i';`;

test('the account card links, explains and guards unlinking', async () => {
  const m = await loadFrontend(`export {DiscordLinkFields} from './src/components/users/DiscordLinkCard';${renderer}`, { mock: { filter: s => /components\/ui|ui\/|@fortawesome\/react-fontawesome|contexts|@tanstack\/react-router|lib\/discordSignIn/.test(s), module: s =>
    /contexts/.test(s) ? `export const useAuth=()=>({});export const useAlerts=()=>({});` : /react-router/.test(s) ? `export const useNavigate=()=>()=>{};export const useSearch=()=>({});` : /discordSignIn/.test(s) ? `export const discordOutcome=()=>null;export const getAccountDiscord=async()=>({});export const startDiscordLink=async()=>'';export const unlinkDiscord=async()=>{};` : uiMock } });
  const html = (info, acknowledged = false) => m.render(m.DiscordLinkFields({ info, busy: false, unlinkAcknowledged: acknowledged, onAcknowledge() {}, onLink() {}, onUnlink() {} }));
  assert.match(html({ available: false, linked: false, username: null, signIn: false }), /administrator must set up Discord/);
  const unlinked = html({ available: true, linked: false, username: null, signIn: false });
  assert.match(unlinked, /<button>.*Link Discord Account<\/button>/);
  const linked = html({ available: true, linked: true, username: 'discord_viewer', signIn: true });
  assert.match(linked, /Linked Discord account: discord_viewer\. You can use Sign in with Discord/);
  assert.match(linked, /<button disabled>Unlink Discord Account<\/button>/, 'unlinking waits for the confirmation');
  assert.match(html({ available: true, linked: true, username: 'discord_viewer', signIn: false }, true), /<button>Unlink Discord Account<\/button>/);
  assert.doesNotMatch(html({ available: true, linked: true, username: 'discord_viewer', signIn: false }), /Sign in with Discord on the sign-in page/);
});

test('the settings page saves only what MUM supports, in a form the server accepts', async () => {
  const m = await load();
  const values = { enable_oauth: true, client_id: ' 123456789012345678 ', client_secret: '', server_invite_url: ' https://discord.gg/fixture ', guild_id: '',
    default_require_discord_auth: false, default_require_discord_guild_membership: true, sign_in_enabled: false, sign_in_admins: true };
  const body = m.discordSettingsPayload(values, 4);
  assert.deepEqual(body, { revision: 4, enable_oauth: true, client_id: '123456789012345678', client_secret: '', server_invite_url: 'https://discord.gg/fixture', guild_id: '',
    default_require_discord_auth: true, default_require_discord_guild_membership: true, sign_in_enabled: false, sign_in_admins: false,
    enable_bot: false, enable_membership_requirement: false, whitelist_sharers: false, bot_token: '', monitored_role_id: '', thread_channel_id: '', bot_log_channel_id: '', oauth_auth_url: '', redirect_uri_admin: '' });
  // Turning Discord off turns off what depends on it.
  const off = m.discordSettingsPayload({ ...values, enable_oauth: false, sign_in_enabled: true }, 4);
  assert.equal(off.default_require_discord_auth, false);
  assert.equal(off.default_require_discord_guild_membership, false);
  assert.equal(off.sign_in_enabled, false);
});
