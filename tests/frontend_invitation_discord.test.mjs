import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
async function loadModule() {
  
  return loadFrontend("export * from './src/lib/invitationWizard'");
}
const token = 'a'.repeat(43);
const proofID = '12345678-1234-1234-1234-123456789abc';
const invitation = (discord = { required: true, requires_guild: true, available: true, invite_url: 'https://discord.gg/fixture' }) => ({
  id: 1, revision: 3, expires_at: '2026-12-01T00:00:00Z', max_uses: 2, current_uses: 0, reserved_uses: 0,
  servers: [{ id: 11, name: 'First', provider: 'jellyfin', access_url: '', libraries: [{ id: 'movies', name: 'Movies' }] }],
  grants: [{ server_id: 11, all_libraries: false, library_ids: ['movies'], allow_downloads: false }],
  discord,
});
const verified = (extra = {}) => ({ authorization_id: proofID, status: 'verified', error_code: null, user: { id: '333456789012345678', username: 'discord_viewer', avatar: null }, guild_verified: true, invite_url: 'https://discord.gg/fixture', ...extra });
const account = { username: 'Local User', email: '', password: 'private-profile-password', confirm_password: 'private-profile-password', use_same_username: true, use_same_email: true, use_same_password: true };
const storage = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }; };
const receipt = { id: 'job', status: 'completed', requires_review: false, steps: [{ server_id: 11, status: 'completed', stage: 'finished' }] };

function route(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, 'http://mum.test').pathname.replace(`/api/public/invitations/${token}`, '') || '/';
    calls.push({ path, method: init.method ?? 'GET', credentials: init.credentials, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = handlers[`${init.method ?? 'GET'} ${path}`];
    if (!handler) return Response.json({ error: { code: 'NOT_FOUND', message: 'missing' } }, { status: 404 });
    return handler();
  };
  return calls;
}

