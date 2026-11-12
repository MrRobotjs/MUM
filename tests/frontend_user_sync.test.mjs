import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

const load = () => loadFrontend("export * from './src/lib/userSync';");
const summary = (overrides = {}) => ({ total_servers: 1, successful: 1, failed: 0, total_added: 0, total_updated: 0, total_removed: 0, ...overrides });

test('user sync results', async t => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: 'http://mum.test' } };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.window = previousWindow; });

  await t.test('a sync that found nothing to change says so', async () => {
    const m = await load();
    assert.deepEqual(m.userSyncNotices([], summary()), [{ ok: true, text: 'Synced 1 server: no changes needed' }]);
    assert.deepEqual(m.userSyncNotices([], summary({ total_servers: 2, successful: 2, total_added: 1, total_updated: 3 })), [{ ok: true, text: 'Synced 2 servers: 1 added, 3 updated, 0 removed' }]);
  });

  await t.test('failed servers are reported individually', async () => {
    const m = await load();
    const results = [
      { server_id: 1, server_name: 'Plex', service_type: 'plex', success: true, added: 0, updated: 0, removed: 0 },
      { server_id: 2, server_name: 'Books', service_type: 'kavita', success: false, message: 'Synchronization failed; previous snapshot retained' },
    ];
    assert.deepEqual(m.userSyncNotices(results, summary({ total_servers: 2, failed: 1 })), [
      { ok: false, text: 'Sync completed with errors: 1/2 servers successful (no changes needed)' },
      { ok: false, text: 'Sync failed for Books: Synchronization failed; previous snapshot retained' },
    ]);
  });

  await t.test('requests read the results inside the data envelope', async () => {
    const m = await load();
    const calls = [];
    globalThis.fetch = async request => {
      const path = new URL(request.url).pathname;
      calls.push([request.method, path]);
      if (path === '/api/users/sync-all') return Response.json({ data: { results: [], summary: summary({ total_updated: 2 }) } });
      return Response.json({ data: { server_id: 4, scope: 'users', added: 0, updated: 1, removed: 0, users: 3 } });
    };
    assert.equal((await m.syncAllUsers()).summary.total_updated, 2);
    const counts = await m.syncServerUsers(4);
    assert.equal(m.userSyncChanges(counts), '0 added, 1 updated, 0 removed');
    assert.deepEqual(calls, [['POST', '/api/users/sync-all'], ['POST', '/api/servers/4/sync-users']]);
  });
});
