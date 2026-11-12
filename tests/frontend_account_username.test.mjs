import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function load() {
  const result = await build({ stdin: { contents: "export * from './src/lib/accountUsername';export {setAccessToken,getAccessToken} from './src/store/authStore';", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
const user = '12345678-1234-1234-1234-123456789abc', other = '87654321-1234-1234-1234-123456789abc';
const state = (revision = 1) => ({ user_uuid: user, username: 'owner', profile_revision: revision, username_change_available: true, initial_credentials_available: false });
const input = () => ({ username: 'renamed', current_password: 'fixture-private-password', acknowledge_revoke_sessions: true });
const success = () => ({ user_uuid: user, username: 'renamed', profile_revision: 2, sessions_revoked: true, reauthentication_required: true });

test('own username adapter guards and session outcomes', async t => {
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window;
  t.after(() => { globalThis.fetch = previousFetch; globalThis.window = previousWindow; });
  const reset = () => { globalThis.window = { location: { origin: 'http://mum.test' } }; };
  await t.test('projects concrete own capabilities and keeps initial credentials unavailable', async () => {
    const a = await load();
    assert.deepEqual(a.usernameRecord({ ...state(), secret: 'private' }, user), state());
    for (const invalid of [{ ...state(), user_uuid: other }, state(0), { ...state(), username_change_available: 'yes' }, { ...state(), initial_credentials_available: true }, { ...state(), username: '' }]) assert.throws(() => a.usernameRecord(invalid, user));
  });
  await t.test('validates ASCII limits, password bytes, exact name and revocation consent', async () => {
    const a = await load();
    assert.equal(a.usernameChangePayload(state(), { ...input(), username: ' renamed ' }).username, 'renamed');
    assert.equal(a.usernameChangePayload(state(), { ...input(), username: 'OWNER' }).username, 'OWNER');
    for (const values of [{ username: '' }, { username: 'é' }, { username: 'line\nname' }, { username: 'a'.repeat(256) }, { username: 'owner' }, { current_password: 'short' }, { current_password: 'é'.repeat(513) }, { acknowledge_revoke_sessions: false }]) assert.throws(() => a.usernameChangePayload(state(), { ...input(), ...values }));
  });
  await t.test('one revision-bound PATCH then clears current authentication on confirmed revocation', async () => {
    reset(); const a = await load(); a.setAccessToken('session'); let calls = 0;
    globalThis.fetch = async r => { calls++; assert.equal(new URL(r.url).pathname, '/api/account/username'); if (r.method === 'GET') return Response.json({ data: state() }); assert.equal(r.method, 'PATCH'); assert.deepEqual(await r.json(), { expected_user_uuid: user, profile_revision: 1, ...input() }); return Response.json({ data: success() }); };
    assert.deepEqual(await a.changeOwnUsername(state(), input()), success()); assert.equal(calls, 2); assert.equal(a.getAccessToken(), null);
  });
  await t.test('stale, foreign, unavailable and token-switched preflights send no mutation', async () => {
    for (const mode of ['stale', 'foreign', 'unavailable', 'token', '401']) {
      reset(); const a = await load(); a.setAccessToken('session'); let calls = 0;
      globalThis.fetch = async r => { calls++; assert.equal(r.method, 'GET'); if (mode === 'token') a.setAccessToken('newer'); return mode === '401' ? Response.json({ error: {} }, { status: 401 }) : Response.json({ data: mode === 'stale' ? state(2) : mode === 'foreign' ? { ...state(), user_uuid: other } : mode === 'unavailable' ? { ...state(), username_change_available: false } : state() }); };
      await assert.rejects(a.changeOwnUsername(state(), input()), /Refresh/); assert.equal(calls, 1); assert.equal(a.getAccessToken(), mode === 'token' ? 'newer' : 'session');
    }
  });
  await t.test('known rejected writes keep authentication and never replay', async () => {
    for (const status of [400, 403, 409]) {
      reset(); const a = await load(); a.setAccessToken('session'); let patches = 0;
      globalThis.fetch = async r => { if (r.method === 'GET') return Response.json({ data: state() }); patches++; return Response.json({ error: { code: status === 403 ? 'CURRENT_PASSWORD_INVALID' : 'CONFLICT' } }, { status }); };
      await assert.rejects(a.changeOwnUsername(state(), input())); assert.equal(patches, 1); assert.equal(a.getAccessToken(), 'session');
    }
  });
  await t.test('uncertain/401/forbidden/malformed results clear only the old session without replay', async () => {
    for (const mode of ['lost', '401', '403', '500', 'malformed']) {
      reset(); const a = await load(); a.setAccessToken('session'); let patches = 0;
      globalThis.fetch = async r => { if (r.method === 'GET') return Response.json({ data: state() }); patches++; if (mode === 'lost') throw Error('private network details'); return mode === 'malformed' ? Response.json({ data: { ...success(), profile_revision: 9 } }) : Response.json({ error: { code: 'FORBIDDEN' } }, { status: Number(mode) }); };
      await assert.rejects(a.changeOwnUsername(state(), input()), /No request was replayed/); assert.equal(patches, 1); assert.equal(a.getAccessToken(), null);
    }
  });
  await t.test('concurrent admission and late token rotation preserve the newer session', async () => {
    reset(); const a = await load(); a.setAccessToken('session'); let release, patches = 0;
    globalThis.fetch = async r => { if (r.method === 'GET') return Response.json({ data: state() }); patches++; await new Promise(resolve => { release = resolve; }); return Response.json({ data: success() }); };
    const first = a.changeOwnUsername(state(), input()); while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(a.changeOwnUsername(state(), input()), /pending/);
    a.setAccessToken('newer'); release(); await assert.rejects(first); assert.equal(a.getAccessToken(), 'newer'); assert.equal(patches, 1);
    globalThis.fetch = async () => Response.json({ data: state(3) });
    await assert.rejects(a.changeOwnUsername(state(), input()), /Refresh/);
  });
});
