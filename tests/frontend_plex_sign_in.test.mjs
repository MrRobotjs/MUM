import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const URL_OK = 'https://app.plex.tv/auth#?clientID=1b4e28ba-2fa1-41d2-883f-0016d3cca427&code=abcdefghijklmnop1234&context%5Bdevice%5D%5Bproduct%5D=MUM';

test('Plex sign-in adapter', async t => {
  const before = { fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = { location: { origin: 'http://mum.test' } };
  const m = await loadFrontend("export { startPlexSignIn, checkPlexSignIn } from './src/lib/plexSignIn';");

  await t.test('starts with the remember choice and only accepts a Plex approval page', async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => { const req = new Request(input, init); calls.push({ path: new URL(req.url).pathname, body: await req.text() }); return Response.json({ data: { id: ID, status: 'pending', expires_at: '2026-11-13T10:00:00Z', authorization_url: URL_OK } }, { status: 201 }); };
    const started = await m.startPlexSignIn(true);
    assert.deepEqual(calls, [{ path: '/api/auth/plex', body: '{"remember":true}' }]);
    assert.equal(started.id, ID);
    globalThis.fetch = async () => Response.json({ data: { id: ID, status: 'pending', expires_at: '2026-11-13T10:00:00Z', authorization_url: 'https://evil.example/auth#?code=x' } }, { status: 201 });
    await assert.rejects(m.startPlexSignIn(false), /Invalid Plex authorization destination/);
  });

  await t.test('checks until Plex approves, then returns the session token', async () => {
    const paths = [];
    let answer = { data: { id: ID, status: 'pending' } };
    globalThis.fetch = async (input, init) => { paths.push(new URL(new Request(input, init).url).pathname); return Response.json(answer); };
    assert.deepEqual(await m.checkPlexSignIn(ID), { status: 'pending' });
    answer = { data: { id: ID, status: 'signed_in', access_token: 'a'.repeat(43) } };
    assert.deepEqual(await m.checkPlexSignIn(ID), { status: 'signed_in', accessToken: 'a'.repeat(43) });
    assert.deepEqual(paths, [`/api/auth/plex/${ID}/poll`, `/api/auth/plex/${ID}/poll`]);
    answer = { data: { id: 'another', status: 'signed_in', access_token: 'a'.repeat(43) } };
    await assert.rejects(m.checkPlexSignIn(ID), /unexpected answer/);
  });

  await t.test('an unlinked Plex account is reported with the server message', async () => {
    globalThis.fetch = async () => Response.json({ error: { code: 'PLEX_ACCOUNT_NOT_LINKED', message: 'This Plex account is not linked to a MUM account.' } }, { status: 403 });
    await assert.rejects(m.checkPlexSignIn(ID), /not linked to a MUM account/);
  });
});
