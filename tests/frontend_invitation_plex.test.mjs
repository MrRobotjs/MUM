import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function loadModule() {
  const result = await build({ stdin: { contents: "export * from './src/lib/invitationWizard'", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
// A Plex server plus a Jellyfin server, as the Flask invite wizard supported.
const invitation = () => ({
  id: 1, revision: 1, expires_at: '2026-12-01T00:00:00Z', max_uses: 2, current_uses: 0, reserved_uses: 0,
  servers: [
    { id: 13, name: 'Plex++', provider: 'plex', access_url: '', libraries: [{ id: '1', name: 'Movies' }] },
    { id: 11, name: 'First', provider: 'jellyfin', access_url: '', libraries: [{ id: 'movies', name: 'Movies' }] },
  ],
  grants: [
    { server_id: 13, all_libraries: false, library_ids: ['1'], allow_downloads: false },
    { server_id: 11, all_libraries: false, library_ids: ['movies'], allow_downloads: false },
  ],
  discord: { required: false, requires_guild: false, available: false, invite_url: null },
});
const proofID = '11111111-2222-4333-8444-555555555555';
const account = { username: 'Local User', email: 'recipient@example.invalid', password: 'private-profile-password', confirm_password: 'private-profile-password', use_same_username: true, use_same_email: true, use_same_password: true };
const storage = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }; };

test('Plex invitation sign-in in the wizard', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  const respond = (data, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
  const setup = async routes => {
    const m = await loadModule();
    globalThis.fetch = async (url, init) => {
      const path = new URL(url, 'http://mum.test').pathname.replace('/api/public/invitations/invite-token', '');
      const body = init?.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body, credentials: init?.credentials, method: init?.method });
      return routes(path, body);
    };
    const draft = await m.loadPublicInvitation('invite-token', storage());
    return { m, draft };
  };

  await t.test('the Plex server is one sign-in step, not a credentials form', async () => {
    const { draft } = await setup(() => respond(invitation()));
    const view = draft.view();
    assert.equal(view.plex.has_plex_servers, true);
    assert.equal(view.plex.authenticated, false);
    assert.deepEqual(view.steps.map(s => s.id), ['user_account', 'plex', 'server_access_11']);
    assert.equal(view.steps.find(s => s.id === 'plex').name, 'Plex++ Access');
    draft.saveAccount(account);
    assert.equal(draft.view().servers.find(s => s.id === 13).credentials, null);
  });

  await t.test('sign-in opens only Plex, then polling confirms the verified account', async () => {
    let polls = 0;
    const { draft } = await setup((path, body) => {
      if (path === '') return respond(invitation());
      if (path === '/plex-authorizations') return respond({ id: proofID, status: 'pending', expires_at: '2026-12-01T00:00:00Z', revision: 2, invitation_revision: 1, authorization_url: 'https://app.plex.tv/auth#?code=abc&clientID=mum' }, 201);
      if (path === `/plex-authorizations/${proofID}/poll`) {
        polls++;
        return respond(polls === 1 ? { id: proofID, status: 'pending', revision: 3 } : { id: proofID, status: 'verified', revision: 4, account: { id: '2', username: 'reader' } });
      }
      if (path === `/plex-authorizations/${proofID}/confirm`) {
        assert.deepEqual(body, { invitation_revision: 1, expected_account_id: '2' });
        return respond({ id: proofID, status: 'confirmed', revision: 5, account: { id: '2', username: 'reader' } });
      }
      throw new Error('unexpected ' + path);
    });
    assert.equal(await draft.startPlex(), 'https://app.plex.tv/auth#?code=abc&clientID=mum');
    assert.equal(await draft.pollPlex(), 'pending');
    assert.equal(await draft.pollPlex(), 'confirmed');
    const view = draft.view();
    assert.equal(view.plex.authenticated, true);
    assert.equal(view.plex.user.username, 'reader');
    assert.equal(view.steps.find(s => s.id === 'plex').completed, true);
    assert.ok(requests.filter(r => r.path.startsWith('/plex-authorizations')).every(r => r.credentials === 'same-origin'), 'sign-in requests must send the browser-binding cookie');
  });

  await t.test('a sign-in address other than app.plex.tv is refused', async () => {
    for (const bad of ['https://evil.example/auth#?code=x', 'http://app.plex.tv/auth#?code=x', 'https://app.plex.tv.evil.example/auth']) {
      const { draft } = await setup(path => path === '' ? respond(invitation()) : respond({ id: proofID, status: 'pending', authorization_url: bad }, 201));
      await assert.rejects(draft.startPlex(), /Invalid Plex sign-in address/);
    }
  });

  await t.test('redeeming sends the Plex sign-in and no Plex password', async () => {
    const { draft } = await setup((path, body) => {
      if (path === '') return respond(invitation());
      if (path === '/plex-authorizations') return respond({ id: proofID, status: 'pending', authorization_url: 'https://app.plex.tv/auth#?code=abc' }, 201);
      if (path.endsWith('/poll')) return respond({ id: proofID, status: 'verified', account: { id: '2', username: 'reader' } });
      if (path.endsWith('/confirm')) return respond({ id: proofID, status: 'confirmed', account: { id: '2', username: 'reader' } });
      if (path === '/redeem') {
        assert.equal(body.plex_authorization_id, proofID);
        assert.deepEqual(body.server_credentials.map(c => c.server_id), [11]);
        return respond({ id: 'job', status: 'completed', requires_review: false, steps: [13, 11].map(server_id => ({ server_id, status: 'completed', stage: 'completed' })) }, 201);
      }
      throw new Error('unexpected ' + path);
    });
    draft.saveAccount(account);
    await assert.rejects(draft.redeem(), /Complete your account/);
    await draft.startPlex();
    await draft.pollPlex();
    const receipt = await draft.redeem();
    assert.equal(receipt.status, 'completed');
    assert.equal(requests.find(r => r.path === '/redeem').credentials, 'same-origin');
  });

  await t.test('a sign-in status that does not match its account is rejected', async () => {
    const { draft } = await setup(path => {
      if (path === '') return respond(invitation());
      if (path === '/plex-authorizations') return respond({ id: proofID, status: 'pending', authorization_url: 'https://app.plex.tv/auth#?code=abc' }, 201);
      return respond({ id: proofID, status: 'verified', account: null });
    });
    await draft.startPlex();
    await assert.rejects(draft.pollPlex(), /Invalid Plex sign-in status/);
  });
});

test('Plex can be saved in an invitation with selected or all libraries', async () => {
  const result = await build({ stdin: { contents: "export * from './src/lib/invitationConstraints'", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const m = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
  assert.equal(m.invitationServerLimits('plex').allLibraries, true);
  assert.equal(m.invitationServerLimits('PLEX').allLibraries, true);
});
