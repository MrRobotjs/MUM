import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFrontend } from './frontendLoader.mjs';

const loadModule = () => loadFrontend("export * from './src/lib/invitationWizard'");
const token = 'A'.repeat(43);
const invitation = (extra = {}) => ({
  id: 1, revision: 1, expires_at: null, max_uses: 2, current_uses: 0, reserved_uses: 0,
  servers: [{ id: 11, name: 'Living Room', provider: 'jellyfin', access_url: '', libraries: [{ id: 'movies', name: 'Movies' }] }],
  grants: [{ server_id: 11, all_libraries: true, library_ids: [], allow_downloads: false }],
  discord: { required: false, requires_guild: false, available: false, invite_url: null },
  ...extra,
});
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('the wizard learns whether invitees sign in with their server login', async t => {
  const before = globalThis.fetch;
  t.after(() => { globalThis.fetch = before; });
  const { loadPublicInvitation } = await loadModule();
  for (const [flag, expected] of [[true, true], [false, false], [undefined, false]]) {
    globalThis.fetch = async () => Response.json({ data: invitation(flag === undefined ? {} : { service_sign_in: flag }) });
    const view = (await loadPublicInvitation(token, storage())).view();
    assert.equal(view.meta.service_sign_in, expected);
  }
  globalThis.fetch = async () => Response.json({ data: invitation({ service_sign_in: 'yes' }) });
  await assert.rejects(loadPublicInvitation(token, storage()), /Invalid invitation/);
});

test('server sign-in names the servers to sign in with', async () => {
  const { serviceSignInNotice } = await loadModule();
  assert.equal(serviceSignInNotice([{ name: 'Living Room' }]), 'Sign in to MUM with your Living Room login.');
  assert.equal(serviceSignInNotice([{ name: 'Living Room' }, { name: 'Books' }]), 'Sign in to MUM with your Living Room or Books login.');
  assert.equal(serviceSignInNotice([{ name: 'A' }, { name: 'B' }, { name: 'C' }]), 'Sign in to MUM with your A, B or C login.');
  assert.equal(serviceSignInNotice([]), '');
});