test('Discord-gated invitation wizard', async t => {
  const before = globalThis.fetch;
  t.after(() => { globalThis.fetch = before; });
  const { loadPublicInvitation } = await loadModule();

  await t.test('a required Discord step comes first and status is read with the binding cookie', async () => {
    const calls = route({ 'GET /': () => Response.json({ data: invitation() }) });
    const draft = await loadPublicInvitation(token, storage());
    const view = draft.view();
    assert.equal(view.steps[0].id, 'discord');
    assert.equal(view.steps[0].completed, false);
    assert.equal(view.discord.oauth_enabled, true);
    assert.equal(view.discord.requires_guild, true);
    assert.equal(view.invite.require_discord_auth, true);
    const status = calls.find(c => c.path === '/discord-authorization');
    assert.equal(status.credentials, 'same-origin');
    assert.equal(calls.find(c => c.path === '/').credentials, 'omit');
  });

  await t.test('starting sends the current revision and accepts only Discord authorize URLs', async () => {
    for (const [redirect, ok] of [['https://discord.com/oauth2/authorize?client_id=1&state=s', true], ['https://evil.invalid/oauth2/authorize?state=s', false], ['http://discord.com/oauth2/authorize?state=s', false], ['https://discord.com/oauth2/authorize', false]]) {
      const calls = route({ 'GET /': () => Response.json({ data: invitation() }), 'POST /discord-authorizations': () => Response.json({ data: { authorization_id: proofID, redirect_url: redirect } }, { status: 201 }) });
      const draft = await loadPublicInvitation(token, storage());
      if (ok) assert.equal(await draft.startDiscord(), redirect);
      else await assert.rejects(draft.startDiscord(), /Invalid Discord sign-in address/);
      const start = calls.find(c => c.path === '/discord-authorizations');
      assert.deepEqual(start.body, { invitation_revision: 3 });
      assert.equal(start.credentials, 'same-origin');
    }
  });

  await t.test('a verified proof completes the step and is bound to redemption', async () => {
    const calls = route({ 'GET /': () => Response.json({ data: invitation() }), 'GET /discord-authorization': () => Response.json({ data: verified() }), 'POST /redeem': () => Response.json({ data: receipt }, { status: 201 }) });
    const draft = await loadPublicInvitation(token, storage());
    const view = draft.view();
    assert.equal(view.steps[0].completed, true);
    assert.equal(view.discord.user.username, 'discord_viewer');
    draft.saveAccount(account);
    await draft.redeem();
    const redeem = calls.find(c => c.path === '/redeem');
    assert.equal(redeem.body.discord_authorization_id, proofID);
    assert.equal(redeem.credentials, 'same-origin');
  });

  await t.test('failed, expired or guild-less proofs keep the step incomplete with a fixed message', async () => {
    for (const [proof, message] of [[{ ...verified(), status: 'failed', user: null, guild_verified: null, error_code: 'DISCORD_GUILD_REQUIRED' }, /Join the required Discord server/], [{ ...verified(), status: 'expired', user: null }, /expired/], [{ ...verified(), status: 'failed', user: null, error_code: 'SOMETHING_ELSE' }, /failed/]]) {
      route({ 'GET /': () => Response.json({ data: invitation() }), 'GET /discord-authorization': () => Response.json({ data: proof }) });
      const view = (await loadPublicInvitation(token, storage())).view();
      assert.equal(view.steps[0].completed, false);
      assert.match(view.discord.guild_error, message);
    }
    route({ 'GET /': () => Response.json({ data: invitation() }), 'GET /discord-authorization': () => Response.json({ data: verified({ guild_verified: false }) }) });
    assert.equal((await loadPublicInvitation(token, storage())).view().steps[0].completed, false);
  });

  await t.test('malformed requirements or proof records fail closed', async () => {
    // 'missing' omits the block entirely (a default parameter would restore it).
    for (const discord of [{ required: false, requires_guild: true, available: false, invite_url: null }, { required: true, requires_guild: false, available: true, invite_url: 'https://evil.invalid/x' }, 'missing']) {
      const data = discord === 'missing' ? (({ discord: _omitted, ...rest }) => rest)(invitation()) : invitation(discord);
      route({ 'GET /': () => Response.json({ data }) });
      await assert.rejects(loadPublicInvitation(token, storage()), /Invalid invitation Discord requirement/);
    }
    for (const proof of [verified({ user: null }), { ...verified(), status: 'failed' }, verified({ user: { id: '1', username: 'x', avatar: null } }), verified({ error_code: 'lower' })]) {
      route({ 'GET /': () => Response.json({ data: invitation() }), 'GET /discord-authorization': () => Response.json({ data: proof }) });
      await assert.rejects(loadPublicInvitation(token, storage()), /Invalid Discord sign-in status/);
    }
  });

  await t.test('ungated invitations never read Discord state or send cookies', async () => {
    const calls = route({ 'GET /': () => Response.json({ data: invitation({ required: false, requires_guild: false, available: false, invite_url: null }) }), 'POST /redeem': () => Response.json({ data: receipt }, { status: 201 }) });
    const draft = await loadPublicInvitation(token, storage());
    assert.equal(draft.view().steps[0].id, 'user_account');
    await assert.rejects(draft.startDiscord(), /not available/);
    draft.saveAccount(account);
    await draft.redeem();
    const redeem = calls.find(c => c.path === '/redeem');
    assert.equal('discord_authorization_id' in redeem.body, false);
    assert.equal(redeem.credentials, 'omit');
    assert.equal(calls.some(c => c.path.startsWith('/discord')), false);
  });

  await t.test('a Discord refusal before reservation releases the frozen attempt', async () => {
    let redeemed = 0;
    route({ 'GET /': () => Response.json({ data: invitation() }), 'GET /discord-authorization': () => Response.json({ data: verified() }), 'POST /redeem': () => { redeemed++; return Response.json({ error: { code: 'DISCORD_ACCOUNT_IN_USE', message: 'in use' } }, { status: 400 }); } });
    const draft = await loadPublicInvitation(token, storage());
    draft.saveAccount(account);
    await assert.rejects(draft.redeem(), /in use/);
    // Not reserved: the account can be edited and resubmitted.
    draft.saveAccount({ ...account, username: 'Another User' });
    assert.equal(redeemed, 1);
  });
});
